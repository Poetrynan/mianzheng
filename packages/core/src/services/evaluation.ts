import { HOUR_MS } from '../clock.js';
import { ComplianceError, DomainError } from '../errors.js';
import { assertTransition, CHECK_TRANSITIONS, DRAFT_TRANSITIONS, INTERVIEW_TRANSITIONS } from '../states.js';
import { EvidenceVerifier } from '../ai/evidence.js';
import { assertNoProtectedAttributes } from '../compliance/protectedAttributes.js';
import type {
  EvidenceBacked,
  EvidenceRef,
  FeedbackDraft,
  Interview,
  JobStandard,
  RejectedClaim,
  StandardDimensionCheck,
} from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from './context.js';
import { syncLedgerFromDraft } from '../agent/ledger.js';

/** A segment shorter than this or below this confidence is treated as low quality. */
const LOW_CONFIDENCE = 0.75;

export interface GenerateResult {
  draft: FeedbackDraft;
  rejectedClaims: RejectedClaim[];
}

export interface SubmitRequirement {
  ok: boolean;
  missing: string[];
}

export class EvaluationService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireInterview(interviewId: string): Interview {
    const i = this.ctx.store.findInterview(interviewId);
    if (!i) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { interviewId });
    return i;
  }

  private requireStandard(interview: Interview): JobStandard {
    const std = this.ctx.store.findStandard(interview.standardId);
    if (!std || std.status !== 'confirmed') {
      throw new ComplianceError('standard_not_confirmed', '岗位金标准未定稿，不能起草面评', { standardId: interview.standardId });
    }
    return std;
  }

  /**
   * PRD 3.4 stage 1: AI drafts per dimension, every claim carries a segment pointer.
   * The pointer is resolved against real transcript text; a claim with no backing segment
   * is dropped into rejectedClaims instead of reaching the reviewer as a score.
   */
  async generateDraft(actor: Actor, interviewId: string, interviewerId: string): Promise<GenerateResult> {
    const interview = this.requireInterview(interviewId);
    if (interview.status !== 'eval_pending' && interview.status !== 'expired') {
      throw new DomainError('wrong_state', '这场面试还没到写面评的阶段，先结束面试再来起草', { status: interview.status });
    }
    const standard = this.requireStandard(interview);
    const segments = this.ctx.store.listSegments(interviewId);
    if (segments.length === 0) {
      throw new DomainError('no_transcript', '没有转写内容，无法生成草稿，请改用人工笔记直接填写');
    }

    const verifier = new EvidenceVerifier(segments);
    const result = await this.ctx.llm.draftEvaluation({
      interviewId,
      dimensions: standard.dimensions.map((d) => ({
        id: d.id,
        name: d.name,
        positiveEvidence: d.positiveEvidence,
        redFlags: d.redFlags,
        matchKeywords: d.matchKeywords,
      })),
      segments: segments.map((s) => ({ id: s.id, startMs: s.startMs, speaker: s.speaker, text: s.text, confidence: s.confidence })),
      interviewerNotes: [],
    });

    const rejected: RejectedClaim[] = [];
    const checks: StandardDimensionCheck[] = standard.dimensions.map((dim) => {
      const aiDim = result.dimensions.find((x) => x.dimensionId === dim.id);
      const score = aiDim?.score ?? null;
      const summary = aiDim?.summary ?? '本次面试未产生与该维度相关的内容，需要人工补充判断';
      const claims: Array<{ segmentId?: string }> = (aiDim?.segmentIds ?? []).map((id) => ({ segmentId: id }));
      const { refs, rejected: why } = verifier.resolve(claims, dim.id, summary);
      rejected.push(...why);

      /** A score with no verified evidence is stripped — this is the 反幻觉 hard gate. */
      const evidenceBacked = refs.length > 0;
      const effectiveScore = score && evidenceBacked ? score : null;
      if (score && !evidenceBacked) {
        rejected.push({ dimensionId: dim.id, claim: `${summary}（AI 起评 ${score}）`, reason: 'no_evidence' });
      }

      return {
        id: makeId(this.ctx, 'chk'),
        interviewId,
        dimensionId: dim.id,
        dimensionName: dim.name,
        aiScore: effectiveScore,
        aiSummary: evidenceBacked || score === null ? summary : '（AI 结论因缺乏转写证据已被移除）',
        aiEvidence: refs,
        aiRedFlagHits: aiDim?.redFlagHits ?? [],
        needsHumanInput: !evidenceBacked || (aiDim?.needsHumanInput ?? false),
        finalScore: null,
        finalSummary: null,
        finalEvidence: [],
        revisedBy: [],
        status: 'auto_filled',
      };
    });

    const resolveBacked = (items: Array<{ text: string; segmentIds: string[] }>): EvidenceBacked[] =>
      items
        .map((item) => {
          const { refs } = verifier.resolve(
            item.segmentIds.map((id) => ({ segmentId: id })),
            null,
            item.text,
          );
          return { text: item.text, evidence: refs };
        })
        .filter((b) => b.evidence.length > 0);

    const draft: FeedbackDraft = {
      id: makeId(this.ctx, 'drf'),
      interviewId,
      orgId: interview.orgId,
      interviewerId,
      aiVersion: `ai-${result.model}`,
      latestHumanVersion: null,
      submittedVersion: null,
      status: 'ai_draft',
      checks,
      highlights: resolveBacked(result.highlights),
      redFlags: resolveBacked(result.redFlags),
      // The product deliberately has no total score; each dimension stays independently reviewable.
      overallMatch: null,
      humanRecommendation: null,
      rejectedClaims: rejected,
      acknowledgedGaps: [],
      createdById: null,
      submittedById: null,
      createdAt: nowIso(this.ctx),
      submittedAt: null,
    };
    this.ctx.store.saveDraft(draft);
    recordAudit(this.ctx, actor, 'draft.generate', 'FeedbackDraft', draft.id, interview.orgId, {
      model: result.model,
      rejectedClaims: rejected.length,
      interviewerId,
    });
    return { draft, rejectedClaims: rejected };
  }

  private requireDraft(draftId: string): FeedbackDraft {
    const d = this.ctx.store.findDraft(draftId);
    if (!d) throw new DomainError('draft_not_found', '这份面评草稿不存在', { draftId });
    return d;
  }

  /**
   * Persists a draft assembled dimension by dimension by the evaluation agent.
   * Evidence is resolved again here: a score that cannot point at a real transcript segment
   * is stripped at the storage boundary, no matter what the loop believed.
   */
  assembleAgentDraft(
    actor: Actor,
    interviewId: string,
    input: {
      interviewerId: string;
      checks: StandardDimensionCheck[];
      rejectedClaims: RejectedClaim[];
      aiModel: string;
      agentRunId: string | null;
    },
  ): FeedbackDraft {
    const interview = this.requireInterview(interviewId);
    if (interview.status !== 'eval_pending' && interview.status !== 'expired') {
      throw new DomainError('wrong_state', '这场面试还没到写面评的阶段，先结束面试再来起草', { status: interview.status });
    }
    const standard = this.requireStandard(interview);
    const segments = this.ctx.store.listSegments(interviewId);
    if (segments.length === 0) {
      throw new DomainError('no_transcript', '没有转写内容，无法生成草稿，请改用人工笔记直接填写');
    }

    const verifier = new EvidenceVerifier(segments);
    const rejected: RejectedClaim[] = [...input.rejectedClaims];
    const byDimension = new Map(input.checks.map((c) => [c.dimensionId, c]));
    const checks: StandardDimensionCheck[] = standard.dimensions.map((dim) => {
      const check = byDimension.get(dim.id);
      if (!check) {
        return {
          id: makeId(this.ctx, 'chk'),
          interviewId,
          dimensionId: dim.id,
          dimensionName: dim.name,
          aiScore: null,
          aiSummary: '本次面试未产生与该维度相关的内容，需要人工补充判断',
          aiEvidence: [],
          aiRedFlagHits: [],
          needsHumanInput: true,
          finalScore: null,
          finalSummary: null,
          finalEvidence: [],
          revisedBy: [],
          status: 'auto_filled',
        };
      }
      const { refs } = verifier.resolve(
        check.aiEvidence.map((r) => ({ segmentId: r.segmentId })),
        dim.id,
        check.aiSummary ?? dim.name,
      );
      const evidenceBacked = refs.length > 0;
      if (check.aiScore !== null && !evidenceBacked) {
        rejected.push({
          dimensionId: dim.id,
          claim: `${check.aiSummary ?? dim.name}（AI 起评 ${check.aiScore}）`,
          reason: 'no_evidence',
        });
      }
      return {
        ...check,
        id: check.id || makeId(this.ctx, 'chk'),
        dimensionId: dim.id,
        dimensionName: dim.name,
        aiScore: evidenceBacked ? check.aiScore : null,
        aiSummary: check.aiScore !== null && !evidenceBacked ? '（AI 结论因缺乏转写证据已被移除）' : check.aiSummary,
        aiEvidence: refs,
        needsHumanInput: !evidenceBacked || check.needsHumanInput,
      };
    });

    const backed = checks.filter((c) => c.aiEvidence.length > 0 && c.aiSummary);
    const highlights: EvidenceBacked[] = backed
      .filter((c) => c.aiScore === 'high' || c.aiScore === 'medium')
      .slice(0, 3)
      .map((c) => ({ text: c.aiSummary as string, evidence: c.aiEvidence }));
    const redFlags: EvidenceBacked[] = backed
      .filter((c) => c.aiScore === 'low' || c.aiRedFlagHits.length > 0)
      .slice(0, 3)
      .map((c) => ({ text: c.aiSummary as string, evidence: c.aiEvidence }));

    const draft: FeedbackDraft = {
      id: makeId(this.ctx, 'drf'),
      interviewId,
      orgId: interview.orgId,
      interviewerId: input.interviewerId,
      aiVersion: `agent-${input.aiModel}`,
      latestHumanVersion: null,
      submittedVersion: null,
      status: 'ai_draft',
      checks,
      highlights,
      redFlags,
      overallMatch: null,
      humanRecommendation: null,
      rejectedClaims: rejected,
      acknowledgedGaps: [],
      gapDimensionIds: checks.filter((c) => c.aiScore === null).map((c) => c.dimensionId),
      gapDisposition: null,
      agentRunId: input.agentRunId,
      createdById: actor.kind === 'human' ? actor.userId : null,
      submittedById: null,
      createdAt: nowIso(this.ctx),
      submittedAt: null,
    };
    this.ctx.store.saveDraft(draft);
    recordAudit(this.ctx, actor, 'draft.agent_assemble', 'FeedbackDraft', draft.id, interview.orgId, {
      model: input.aiModel,
      gaps: draft.gapDimensionIds?.length ?? 0,
      rejectedClaims: rejected.length,
      agentRunId: input.agentRunId,
    });
    return draft;
  }

  /** The evaluation agent asks a human what to do with dimensions it could not back. */
  setGapDisposition(actor: Actor, draftId: string, disposition: 'carry_over' | 'not_carry'): FeedbackDraft {
    if (actor.kind !== 'human') throw new ComplianceError('human_only', '缺口怎么处理必须由面试官选择');
    const draft = this.requireDraft(draftId);
    if (draft.status === 'submitted' || draft.status === 'archived') {
      throw new DomainError('draft_locked', '这份面评已经提交或归档，不能再改缺口处理方式', { status: draft.status });
    }
    const gaps = draft.checks.filter((c) => c.aiScore === null).map((c) => c.dimensionId);
    if (gaps.length === 0) {
      throw new DomainError('no_gap', '这份草稿没有未落到证据的维度，不需要选择');
    }
    const next: FeedbackDraft = { ...draft, gapDisposition: disposition };
    this.ctx.store.saveDraft(next);
    recordAudit(this.ctx, actor, 'draft.gap_disposition', 'FeedbackDraft', draftId, draft.orgId, { disposition, gaps });
    return next;
  }

  /**
   * PRD 3.4 stage 2: human revision. The final score is always human.
   * Deleting every quote behind a judgement triggers a prompt to re-supply evidence, but the
   * human's own words are never blocked — 评分永远以面试官提交版为准.
   */
  reviseCheck(
    actor: Actor,
    draftId: string,
    checkId: string,
    patch: {
      finalScore?: StandardDimensionCheck['finalScore'];
      finalSummary?: string;
      addEvidenceSegmentIds?: string[];
      dropEvidenceSegmentIds?: string[];
    },
  ): { draft: FeedbackDraft; evidenceWarning: string | null } {
    if (actor.kind !== 'human') throw new ComplianceError('human_only', 'AI 起评分只能被看，不能被 AI 自己改成最终评分');
    const draft = this.requireDraft(draftId);
    if (draft.status === 'submitted' || draft.status === 'archived') {
      throw new DomainError('draft_locked', '这份面评已经提交或归档，不能再直接修改', { status: draft.status });
    }
    const check = draft.checks.find((c) => c.id === checkId);
    if (!check) throw new DomainError('check_not_found', '这个维度的检查项不存在', { checkId });

    const verifier = new EvidenceVerifier(this.ctx.store.listSegments(draft.interviewId));
    let evidence = check.finalEvidence;
    if (patch.addEvidenceSegmentIds && patch.addEvidenceSegmentIds.length > 0) {
      const { refs } = verifier.resolve(
        patch.addEvidenceSegmentIds.map((id) => ({ segmentId: id })),
        check.dimensionId,
        patch.finalSummary ?? check.finalSummary ?? '',
      );
      const byId = new Map(evidence.map((e) => [e.segmentId, e]));
      for (const r of refs) byId.set(r.segmentId, r);
      evidence = Array.from(byId.values());
    }
    if (patch.dropEvidenceSegmentIds && patch.dropEvidenceSegmentIds.length > 0) {
      evidence = evidence.filter((e) => !patch.dropEvidenceSegmentIds!.includes(e.segmentId));
    }

    const finalSummary = patch.finalSummary ?? check.finalSummary;
    const finalScore = patch.finalScore ?? check.finalScore;
    if (finalSummary) assertNoProtectedAttributes(`面评「${check.dimensionName}」`, { finalSummary });

    const nextCheck: StandardDimensionCheck = {
      ...check,
      finalScore,
      finalSummary,
      finalEvidence: evidence,
      revisedBy: [...new Set([...check.revisedBy, actor.userId])],
      status: check.status === 'auto_filled' ? 'human_revised' : check.status,
    };
    if (nextCheck.status !== check.status) {
      assertTransition(CHECK_TRANSITIONS, check.status, nextCheck.status, 'StandardDimensionCheck');
    }

    let evidenceWarning: string | null = null;
    const hasJudgement = Boolean(finalSummary) || finalScore != null;
    if (hasJudgement && evidence.length === 0 && check.aiEvidence.length > 0) {
      evidenceWarning = `你已给出「${check.dimensionName}」的判断但移除了全部引用证据，请补充支撑你判断的事实`;
    }

    const next: FeedbackDraft = {
      ...draft,
      checks: draft.checks.map((c) => (c.id === checkId ? nextCheck : c)),
      latestHumanVersion: `human-${actor.userId}-${Date.now()}`,
      status: draft.status === 'ai_draft' ? 'human_revising' : draft.status,
    };
    if (next.status !== draft.status) assertTransition(DRAFT_TRANSITIONS, draft.status, next.status, 'FeedbackDraft');
    this.ctx.store.saveDraft(next);
    recordAudit(this.ctx, actor, 'draft.revise_check', 'FeedbackDraft', draftId, draft.orgId, { checkId, patch, evidenceWarning });
    return { draft: next, evidenceWarning };
  }

  setRecommendation(actor: Actor, draftId: string, recommendation: string): FeedbackDraft {
    if (actor.kind !== 'human') throw new ComplianceError('human_only', 'AI 不替面试官写最终推荐意见');
    assertNoProtectedAttributes('综合推荐意见', { recommendation });
    const draft = this.requireDraft(draftId);
    const next: FeedbackDraft = {
      ...draft,
      humanRecommendation: recommendation,
      latestHumanVersion: `human-${actor.userId}-${Date.now()}`,
    };
    this.ctx.store.saveDraft(next);
    recordAudit(this.ctx, actor, 'draft.set_recommendation', 'FeedbackDraft', draftId, draft.orgId, {});
    return next;
  }

  /**
   * PRD 3.4 stage 3: submit. A human must act, and must tick the confirmation checklist.
   * Returns the list of still-blank dimensions instead of throwing so the UI can present it.
   */
  requirementsForSubmit(draftId: string): SubmitRequirement {
    const draft = this.requireDraft(draftId);
    const missing: string[] = [];
    if (!draft.humanRecommendation) missing.push('综合推荐意见');
    for (const c of draft.checks) {
      if (!c.finalScore) missing.push(`${c.dimensionName} · 还没填你的判断`);
    }
    return { ok: missing.length === 0, missing };
  }

  submit(
    actor: Actor,
    draftId: string,
    confirm: { fillUnscored: boolean; agreeUsedForDecision: boolean; anonymizeName: boolean },
  ): FeedbackDraft {
    if (actor.kind !== 'human') throw new ComplianceError('human_only', '只有人能提交面评，AI 输出不得绕过人确认直接产生结论');
    const draft = this.requireDraft(draftId);
    if (draft.status === 'submitted') throw new DomainError('already_submitted', '草稿已提交');
    assertTransition(DRAFT_TRANSITIONS, draft.status, 'submitted', 'FeedbackDraft');

    if (!confirm.agreeUsedForDecision) {
      throw new DomainError('decision_agreement_required', '必须确认同意本面评作为录用决策依据');
    }
    const req = this.requirementsForSubmit(draftId);
    if (!req.ok && !confirm.fillUnscored) {
      throw new DomainError('incomplete_eval', `还有没填完的项：${req.missing.join('、')}`, { missing: req.missing });
    }

    const acknowledgedGaps = req.ok ? [] : req.missing;
    const next: FeedbackDraft = {
      ...draft,
      status: 'submitted',
      submittedVersion: `submitted-${actor.userId}-${Date.now()}`,
      submittedById: actor.userId,
      submittedAt: nowIso(this.ctx),
      acknowledgedGaps,
      checks: draft.checks.map((c) => ({ ...c, status: c.revisedBy.length > 0 ? ('resubmitted' as const) : c.status })),
    };
    this.ctx.store.saveDraft(next);

    const interview = this.requireInterview(draft.interviewId);
    syncLedgerFromDraft(this.ctx, next, interview);
    if (interview.status === 'eval_pending' || interview.status === 'expired') {
      /** A late submission is itself the resolution of a lapse, so it is not gated behind an HR restart. */
      assertTransition(INTERVIEW_TRANSITIONS, interview.status, 'eval_submitted', 'Interview');
      this.ctx.store.saveInterview({ ...interview, status: 'eval_submitted' });
    }
    recordAudit(this.ctx, actor, 'draft.submit', 'FeedbackDraft', draftId, draft.orgId, { confirm, acknowledgedGaps });
    return next;
  }

  /** 低置信度片段：优先用面试官自己的笔记当主线（PRD 3.4 异常兜底）。 */
  lowConfidenceSegments(interviewId: string): string[] {
    return this.ctx.store
      .listSegments(interviewId)
      .filter((s) => s.confidence < LOW_CONFIDENCE || s.text.trim().length < 2)
      .map((s) => s.id);
  }

  /** Draft untouched for `thresholdHours` — the board uses this to flag a review that has drifted. */
  isStale(draftId: string, thresholdHours = 24): boolean {
    const draft = this.requireDraft(draftId);
    if (draft.status === 'submitted' || draft.status === 'archived') return false;
    const touched = draft.latestHumanVersion !== null || draft.checks.some((c) => c.revisedBy.length > 0);
    if (touched) return false;
    return this.ctx.clock.now().getTime() - Date.parse(draft.createdAt) >= thresholdHours * HOUR_MS;
  }

  pastHardDeadline(draftId: string): boolean {
    const draft = this.requireDraft(draftId);
    return this.ctx.clock.now().getTime() - Date.parse(draft.createdAt) >= 24 * HOUR_MS && draft.status !== 'submitted';
  }
}

export function evidenceMap(refs: EvidenceRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of refs) out[r.segmentId] = r.quote;
  return out;
}
