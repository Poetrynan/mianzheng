import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import { FixedClock, HOUR_MS } from '../clock.js';
import { humanActor, aiActor } from '../services/context.js';
import {
  closeInterview,
  defaultAppDeps,
  openInterview,
  runM1ToConfirmed,
  seedConfirmedStandard,
  seedTeam,
  RESUME_TEXT,
  type SeededTeam,
} from './fixtures.js';
import { isUsableReview, onTimeRate } from '../services/reminders.js';
import type { FeedbackDraft, StandardDimensionCheck } from '../types.js';

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

describe('金标准访谈提取', () => {
  it('走完填表 -> 逐轮提问 -> 草稿 -> 逐项确认 -> 双签 -> v1.0', async () => {
    const std = await runM1ToConfirmed(app, team);
    expect(std.status).toBe('confirmed');
    expect(std.version).toBe('v1.0');
    expect(std.dimensions.length).toBeGreaterThanOrEqual(4);
    expect(std.dimensions.length).toBeLessThanOrEqual(7);
    expect(std.dimensions.every((d) => d.confirmedBy !== null)).toBe(true);
    expect(std.confirmedByHiringManager).toBe(team.manager.id);
    expect(std.confirmedByHr).toBe(team.hr.id);
    expect(app.store.findJob(team.jobId)?.confirmedStandardId).toBe(std.id);
    for (const d of std.dimensions) {
      expect(d.positiveEvidence.length).toBeGreaterThan(0);
      expect(d.probes.length).toBeGreaterThan(0);
    }
  });

  it('负向：回答少于 2 轮不能提取', async () => {
    const hr = humanActor(team.hr);
    const std = app.goldenStandard.startIntake(hr, team.jobId, {
      jobTitle: '高级后端工程师',
      level: 'P7',
      reportsTo: '技术总监',
      teamSize: 12,
      painPoints: '扩容',
      description: app.store.findJob(team.jobId)?.description ?? '',
    });
    app.goldenStandard.recordAnswer(hr, std.id, '问题？', '只有一轮回答');
    await expect(app.goldenStandard.proposeDraft(hr, std.id)).rejects.toMatchObject({ code: 'not_enough_answers' });
  });

  it('负向：双签各签各的栏，一个人签不下两栏', () => {
    const hr = humanActor(team.hr);
    const mgr = humanActor(team.manager);
    const std = app.goldenStandard.startIntake(hr, team.jobId, {
      jobTitle: '高级后端工程师',
      level: 'P7',
      reportsTo: '技术总监',
      teamSize: 12,
      painPoints: '扩容',
      description: app.store.findJob(team.jobId)?.description ?? '',
    });
    expect(() => app.goldenStandard.sign(hr, std.id, 'hiring_manager')).toThrowError(
      expect.objectContaining({ code: 'sign_role_mismatch' }),
    );
    expect(() => app.goldenStandard.sign(mgr, std.id, 'hr')).toThrowError(
      expect.objectContaining({ code: 'sign_role_mismatch' }),
    );
    const signed = app.goldenStandard.sign(mgr, std.id, 'hiring_manager');
    expect(signed.confirmedByHiringManager).toBe(team.manager.id);
    expect(signed.confirmedByHr).toBeNull();
  });

  it('负向：没定稿不能生成准备包', async () => {
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    expect(app.store.findJob(team.jobId)?.confirmedStandardId).toBeNull();
    expect(() =>
      app.flow.schedule(humanActor(team.hr), {
        jobId: team.jobId,
        candidateId: candidate.id,
        interviewerIds: [team.interviewer.id],
        scheduledAt: '2026-03-02T01:00:00.000Z',
        channel: 'video',
        round: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'standard_required' }));
  });

  it('用人经理没空时，HR 可用模板库一键起草', () => {
    const std = app.goldenStandard.createFromTemplateLibrary(humanActor(team.hr), team.jobId, '需要跨部门推动和数据驱动');
    expect(std.status).toBe('draft');
    expect(std.dimensions.length).toBeGreaterThanOrEqual(4);
    // 模板只是起点：未经逐项确认绝不能定稿
    expect(() => app.goldenStandard.finalize(humanActor(team.hr), std.id)).toThrowError(
      expect.objectContaining({ code: 'dimensions_unconfirmed' }),
    );
  });

  it('同一维度改到第 3 次，提示引入专家', async () => {
    const std = await runM1ToConfirmed(app, team);
    // 定稿后不能再改，所以另起一个草稿版本验证阈值
    const draft = app.goldenStandard.createFromTemplateLibrary(humanActor(team.hr), team.jobId, '交易系统');
    const target = draft.dimensions[0];
    if (!target) throw new Error('fixture broke');
    let hint: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      hint = app.goldenStandard.reviseDimension(humanActor(team.manager), draft.id, target.id, {
        name: `${target.name} v${i}`,
      }).escalationHint;
    }
    expect(hint).toContain('建议让 HR 或外部专家介入设计');
    expect(std.status).toBe('confirmed');
  });
});

describe('准备包', () => {
  it('赛前 5 分钟的一页纸：对齐矩阵 + 追问 + 红旗排查', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const pack = await app.prepPack.build(humanActor(team.interviewer), interview.id);

    expect(pack.alignment.length).toBe(4);
    expect(pack.questions.length).toBeGreaterThanOrEqual(3);
    expect(pack.questions.length).toBeLessThanOrEqual(5);
    for (const q of pack.questions) {
      expect(q.why).toContain('验证');
      expect(pack.alignment.some((a) => a.dimensionId === q.dimensionId)).toBe(true);
    }
    // 简历里确实有跨部门/架构证据，系统设计应是 matched 而非全靠猜
    const systemDesign = pack.alignment.find((a) => a.dimensionName === '系统设计能力');
    expect(systemDesign?.mark).toBe('matched');
    const expression = pack.alignment.find((a) => a.dimensionName === '结构化表达');
    expect(['weak', 'needs_probe']).toContain(expression?.mark);
    expect(expression?.rationale).toContain('重点考察');
  });

  it('红旗排查抓到履历时间重叠与空窗（不是空表）', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const pack = await app.prepPack.build(humanActor(team.interviewer), interview.id);
    const joined = pack.redFlagChecks.join(' ');
    expect(joined).toContain('重叠');
    expect(joined).toContain('空窗');
  });

  it('简历解析失败走半自动：标记 degraded 并要求 HR 补关键信息', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team, { resumeText: '扫描件-无法解析' });
    const pack = await app.prepPack.build(humanActor(team.interviewer), interview.id);
    expect(pack.degraded).toBe(true);
    expect(pack.degradedReason).toContain('解析失败');
    expect(pack.redFlagChecks[0]).toContain('HR 手动补齐');
    for (const a of pack.alignment) expect(a.mark).toBe('needs_probe');
  });

  it('HR 可以否决踩合规雷区的追问', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const pack = await app.prepPack.build(humanActor(team.interviewer), interview.id);
    const q = pack.questions[0];
    if (!q) throw new Error('fixture broke');
    const after = app.prepPack.vetoQuestion(humanActor(team.hr), interview.id, q.id, '涉及婚育，违反 PIPL 就业歧视');
    expect(after.questions.some((x) => x.id === q.id)).toBe(false);
    expect(after.redFlagChecks.join(' ')).toContain('已由 HR 否决');
    expect(() => app.prepPack.vetoQuestion(humanActor(team.interviewer), interview.id, q.id, 'x')).toThrowError(
      expect.objectContaining({ code: 'hr_only' }),
    );
  });
});

describe('赛中静默转写', () => {
  it('同意转写后写入片段，带说话人与时间戳', async () => {
    seedConfirmedStandard(app, team);
    const { interview, segments } = await openInterview(app, team);
    expect(segments.length).toBe(10);
    expect(segments.every((s) => s.startMs >= 0 && s.text.length > 0)).toBe(true);
    const candidateLines = segments.filter((s) => s.speaker === 'candidate');
    expect(candidateLines.length).toBeGreaterThanOrEqual(4);
    expect(candidateLines[0]?.startMs).toBe(65000);
  });

  it('维度覆盖度与偏题提示', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const cov = app.flow.coverage(interview.id);
    expect(cov.covered).toHaveLength(3);
    const expression = (app.store.findStandard(interview.standardId)?.dimensions ?? []).find((d) => d.name === '结构化表达');
    expect(expression).toBeDefined();
    expect(cov.uncovered).toContain(expression?.id);
    // 全程都在主题内，不该弹偏题提示
    expect(app.flow.offTopicHint(interview.id).hint).toBeNull();
  });

  it('面试官可暂停 AI，暂停期间拒绝写入', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    app.flow.setPaused(humanActor(team.interviewer), interview.id, true);
    expect(() =>
      app.flow.appendSegments(humanActor(team.interviewer), interview.id, [
        { speaker: 'candidate', speakerLabel: '候选人', startMs: 999_000, endMs: 1_000_000, text: '敏感话题', confidence: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ai_paused' }));
    app.flow.setPaused(humanActor(team.interviewer), interview.id, false);
    const res = app.flow.appendSegments(humanActor(team.interviewer), interview.id, [
      { speaker: 'candidate', speakerLabel: '候选人', startMs: 999_000, endMs: 1_000_000, text: '恢复后的补充说明', confidence: 0.6 },
    ]);
    expect(res.saved).toHaveLength(1);
    expect(res.skippedLowConfidence).toEqual([res.saved[0]?.id]);
  });

  it('识别错误可由面试官改正原文，改动进审计', async () => {
    seedConfirmedStandard(app, team);
    const { interview, segments } = await openInterview(app, team);
    const seg = segments[1];
    if (!seg) throw new Error('fixture broke');
    const fixed = app.flow.correctSegment(humanActor(team.interviewer), seg.id, '我做后端八年，近三年在云链科技做技术专家。');
    expect(fixed.text).toContain('八年');
    expect(fixed.confidence).toBe(1);
    const audit = app.store.listAudit(seg.id);
    expect(audit.some((a) => a.action === 'transcript.correct')).toBe(true);
  });

  it('忘记点开始：60 秒后提示补开启', async () => {
    seedConfirmedStandard(app, team);
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    const i = app.flow.schedule(humanActor(team.hr), {
      jobId: team.jobId,
      candidateId: candidate.id,
      interviewerIds: [team.interviewer.id],
      scheduledAt: clock.now().toISOString(),
      channel: 'phone',
      round: 1,
    });
    expect(app.flow.startPromptOverdue(i.id)).toBe(false);
    clock.advanceMs(61_000);
    expect(app.flow.startPromptOverdue(i.id)).toBe(true);
  });
});

describe('面评草稿与评分卡', () => {
  it('每个维度结论都挂真实原文引用，AI 起评分不等于最终分', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    expect(draft.status).toBe('ai_draft');
    expect(draft.checks).toHaveLength(4);
    const withScore = draft.checks.filter((c) => c.aiScore !== null);
    expect(withScore.length).toBeGreaterThan(0);
    for (const c of withScore) {
      expect(c.aiEvidence.length).toBeGreaterThan(0);
      for (const ref of c.aiEvidence) {
        const seg = app.store.findSegment(ref.segmentId);
        expect(seg?.text).toBe(ref.quote);
        expect(ref.startMs).toBe(seg?.startMs);
      }
      expect(c.finalScore).toBeNull();
    }
    const blank = draft.checks.find((c) => c.dimensionName === '结构化表达');
    expect(blank?.aiScore).toBeNull();
    expect(blank?.needsHumanInput).toBe(true);
    expect(draft.overallMatch).toBeNull();
  });

  it('低置信度片段被单独列出', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    expect(app.evaluation.lowConfidenceSegments(interview.id)).toHaveLength(0);
    app.flow.appendSegments(humanActor(team.interviewer), interview.id, [
      { speaker: 'candidate', speakerLabel: '候选人', startMs: 1_200_000, endMs: 1_230_000, text: '听不清的一段', confidence: 0.4 },
    ]);
    expect(app.evaluation.lowConfidenceSegments(interview.id).length).toBe(1);
  });

  it('AI 不能自己把起评分变成最终分', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const check = draft.checks[0];
    if (!check) throw new Error('fixture broke');
    expect(() => app.evaluation.reviseCheck(aiActor('mock-deterministic-v1'), draft.id, check.id, { finalScore: 'high' })).toThrowError(
      expect.objectContaining({ code: 'human_only' }),
    );
    const res = app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, {
      finalScore: 'high',
      finalSummary: '架构取舍讲得清楚，有量化结果',
    });
    expect(res.draft.checks.find((c) => c.id === check.id)?.finalScore).toBe('high');
    expect(res.draft.status).toBe('human_revising');
  });

  it('删掉全部引用证据时，系统逼面试官补事实', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const scored = draft.checks.find((c) => c.aiEvidence.length > 0);
    if (!scored) throw new Error('fixture broke');
    const res = app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, scored.id, {
      finalScore: 'high',
      finalSummary: '技术扎实',
      dropEvidenceSegmentIds: scored.aiEvidence.map((e) => e.segmentId),
    });
    expect(res.evidenceWarning).toContain('请补充支撑你判断的事实');
    expect(res.draft.checks.find((c) => c.id === scored.id)?.finalEvidence).toHaveLength(0);
  });

  it('提交必须是人、必须勾选同意作为决策依据；未填满需要显式确认', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    expect(() =>
      app.evaluation.submit(aiActor('mock'), draft.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: false }),
    ).toThrowError(expect.objectContaining({ code: 'human_only' }));
    expect(() =>
      app.evaluation.submit(humanActor(team.interviewer), draft.id, {
        fillUnscored: true,
        agreeUsedForDecision: false,
        anonymizeName: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'decision_agreement_required' }));
    expect(() =>
      app.evaluation.submit(humanActor(team.interviewer), draft.id, {
        fillUnscored: false,
        agreeUsedForDecision: true,
        anonymizeName: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'incomplete_eval' }));

    const req = app.evaluation.requirementsForSubmit(draft.id);
    expect(req.ok).toBe(false);
    expect(req.missing.join(' ')).toContain('综合推荐意见');

    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮，深挖抗压表现');
    const filled = draft.checks.map((c) => c.id);
    let current = app.store.findDraft(draft.id);
    for (const id of filled) {
      if (!current) break;
      current = app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, id, { finalScore: 'medium' }).draft;
    }
    const submitted = app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: false,
      agreeUsedForDecision: true,
      anonymizeName: true,
    });
    expect(submitted.status).toBe('submitted');
    expect(submitted.submittedById).toBe(team.interviewer.id);
    expect(submitted.acknowledgedGaps).toEqual([]);
    expect(app.store.findInterview(interview.id)?.status).toBe('eval_submitted');
  });

  it('多位面试官各写各的草稿，HR 侧可并列', async () => {
    seedConfirmedStandard(app, team);
    const second = app.addUser(team.orgId, 'interviewer', '孙 二面');
    const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', RESUME_TEXT);
    const i = app.flow.schedule(humanActor(team.hr), {
      jobId: team.jobId,
      candidateId: candidate.id,
      interviewerIds: [team.interviewer.id, second.id],
      scheduledAt: clock.now().toISOString(),
      channel: 'video',
      round: 2,
    });
    const prompt = app.flow.presentConsent(i.id);
    app.flow.answerConsent(humanActor(team.hr), i.id, 'granted', prompt.presentedAt);
    app.flow.start(humanActor(team.interviewer), i.id);
    const raw = await app.ctx.asr.transcribe({ inlineTranscript: 'x' });
    void raw;
    app.flow.appendSegments(humanActor(team.interviewer), i.id, [
      {
        speaker: 'candidate',
        speakerLabel: '候选人',
        startMs: 1000,
        endMs: 9000,
        text: '我主导了订单系统的架构重构，扩容成本降低了四成。',
        confidence: 1,
      },
      { speaker: 'interviewer', speakerLabel: '面试官', startMs: 10000, endMs: 20000, text: '跨部门呢？', confidence: 1 },
      {
        speaker: 'candidate',
        speakerLabel: '候选人',
        startMs: 21000,
        endMs: 30000,
        text: '我推动了 5 个团队对齐接口规范。',
        confidence: 1,
      },
    ]);
    app.flow.finish(humanActor(team.interviewer), i.id);

    const a = await app.evaluation.generateDraft(humanActor(team.interviewer), i.id, team.interviewer.id);
    const b = await app.evaluation.generateDraft(humanActor(second), i.id, second.id);
    expect(a.draft.id).not.toBe(b.draft.id);
    expect(app.store.listDraftsByInterview(i.id)).toHaveLength(2);
  });
});

describe('24 小时提醒与待提交清单', () => {
  async function evalPendingInterview(): Promise<string> {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    return interview.id;
  }

  it('只排一次 24 小时提醒，到点才发给面试官本人', async () => {
    const id = await evalPendingInterview();
    expect(app.store.listReminders(id).map((e) => e.level)).toEqual([24]);
    expect(app.reminders.tick()).toHaveLength(0);

    clock.advanceHours(23);
    expect(app.reminders.tick()).toHaveLength(0);

    clock.advanceHours(1);
    const fired = app.reminders.tick();
    expect(fired.map((e) => e.level)).toEqual([24]);
    const notes = app.ctx.notifier as unknown as { sent: Array<{ to: string[]; title: string; interviewId: string | null }> };
    const n = notes.sent.find((x) => x.interviewId === id);
    expect(n?.title).toContain('面评还在等您');
    expect(n?.to).toEqual([team.interviewer.id]);
    expect(app.store.findInterview(id)?.status).toBe('eval_pending');
  });

  it('提醒只发一次，第二天不会再打扰', async () => {
    await evalPendingInterview();
    clock.advanceHours(25);
    expect(app.reminders.tick()).toHaveLength(1);
    clock.advanceHours(24);
    expect(app.reminders.tick()).toHaveLength(0);
  });

  it('面评提交后提醒自动收敛，不再骚扰面试官', async () => {
    const id = await evalPendingInterview();
    const draft = app.store.findDraftByInterview(id, team.interviewer.id);
    if (!draft) throw new Error('fixture broke');
    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮');
    for (const c of draft.checks) {
      app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, c.id, { finalScore: 'medium' });
    }
    app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: false,
      agreeUsedForDecision: true,
      anonymizeName: false,
    });

    clock.advanceHours(30);
    const before = (app.ctx.notifier as unknown as { sent: unknown[] }).sent.length;
    app.reminders.tick();
    const after = (app.ctx.notifier as unknown as { sent: unknown[] }).sent.length;
    expect(after).toBe(before);
  });

  it('出差挂起期间不发催办，恢复后继续计时', async () => {
    const id = await evalPendingInterview();
    app.reminders.suspend(humanActor(team.hr), id, '面试官出差');
    clock.advanceHours(25);
    const fired = app.reminders.tick();
    expect(fired).toHaveLength(0);
    app.reminders.resume(humanActor(team.hr), id);
    expect(app.reminders.tick().some((e) => e.level === 24)).toBe(true);
  });

  it('催办带上面试官自己的准时率', async () => {
    await evalPendingInterview();
    clock.advanceHours(25);
    app.reminders.tick();
    const body =
      (app.ctx.notifier as unknown as { sent: Array<{ title: string; body: string }> }).sent.find((x) => x.title.includes('面评还在等您'))
        ?.body ?? '';
    expect(body).toContain('准时率');
    expect(body).toContain('0%（0/1 份按时）');
    expect(onTimeRate([], [], new Date())).toEqual({ due: 0, onTime: 0, rate: null });
  });

  it('提醒不会自动把面试置为失效；只有 HR 能标记失效并重启', async () => {
    const id = await evalPendingInterview();
    clock.advanceHours(73);
    app.reminders.tick();
    expect(app.store.findInterview(id)?.status).toBe('eval_pending');
    expect(() => app.flow.markExpired(humanActor(team.interviewer), id)).toThrowError(expect.objectContaining({ code: 'hr_only' }));
    app.flow.markExpired(humanActor(team.hr), id);
    expect(app.store.findInterview(id)?.status).toBe('expired');
    expect(() => app.flow.restart(humanActor(team.interviewer), id)).toThrowError(expect.objectContaining({ code: 'restart_requires_hr' }));
    const restarted = app.flow.restart(humanActor(team.hr), id);
    expect(restarted.status).toBe('eval_pending');
  });

  it('HR 可按候选人关闭催办，也可给某位面试官放宽节奏', async () => {
    const id = await evalPendingInterview();
    app.reminders.disable(humanActor(team.hr), id, '候选人已明确不录用');
    clock.advanceHours(25);
    expect(app.reminders.tick().some((e) => e.level === 24)).toBe(false);

    expect(() => app.reminders.disable(humanActor(team.interviewer), id, 'x')).toThrowError(expect.objectContaining({ code: 'hr_only' }));

    const id2 = await evalPendingInterview();
    app.reminders.delayCadence(humanActor(team.hr), team.interviewer.id, 30);
    app.reminders.queueForInterview(humanActor(team.hr), id2);
    clock.advanceHours(25);
    expect(app.reminders.tick().some((e) => e.level === 24)).toBe(false);
    clock.advanceHours(30);
    expect(app.reminders.tick().some((e) => e.level === 24)).toBe(true);
  });

  it('时标推进不依赖真实等待：HOUR_MS 常量与 dueAt 一致', async () => {
    const id = await evalPendingInterview();
    const events = app.store.listReminders(id);
    const ended = Date.parse(app.store.findInterview(id)?.endedAt ?? '');
    const r24 = events.find((e) => e.level === 24);
    expect(r24).toBeDefined();
    expect(Date.parse(r24?.dueAt ?? '') - ended).toBe(24 * HOUR_MS);
  });
});

describe('看板与漏斗', () => {
  it('颜色态与按时提交率一并汇总，周报可直接转发', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    let rows = app.board.rows(team.orgId);
    expect(rows[0]?.light).toBe('waiting');
    let overview = app.board.overview(team.orgId);
    expect(overview.awaitingEval).toBe(1);

    clock.advanceHours(25);
    app.reminders.tick();
    rows = app.board.rows(team.orgId);
    expect(rows[0]?.light).toBe('attention');
    expect(rows[0]?.submittedOnTime).toBeNull();

    const report = app.board.weeklyReport(team.orgId);
    expect(report).toContain('待提交 1 场');
    expect(report).toContain('需要跟进');
    expect(report).toContain('已超过 24 小时');
    expect(app.board.funnel(team.orgId).find((s) => s.stage === 'interview')?.count).toBe(1);
    overview = app.board.overview(team.orgId);
    expect(overview.overdue).toBe(0);

    app.flow.markExpired(humanActor(team.hr), interview.id);
    expect(app.board.rows(team.orgId)[0]?.light).toBe('overdue');
    expect(app.board.overview(team.orgId).overdue).toBe(1);
  });

  it('按时率的分母包含到期后一直没提交的面评', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    // 窗口还没关闭，此时不判定，分母必须为 0
    expect(app.board.overview(team.orgId).onTimeRate).toEqual({ due: 0, onTime: 0, rate: null });

    clock.advanceHours(49);
    expect(app.board.overview(team.orgId).onTimeRate).toEqual({ due: 1, onTime: 0, rate: 0 });
    expect(app.board.weeklyReport(team.orgId)).toContain('0%（0/1）');
  });

  it('24h 内提交则按时率为 1/1', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮，深挖抗压表现');
    for (const check of draft.checks) {
      app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, { finalScore: 'medium' });
    }
    app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: false,
      agreeUsedForDecision: true,
      anonymizeName: false,
    });

    clock.advanceHours(25);
    expect(app.board.overview(team.orgId).onTimeRate).toEqual({ due: 1, onTime: 1, rate: 1 });
    expect(app.board.rows(team.orgId)[0]?.submittedOnTime).toBe(true);
  });

  /** 按时只回答交没交；可用回答 HR 拿到之后还要不要挨个问。 */
  it('每个维度都有分、结论挂得回原话，才算一份可用面评', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const seg = app.store.listSegments(interview.id)[0];
    if (!seg) throw new Error('fixture broke');

    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮，深挖抗压表现');
    for (const check of draft.checks) {
      app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, {
        finalScore: 'medium',
        addEvidenceSegmentIds: [seg.id],
      });
    }
    app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: false,
      agreeUsedForDecision: true,
      anonymizeName: false,
    });

    clock.advanceHours(25);
    const overview = app.board.overview(team.orgId);
    expect(overview.onTimeRate).toEqual({ due: 1, onTime: 1, rate: 1 });
    expect(overview.usable).toEqual({ due: 1, usable: 1, rate: 1 });
    expect(app.board.weeklyReport(team.orgId)).toContain('其中每个维度都有落点、结论挂得回原话的：100%（1/1）');
  });

  it('只给一个维度打分、其余空着提交：按时算，可用不算', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const seg = app.store.listSegments(interview.id)[0];
    const gaps = new Set(draft.gapDimensionIds ?? []);
    const skipped = draft.checks.find((c) => !gaps.has(c.dimensionId));
    if (!seg || !skipped || draft.checks.length < 2) throw new Error('fixture broke');

    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮，深挖抗压表现');
    for (const check of draft.checks) {
      if (check.id === skipped.id) continue;
      app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, {
        finalScore: 'medium',
        addEvidenceSegmentIds: [seg.id],
      });
    }
    app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: true,
      agreeUsedForDecision: true,
      anonymizeName: false,
    });

    clock.advanceHours(25);
    const overview = app.board.overview(team.orgId);
    expect(overview.onTimeRate).toEqual({ due: 1, onTime: 1, rate: 1 });
    expect(overview.usable).toEqual({ due: 1, usable: 0, rate: 0 });
  });

  it('Agent 查过三组词也没找到原话的维度不算空白，诚实的缺口照样可用', () => {
    const check = (over: Partial<StandardDimensionCheck>): StandardDimensionCheck => ({
      id: 'chk_scored',
      interviewId: 'int_1',
      dimensionId: 'dim_1',
      dimensionName: '架构判断',
      aiScore: 'high',
      aiSummary: '讲清了取舍',
      aiEvidence: [{ segmentId: 'seg_1', startMs: 0, quote: '我先把订单拆成读写两条链路' }],
      aiRedFlagHits: [],
      needsHumanInput: false,
      finalScore: 'high',
      finalSummary: '讲清了取舍',
      finalEvidence: [],
      revisedBy: [],
      status: 'auto_filled',
      ...over,
    });
    const blank = check({
      id: 'chk_blank',
      dimensionId: 'dim_2',
      dimensionName: '数据驱动',
      aiScore: null,
      aiSummary: null,
      aiEvidence: [],
      needsHumanInput: true,
      finalScore: null,
      finalSummary: null,
    });
    const draft = (over: Partial<FeedbackDraft>): FeedbackDraft => ({
      id: 'drf_1',
      interviewId: 'int_1',
      orgId: 'org_1',
      interviewerId: 'usr_1',
      aiVersion: 'v',
      latestHumanVersion: null,
      submittedVersion: 'v',
      status: 'submitted',
      checks: [check({}), blank],
      highlights: [],
      redFlags: [],
      overallMatch: null,
      humanRecommendation: '建议进入下一轮',
      rejectedClaims: [],
      acknowledgedGaps: ['数据驱动 · 还没填你的判断'],
      createdById: null,
      submittedById: 'usr_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      submittedAt: '2026-01-01T02:00:00.000Z',
      ...over,
    });

    expect(isUsableReview(draft({ gapDimensionIds: ['dim_2'] }))).toBe(true);
    // 没被记成证据缺口的空白，就是面试官跳过的维度
    expect(isUsableReview(draft({}))).toBe(false);
    expect(isUsableReview(draft({ gapDimensionIds: ['dim_2'], humanRecommendation: null }))).toBe(false);
    expect(
      isUsableReview(draft({ gapDimensionIds: ['dim_2'], checks: [check({ aiEvidence: [] }), blank] })),
    ).toBe(false);
  });

  it('重新起草留下的旧草稿，不能把这场面试算成没交', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
    const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮，深挖抗压表现');
    for (const check of draft.checks) {
      app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, check.id, { finalScore: 'medium' });
    }
    app.evaluation.submit(humanActor(team.interviewer), draft.id, {
      fillUnscored: false,
      agreeUsedForDecision: true,
      anonymizeName: false,
    });

    clock.advanceHours(25);
    const row = app.board.rows(team.orgId)[0];
    expect(row?.submittedOnTime).toBe(true);
    expect(row?.light).toBe('done');
    expect(app.board.overview(team.orgId).onTimeRate).toEqual({ due: 1, onTime: 1, rate: 1 });
    expect(app.board.weeklyReport(team.orgId)).toContain('本周没有需要跟进的候选人');
  });
});
