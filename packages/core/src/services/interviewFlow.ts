import { DAY_MS, HOUR_MS } from '../clock.js';
import { ComplianceError, DomainError } from '../errors.js';
import { assertMayMoveToInterview } from '../states.js';
import { CONSENT_NOTICE_TEXT } from '../compliance/notices.js';
import type { AsrSegment, TranscriptSource } from '../ai/asr.js';
import type { ConsentRecord, Interview, InterviewChannel, TranscriptSegment } from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from './context.js';

const LOW_CONFIDENCE = 0.75;
/** PRD 3.3: after 3 minutes off topic the sidebar softly suggests returning to a probe point. */
export const OFF_TOPIC_MS = 3 * 60_000;
/** PRD 3.3: a dropped stream keeps the last 30 seconds buffered locally. */
export const STREAM_BUFFER_MS = 30_000;

export interface ConsentPrompt {
  interviewId: string;
  noticeText: string;
  presentedAt: string;
  buttons: Array<{ decision: 'granted' | 'refused'; label: string }>;
}

export class InterviewFlowService {
  constructor(private readonly ctx: ServiceContext) {}

  private require(id: string): Interview {
    const i = this.ctx.store.findInterview(id);
    if (!i) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { id });
    return i;
  }

  schedule(
    actor: Actor,
    input: {
      jobId: string;
      candidateId: string;
      interviewerIds: string[];
      scheduledAt: string;
      channel: InterviewChannel;
      round: number;
    },
  ): Interview {
    const job = this.ctx.store.findJob(input.jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在', { jobId: input.jobId });
    if (!job.confirmedStandardId) {
      throw new DomainError('standard_required', '这个岗位还没有定稿的金标准，请先到「定考察标准」把访谈走完，再来排面试', { jobId: job.id });
    }
    const candidate = this.ctx.store.findCandidate(input.candidateId);
    if (!candidate) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除', { candidateId: input.candidateId });
    if (candidate.deletedAt) throw new DomainError('candidate_deleted', '候选人已删除，不能继续排期');
    if (input.interviewerIds.length === 0) throw new DomainError('needs_interviewer', '至少需要一位面试官');

    const interview: Interview = {
      id: makeId(this.ctx, 'int'),
      orgId: job.orgId,
      jobId: job.id,
      candidateId: candidate.id,
      standardId: job.confirmedStandardId,
      interviewerIds: [...input.interviewerIds],
      channel: input.channel,
      round: input.round,
      scheduledAt: input.scheduledAt,
      startedAt: null,
      endedAt: null,
      status: 'scheduled',
      consentId: null,
      aiRecordingActive: false,
      pausedAt: null,
      prepPush24hSentAt: null,
      prepPushLastMinuteSentAt: null,
    };
    this.ctx.store.saveInterview(interview);
    this.ctx.store.saveCandidate({ ...candidate, status: 'interview' });
    recordAudit(this.ctx, actor, 'interview.schedule', 'Interview', interview.id, job.orgId, { ...input });
    return interview;
  }

  /** Standalone modal, never a footer link or a line inside the general privacy policy. */
  presentConsent(interviewId: string): ConsentPrompt {
    const i = this.require(interviewId);
    if (i.status !== 'scheduled') throw new DomainError('consent_wrong_state', '知情同意只在面试开始前呈现', { status: i.status });
    return {
      interviewId,
      noticeText: CONSENT_NOTICE_TEXT,
      presentedAt: nowIso(this.ctx),
      buttons: [
        { decision: 'granted', label: '同意 AI 协助记录' },
        { decision: 'refused', label: '不同意（仅人工笔记）' },
      ],
    };
  }

  answerConsent(actor: Actor, interviewId: string, decision: 'granted' | 'refused', presentedAt: string): ConsentRecord {
    const i = this.require(interviewId);
    if (i.consentId) throw new DomainError('consent_already_recorded', '本场面试已有知情同意记录', { consentId: i.consentId });
    const candidate = this.ctx.store.findCandidate(i.candidateId);
    if (!candidate) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除');

    const consent: ConsentRecord = {
      id: makeId(this.ctx, 'con'),
      orgId: i.orgId,
      candidateId: candidate.id,
      interviewId,
      decision,
      noticeText: CONSENT_NOTICE_TEXT,
      presentedAt,
      respondedAt: nowIso(this.ctx),
      noticeKind: 'standalone_modal',
      retentionUntil: new Date(this.ctx.clock.now().getTime() + this.ctx.retention.consentDays * DAY_MS).toISOString(),
    };
    this.ctx.store.saveConsent(consent);
    this.ctx.store.saveInterview({ ...i, consentId: consent.id, aiRecordingActive: false });
    recordAudit(this.ctx, actor, 'consent.answered', 'ConsentRecord', consent.id, i.orgId, { decision });
    return consent;
  }

  start(actor: Actor, interviewId: string): Interview {
    const i = this.require(interviewId);
    const consent = i.consentId ? this.ctx.store.findConsent(i.consentId) : undefined;
    if (!consent) {
      throw new ComplianceError('consent_required', '必须先向候选人呈现独立的知情同意弹窗并记录选择，才能开始面试记录');
    }
    assertMayMoveToInterview(i.status, 'in_progress', actor.kind, actor.kind === 'human' ? actor.role : undefined);
    const next: Interview = {
      ...i,
      status: 'in_progress',
      startedAt: nowIso(this.ctx),
      aiRecordingActive: consent.decision === 'granted',
    };
    this.ctx.store.saveInterview(next);
    recordAudit(this.ctx, actor, 'interview.start', 'Interview', interviewId, i.orgId, { aiRecordingActive: next.aiRecordingActive });
    return next;
  }

  /** 面试官可在敏感话题时暂停 AI，随时恢复。 */
  setPaused(actor: Actor, interviewId: string, paused: boolean): Interview {
    const i = this.require(interviewId);
    if (i.status !== 'in_progress') throw new DomainError('not_in_progress', '只有进行中的面试可以暂停/恢复 AI', { status: i.status });
    if (paused && !i.aiRecordingActive) throw new DomainError('recording_not_active', '当前未开启 AI 记录，无需暂停');
    const next: Interview = { ...i, pausedAt: paused ? nowIso(this.ctx) : null };
    this.ctx.store.saveInterview(next);
    recordAudit(this.ctx, actor, paused ? 'interview.pause_ai' : 'interview.resume_ai', 'Interview', interviewId, i.orgId, {});
    return next;
  }

  appendSegments(actor: Actor, interviewId: string, incoming: AsrSegment[]): { saved: TranscriptSegment[]; skippedLowConfidence: string[] } {
    const i = this.require(interviewId);
    if (i.status !== 'in_progress') throw new DomainError('not_recording', '面试不在进行中，拒绝写入转写', { status: i.status });
    if (!i.aiRecordingActive) {
      throw new ComplianceError('consent_refused_no_transcript', '候选人未同意 AI 记录，本场面试不能写入转写内容，请使用人工笔记');
    }
    if (i.pausedAt) throw new DomainError('ai_paused', 'AI 记录已暂停，恢复后才能继续写入');

    const saved: TranscriptSegment[] = [];
    const skippedLowConfidence: string[] = [];
    for (const seg of incoming) {
      const record: TranscriptSegment = {
        id: makeId(this.ctx, 'seg'),
        interviewId,
        speaker: seg.speaker,
        speakerId: seg.speaker === 'candidate' ? i.candidateId : null,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        confidence: seg.confidence,
        correctedBy: null,
      };
      this.ctx.store.saveSegment(record);
      saved.push(record);
      if (record.confidence < LOW_CONFIDENCE) skippedLowConfidence.push(record.id);
    }
    recordAudit(this.ctx, actor, 'transcript.append', 'Interview', interviewId, i.orgId, {
      count: saved.length,
      lowConfidence: skippedLowConfidence.length,
    });
    return { saved, skippedLowConfidence };
  }

  /**
   * V1's main path: the transcript comes from the meeting tool the team already uses (钉钉听记、
   * 飞书妙记、腾讯会议), usually after the call ends. Consent is still the gate; recording state is not.
   */
  importTranscript(
    actor: Actor,
    interviewId: string,
    incoming: AsrSegment[],
    source: TranscriptSource,
  ): { saved: TranscriptSegment[]; skippedLowConfidence: string[] } {
    const i = this.require(interviewId);
    if (i.status !== 'in_progress' && i.status !== 'audio_done' && i.status !== 'eval_pending') {
      throw new DomainError('import_wrong_state', '只有进行中或刚结束、还没提交面评的面试可以导入转写', { status: i.status });
    }
    const consent = i.consentId ? this.ctx.store.findConsent(i.consentId) : undefined;
    if (!consent || consent.decision !== 'granted') {
      throw new ComplianceError('consent_refused_no_transcript', '候选人未同意 AI 记录，本场面试不能导入转写内容，请使用人工笔记');
    }
    if (i.status === 'in_progress' && i.pausedAt) throw new DomainError('ai_paused', 'AI 记录已暂停，恢复后才能导入');
    if (incoming.length === 0) throw new DomainError('empty_transcript', '没有识别出任何对话，请检查粘贴的内容');
    if (!incoming.some((s) => s.speaker === 'candidate')) {
      throw new DomainError('candidate_unassigned', '还没有指定哪位发言人是候选人，草稿只引用候选人的原话');
    }

    const saved: TranscriptSegment[] = [];
    const skippedLowConfidence: string[] = [];
    for (const seg of incoming) {
      const record: TranscriptSegment = {
        id: makeId(this.ctx, 'seg'),
        interviewId,
        speaker: seg.speaker,
        speakerId: seg.speaker === 'candidate' ? i.candidateId : null,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        confidence: seg.confidence,
        correctedBy: null,
      };
      this.ctx.store.saveSegment(record);
      saved.push(record);
      if (record.confidence < LOW_CONFIDENCE) skippedLowConfidence.push(record.id);
    }
    recordAudit(this.ctx, actor, 'transcript.import', 'Interview', interviewId, i.orgId, { source, count: saved.length });
    return { saved, skippedLowConfidence };
  }

  /** 口音/识别错误时面试官可直接改原文，改动落审计。 */
  correctSegment(actor: Actor, segmentId: string, text: string): TranscriptSegment {
    const seg = this.ctx.store.findSegment(segmentId);
    if (!seg) throw new DomainError('segment_not_found', '这段转写已经找不到了');
    const next: TranscriptSegment = { ...seg, text, confidence: 1, correctedBy: actor.kind === 'human' ? actor.userId : 'system' };
    this.ctx.store.saveSegment(next);
    const orgId = this.require(seg.interviewId).orgId;
    recordAudit(this.ctx, actor, 'transcript.correct', 'TranscriptSegment', segmentId, orgId, { before: seg.text, after: text });
    return next;
  }

  finish(actor: Actor, interviewId: string): Interview {
    const i = this.require(interviewId);
    const role = actor.kind === 'human' ? actor.role : undefined;
    assertMayMoveToInterview(i.status, 'audio_done', actor.kind, role);
    const withEnd: Interview = { ...i, status: 'audio_done', endedAt: nowIso(this.ctx), pausedAt: null, aiRecordingActive: false };
    this.ctx.store.saveInterview(withEnd);

    const segments = this.ctx.store.listSegments(interviewId);
    assertMayMoveToInterview('audio_done', 'eval_pending', actor.kind, role);
    const next: Interview = { ...withEnd, status: 'eval_pending' };
    this.ctx.store.saveInterview(next);
    recordAudit(this.ctx, actor, 'interview.finish', 'Interview', interviewId, i.orgId, { segments: segments.length });
    return next;
  }

  /** HR-side recovery after a lapse: never automatic. */
  restart(actor: Actor, interviewId: string): Interview {
    const i = this.require(interviewId);
    assertMayMoveToInterview(i.status, 'eval_pending', actor.kind, actor.kind === 'human' ? actor.role : undefined);
    const next: Interview = { ...i, status: 'eval_pending' };
    this.ctx.store.saveInterview(next);
    recordAudit(this.ctx, actor, 'interview.restart', 'Interview', interviewId, i.orgId, {});
    return next;
  }

  markExpired(actor: Actor, interviewId: string): Interview {
    if (actor.kind !== 'human' || actor.role !== 'hr') throw new DomainError('hr_only', '标记失效只能由 HR 决定');
    const i = this.require(interviewId);
    assertMayMoveToInterview(i.status, 'expired', actor.kind, actor.role);
    const next: Interview = { ...i, status: 'expired' };
    this.ctx.store.saveInterview(next);
    recordAudit(this.ctx, actor, 'interview.expire', 'Interview', interviewId, i.orgId, {});
    return next;
  }

  coverage(interviewId: string): { covered: string[]; uncovered: string[]; lowConfidenceSegments: string[] } {
    const i = this.require(interviewId);
    const standard = this.ctx.store.findStandard(i.standardId);
    if (!standard) return { covered: [], uncovered: [], lowConfidenceSegments: [] };
    const segments = this.ctx.store.listSegments(interviewId);
    const text = segments.map((s) => s.text.toLowerCase()).join(' ');
    const covered: string[] = [];
    const uncovered: string[] = [];
    for (const dim of standard.dimensions) {
      const hit = dim.matchKeywords.some((k) => text.includes(k.toLowerCase())) || text.includes(dim.name.toLowerCase());
      (hit ? covered : uncovered).push(dim.id);
    }
    return {
      covered,
      uncovered,
      lowConfidenceSegments: segments.filter((s) => s.confidence < LOW_CONFIDENCE).map((s) => s.id),
    };
  }

  /** Soft, non-blocking sidebar hint when the conversation drifts. */
  offTopicHint(interviewId: string, topicSignalKeywords: string[] = []): { hint: string | null; offTopicSinceMs: number | null } {
    const i = this.require(interviewId);
    const standard = this.ctx.store.findStandard(i.standardId);
    if (!standard || i.status !== 'in_progress') return { hint: null, offTopicSinceMs: null };
    const segments = this.ctx.store.listSegments(interviewId);
    if (segments.length === 0) return { hint: null, offTopicSinceMs: null };

    const allKeywords = standard.dimensions.flatMap((d) => d.matchKeywords.map((k) => k.toLowerCase()));
    const started = Date.parse(i.startedAt ?? nowIso(this.ctx));
    let offSince: number | null = null;
    for (const seg of segments) {
      const t = seg.text.toLowerCase();
      const onTopic = allKeywords.some((k) => t.includes(k)) || topicSignalKeywords.some((k) => t.includes(k.toLowerCase()));
      if (!onTopic && seg.speaker === 'candidate') {
        if (offSince === null) offSince = seg.startMs;
      } else if (onTopic) {
        offSince = null;
      }
    }
    if (offSince === null) return { hint: null, offTopicSinceMs: null };
    const last = segments[segments.length - 1];
    const driftedMs = (last?.startMs ?? 0) - offSince;
    if (driftedMs < OFF_TOPIC_MS) return { hint: null, offTopicSinceMs: offSince };
    const target = standard.dimensions.find((d) => !this.coverage(interviewId).covered.includes(d.id));
    return {
      hint: target ? `对话已离开岗位主题约 ${Math.round(driftedMs / 60_000)} 分钟，是否回到考察点「${target.name}」？` : '对话已离开岗位主题，是否回到考察点？',
      offTopicSinceMs: offSince,
    };
  }

  /** 面试官忘记点开始：系统开始 60 秒后再次提示补开启。 */
  startPromptOverdue(interviewId: string): boolean {
    const i = this.require(interviewId);
    if (i.status !== 'scheduled') return false;
    return this.ctx.clock.now().getTime() - Date.parse(i.scheduledAt) >= 60_000;
  }

  audioRetentionCutoff(): number {
    return this.ctx.clock.now().getTime() - this.ctx.retention.audioDays * DAY_MS;
  }

  hourMs(): number {
    return HOUR_MS;
  }
}
