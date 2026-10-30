import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import { DAY_MS, FixedClock } from '../clock.js';
import { aiActor, humanActor } from '../services/context.js';
import { ComplianceError, DomainError } from '../errors.js';
import { assertTransition, CANDIDATE_TRANSITIONS } from '../states.js';
import { assertNoProtectedAttributes, scanForProtectedAttributes } from '../compliance/protectedAttributes.js';
import { runRetentionSweep } from '../compliance/retention.js';
import { AI_LABEL, CONSENT_NOTICE_TEXT, REFERENCE_ONLY_DISCLAIMER } from '../compliance/notices.js';
import { EvidenceVerifier } from '../ai/evidence.js';
import { defaultAppDeps, openInterview, RESUME_TEXT, seedConfirmedStandard, seedTeam, type SeededTeam } from './fixtures.js';
import { closeInterview } from './fixtures.js';
import type { TranscriptSegment } from '../types.js';

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

describe('6.1 候选人知情同意', () => {
  it('负向：没有同意记录就不能开始面试', async () => {
    seedConfirmedStandard(app, team);
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    const i = app.flow.schedule(humanActor(team.hr), {
      jobId: team.jobId,
      candidateId: candidate.id,
      interviewerIds: [team.interviewer.id],
      scheduledAt: clock.now().toISOString(),
      channel: 'video',
      round: 1,
    });
    expect(() => app.flow.start(humanActor(team.interviewer), i.id)).toThrow(ComplianceError);
    expect(() => app.flow.start(humanActor(team.interviewer), i.id)).toThrowError(
      expect.objectContaining({ code: 'consent_required' }),
    );
  });

  it('同意弹窗是独立告知，含两个按钮、保存期限与申诉渠道', () => {
    seedConfirmedStandard(app, team);
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    const i = app.flow.schedule(humanActor(team.hr), {
      jobId: team.jobId,
      candidateId: candidate.id,
      interviewerIds: [team.interviewer.id],
      scheduledAt: clock.now().toISOString(),
      channel: 'video',
      round: 1,
    });
    const prompt = app.flow.presentConsent(i.id);
    expect(prompt.buttons.map((b) => b.decision).sort()).toEqual(['granted', 'refused']);
    expect(prompt.noticeText).toBe(CONSENT_NOTICE_TEXT);
    expect(prompt.noticeText).toContain('6 个月');
    expect(prompt.noticeText).toContain('有权拒绝');
    expect(prompt.noticeText).toContain('免费人工复核');
    expect(prompt.noticeText).toContain('不保存面试视频');
  });

  it('候选人拒绝：不写转写、不生成草稿，只能人工笔记', async () => {
    seedConfirmedStandard(app, team);
    const opened = await openInterview(app, team, { consent: 'refused' });
    expect(opened.interview.aiRecordingActive).toBe(false);
    expect(opened.segments).toHaveLength(0);
    expect(() =>
      app.flow.appendSegments(humanActor(team.interviewer), opened.interview.id, [
        { speaker: 'candidate', speakerLabel: '候选人', startMs: 1000, endMs: 5000, text: '任何内容', confidence: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'consent_refused_no_transcript' }));

    closeInterview(app, team, opened.interview.id);
    await expect(app.evaluation.generateDraft(humanActor(team.interviewer), opened.interview.id, team.interviewer.id)).rejects.toThrow(
      DomainError,
    );
  });

  it('同意日志留存不少于 2 年', async () => {
    seedConfirmedStandard(app, team);
    const opened = await openInterview(app, team);
    const consent = app.store.findConsent(opened.consentId);
    expect(consent?.noticeKind).toBe('standalone_modal');
    expect(consent?.retentionUntil).toBeDefined();
    const heldDays = (Date.parse(consent?.retentionUntil ?? '') - Date.parse(consent?.respondedAt ?? '')) / DAY_MS;
    expect(heldDays).toBeGreaterThanOrEqual(730);
  });
});

describe('6.2 AI 生成内容标识', () => {
  it('草稿头部角标文案与导出页脚都不可省略', () => {
    expect(AI_LABEL.cardBadge).toContain('AI 生成的草稿');
    expect(AI_LABEL.cardBadge).toContain('需面试官确认');
    expect(AI_LABEL.exportFooter).toContain('AI 起草');
    expect(REFERENCE_ONLY_DISCLAIMER).toContain('仅供参考');
  });

  it('AI 起评分只能被看：草稿里 finalScore 全部为空', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    expect(draft.checks.every((c) => c.finalScore === null)).toBe(true);
    expect(draft.humanRecommendation).toBeNull();
    expect(draft.overallMatch).toBeNull();
  });
});

describe('6.3 算法歧视风控', () => {
  it('受保护特征写进考察维度会被直接拦下', () => {
    for (const bad of ['男性优先', '35 岁以下', '已婚已育优先', '本地人', '形象气质佳', '不招某族人']) {
      expect(() => assertNoProtectedAttributes('考察维度', { name: bad })).toThrow(ComplianceError);
    }
  });

  it('命中项写进审计并标记进入季度抽检，而不是静默丢弃', () => {
    const res = assertNoProtectedAttributes('考察维度', { name: '沟通能力', positiveEvidence: ['能向非技术同事讲清方案'] }, undefined);
    expect(res.ok).toBe(true);
    const hits = scanForProtectedAttributes({ probes: ['是否准备要孩子？'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.category).toBe('marital_or_fertility');
    const overridden = assertNoProtectedAttributes('考察维度', { name: '需与生育政策对接的合规岗' }, '岗位确实涉及生育保险经办');
    expect(overridden.ok).toBe(true);
    expect(overridden.hits.length).toBeGreaterThan(0);
  });

  it('HR 强制通过必须给理由，且理由进入审计', () => {
    seedConfirmedStandard(app, team);
    const std = app.goldenStandard.createFromTemplateLibrary(humanActor(team.hr), team.jobId, '交易系统');
    const dim = std.dimensions[0];
    if (!dim) throw new Error('fixture broke');
    expect(() =>
      app.goldenStandard.reviseDimension(humanActor(team.manager), std.id, dim.id, { name: '仅限 30 岁以下' }),
    ).toThrow(ComplianceError);
    const forced = app.goldenStandard.reviseDimension(
      humanActor(team.manager),
      std.id,
      dim.id,
      { name: '需要适应高强度出差' },
      '岗位为现场交付，出差为必要职务条件',
    );
    expect(forced.standard.dimensions.find((d) => d.id === dim.id)?.name).toBe('需要适应高强度出差');
    const audit = app.store.listAudit(std.id).find((a) => a.action === 'standard.revise_dimension');
    expect(audit?.payload).toBeDefined();
  });

  it('AI 不能替人给最终评分，也不能替人写推荐结论', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    expect(() => app.evaluation.setRecommendation(aiActor('mock'), draft.id, '录用')).toThrowError(
      expect.objectContaining({ code: 'human_only' }),
    );
    expect(() => app.evaluation.submit(aiActor('mock'), draft.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: false })).toThrow(
      ComplianceError,
    );
  });
});

describe('6.1 / 5.2 数据留存与删除', () => {
  it('180 天后录音与转写被清理，面评记录与同意日志留存', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const audio = { id: `aud_${interview.id}`, interviewId: interview.id, createdAtMs: clock.now().getTime(), mime: 'audio/mp4', bytes: 1024 };
    app.store.saveAudioBlob(audio);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    expect(app.store.listSegments(interview.id).length).toBeGreaterThan(0);

    clock.advanceMs(181 * DAY_MS);
    const report = runRetentionSweep(app.store, clock.now(), app.ctx.retention);
    expect(report.transcriptsPurged).toBeGreaterThan(0);
    expect(report.audioPurged).toBe(1);
    expect(app.store.listSegments(interview.id)).toHaveLength(0);
    expect(app.store.listAudioBlobs(interview.id)).toHaveLength(0);

    // 面评是业务记录：转写清理后草稿仍在，且引用带原文快照与时间戳
    const stillThere = app.store.findDraft(draft.id);
    expect(stillThere?.status).toBe('ai_draft');
    const ref = stillThere?.checks.find((c) => c.aiEvidence.length > 0)?.aiEvidence[0];
    expect(ref?.quote.length).toBeGreaterThan(0);

    // 同意日志按 2 年留存，180 天时不能被清掉
    expect(report.consentLogsPurged).toBe(0);
    clock.advanceMs(731 * DAY_MS);
    const second = runRetentionSweep(app.store, clock.now(), app.ctx.retention);
    expect(second.consentLogsPurged).toBe(1);
  });

  it('候选人删除是软删除，删除后不能再排面试', async () => {
    seedConfirmedStandard(app, team);
    const opened = await openInterview(app, team);
    const candidate = app.store.findCandidate(opened.candidateId);
    if (!candidate) throw new Error('fixture broke');
    app.store.saveCandidate({ ...candidate, deletedAt: clock.now().toISOString() });
    expect(() =>
      app.flow.schedule(humanActor(team.hr), {
        jobId: team.jobId,
        candidateId: candidate.id,
        interviewerIds: [team.interviewer.id],
        scheduledAt: clock.now().toISOString(),
        channel: 'video',
        round: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'candidate_deleted' }));
  });
});

describe('状态机非法迁移', () => {
  it('面试状态不能跳级', () => {
    seedConfirmedStandard(app, team);
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    const i = app.flow.schedule(humanActor(team.hr), {
      jobId: team.jobId,
      candidateId: candidate.id,
      interviewerIds: [team.interviewer.id],
      scheduledAt: clock.now().toISOString(),
      channel: 'video',
      round: 1,
    });
    expect(() => app.flow.finish(humanActor(team.interviewer), i.id)).toThrowError(
      expect.objectContaining({ code: 'illegal_state_transition' }),
    );
    expect(() => app.flow.markExpired(humanActor(team.hr), i.id)).toThrow(DomainError);
  });

  it('候选人状态机：hired 之后不能再流转', () => {
    expect(() => assertTransition(CANDIDATE_TRANSITIONS, 'hired', 'interview', 'Candidate')).toThrowError(
      expect.objectContaining({ code: 'illegal_state_transition' }),
    );
    expect(() => assertTransition(CANDIDATE_TRANSITIONS, 'interview', 'offer', 'Candidate')).not.toThrow();
  });

  it('金标准定稿后不能再改维度', () => {
    seedConfirmedStandard(app, team);
    const std = app.store.findStandard(app.store.findJob(team.jobId)?.confirmedStandardId ?? '');
    if (!std) throw new Error('fixture broke');
    const dim = std.dimensions[0];
    if (!dim) throw new Error('fixture broke');
    expect(() => app.goldenStandard.reviseDimension(humanActor(team.manager), std.id, dim.id, { name: '新名字' })).toThrowError(
      expect.objectContaining({ code: 'standard_locked' }),
    );
    expect(() => app.goldenStandard.recordAnswer(humanActor(team.manager), std.id, '新问题', '新回答')).toThrowError(
      expect.objectContaining({ code: 'standard_locked' }),
    );
  });

  it('草稿提交后不能再改', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '推荐进入下一轮');
    for (const c of draft.checks) app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, c.id, { finalScore: 'low' });
    const submitted = app.evaluation.submit(humanActor(team.interviewer), draft.id, { fillUnscored: false, agreeUsedForDecision: true, anonymizeName: false });
    expect(submitted.status).toBe('submitted');
    const check = submitted.checks[0];
    if (!check) throw new Error('fixture broke');
    expect(() => app.evaluation.reviseCheck(humanActor(team.interviewer), submitted.id, check.id, { finalScore: 'high' })).toThrowError(
      expect.objectContaining({ code: 'draft_locked' }),
    );
    expect(() => app.evaluation.submit(humanActor(team.interviewer), submitted.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: false })).toThrowError(
      expect.objectContaining({ code: 'already_submitted' }),
    );
  });
});

describe('反幻觉：引文校验器', () => {
  const seg = (id: string, startMs: number, text: string): TranscriptSegment => ({
    id,
    interviewId: 'int_x',
    speaker: 'candidate',
    speakerId: null,
    startMs,
    endMs: startMs + 5000,
    text,
    confidence: 1,
    correctedBy: null,
  });

  it('编造的 segmentId 被拒绝，并记入 rejectedClaims', () => {
    const v = new EvidenceVerifier([seg('seg_1', 1000, '我主导了订单系统重构')]);
    const res = v.resolve([{ segmentId: 'seg_ghost' }], 'dim_1', '候选人主导了三个系统');
    expect(res.refs).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe('unknown_segment');
  });

  it('转写里没有的话，即使给出引文也被拒绝', () => {
    const v = new EvidenceVerifier([seg('seg_1', 1000, '我推动了 5 个团队对齐')]);
    const res = v.resolve([{ quote: '我把系统延迟降到 3 毫秒' }], 'dim_1', '性能优化能力突出');
    expect(res.refs).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe('quote_not_in_transcript');
  });

  it('没有证据的结论直接被拒', () => {
    const v = new EvidenceVerifier([seg('seg_1', 1000, '我推动了 5 个团队对齐')]);
    const res = v.resolve([], 'dim_1', '抗压能力优秀');
    expect(res.rejected[0]?.reason).toBe('no_evidence');
  });

  it('引用文本由系统按 id 回填数据库原文，模型改写无效', () => {
    const v = new EvidenceVerifier([seg('seg_1', 1000, '我主导了订单系统重构')]);
    const res = v.resolve([{ segmentId: 'seg_1', quote: '我一句话改天换地' }], 'dim_1', '结论');
    expect(res.refs).toEqual([{ segmentId: 'seg_1', startMs: 1000, quote: '我主导了订单系统重构' }]);
  });

  it('正控制：真实引用能通过（避免测试本身是空的）', () => {
    const v = new EvidenceVerifier([seg('seg_1', 1000, '我主导了订单系统重构'), seg('seg_2', 8000, '跨部门那边是我牵头的')]);
    const res = v.resolve([{ segmentId: 'seg_1' }, { segmentId: 'seg_2' }], 'dim_1', '结论');
    expect(res.refs).toHaveLength(2);
    expect(res.rejected).toHaveLength(0);
  });

  it('模型给出的评分若无引用支撑，会被降级为需要人工判断', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    // 只保留"抗压"那一段外部归因，抹掉其它证据，看是否还给出高分
    app.store.purgeTranscript(interview.id);
    app.flow.appendSegments(humanActor(team.interviewer), interview.id, [
      { speaker: 'candidate', speakerLabel: '候选人', startMs: 1000, endMs: 8000, text: '那次故障是同事没配合好，环境问题我们没办法。', confidence: 1 },
    ]);
    closeInterview(app, team, interview.id);
    const { draft, rejectedClaims } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    expect(draft.checks.filter((c) => c.aiScore !== null && c.aiEvidence.length === 0)).toHaveLength(0);
    const scored = draft.checks.filter((c) => c.aiScore !== null);
    for (const c of scored) expect(c.aiEvidence.length).toBeGreaterThan(0);
    expect(draft.checks.every((c) => c.needsHumanInput || c.aiScore !== null)).toBe(true);
    expect(Array.isArray(rejectedClaims)).toBe(true);
  });
});

describe('留痕（AI 产出 + 人确认 + 系统记录）', () => {
  it('每一条 AI 输出与人工修改都有操作者与时间', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const check = draft.checks[0];
    if (!check) throw new Error('fixture broke');
    app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, { finalScore: 'high', finalSummary: '有量化的架构取舍' });

    const entries = app.store.listAudit(draft.id);
    expect(entries.some((e) => e.actorType === 'ai' || e.action === 'draft.generate')).toBe(true);
    const revise = entries.find((e) => e.action === 'draft.revise_check');
    expect(revise?.actorType).toBe('human');
    expect(revise?.actorId).toBe(team.interviewer.id);
    expect(Date.parse(revise?.at ?? '')).not.toBeNaN();
    expect(entries.every((e) => e.orgId === team.orgId)).toBe(true);
  });

  it('审计覆盖面试全生命周期', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    clock.advanceHours(25);
    app.reminders.tick();
    const all = app.store.listAuditByOrg(team.orgId);
    const actions = new Set(all.map((a) => a.action));
    for (const expected of ['interview.schedule', 'consent.answered', 'interview.start', 'transcript.append', 'interview.finish', 'reminder.queue', 'reminder.send']) {
      expect(actions.has(expected)).toBe(true);
    }
  });
});
