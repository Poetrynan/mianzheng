import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import type { FixedClock } from '../clock.js';
import { humanActor } from '../services/context.js';
import { MockLlmProvider } from '../ai/mockLlm.js';
import type { EvaluationPlan, EvaluationPlanRequest, EvaluationRequest, EvaluationResult, PrepPackResult } from '../ai/llm.js';
import { scanForProtectedAttributes } from '../compliance/protectedAttributes.js';
import type { JobIntake, StandardDimensionCheck } from '../types.js';
import { driveAgent, type AgentAction, type AgentDriver } from '../agent/runtime.js';
import { searchQueries } from '../agent/evaluationAgent.js';
import type { AgentRun } from '../agent/types.js';
import {
  closeInterview,
  defaultAppDeps,
  openInterview,
  seedConfirmedStandard,
  seedTeam,
  TRANSCRIPT_TEXT,
  type SeededTeam,
} from './fixtures.js';

const INTAKE: JobIntake = {
  jobTitle: '高级后端工程师',
  level: 'P7',
  reportsTo: '技术总监',
  teamSize: 12,
  painPoints: '交易系统扩容、跨部门推动',
  description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
};

/** Answers that hit four different facets, so the agent can stop early instead of exhausting a script. */
const RICH_ANSWERS = [
  '最需要解决的是交易系统在大促高并发下不稳定，业务上先出事的就是订单丢失和支付超时。',
  '做到 90 分的人能把扩容方案和取舍讲清楚，交付结果上接口耗时降低、故障恢复时间缩短。',
  '比如去年大促，他主动牵头把订单链路重构落地，压测方案也是他提出来要先看的。',
  '最警惕的是把线上故障归因给同事和环境，或者全程只讲动作不讲结果，这种人我不会要。',
];

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

async function freshApp(llm: MockLlmProvider): Promise<MianYanApp> {
  const deps = defaultAppDeps();
  const fresh = await MianYanApp.open({ dbPath: ':memory:', clock: deps.clock, llm, asr: deps.asr });
  team = seedTeam(fresh);
  return fresh;
}

async function driveStandard(answers: string[]): Promise<{
  run: AgentRun;
  questions: string[];
  finalStatus: string;
}> {
  let bundle = await app.agent.startStandard(humanActor(team.hr), team.jobId, INTAKE);
  const questions: string[] = [];
  for (const answer of answers) {
    if (bundle.run.status !== 'awaiting_human' || !bundle.run.question) break;
    questions.push(bundle.run.question.question);
    bundle = await app.agent.answer(bundle.run.id, humanActor(team.hr), answer);
  }
  return { run: bundle.run, questions, finalStatus: bundle.run.status };
}

async function evaluationReady(): Promise<{ candidateId: string; interviewId: string }> {
  seedConfirmedStandard(app, team);
  const { interview, candidateId } = await openInterview(app, team);
  closeInterview(app, team, interview.id);
  return { candidateId, interviewId: interview.id };
}

/** Some agent tests need their own transcript instead of the shared fixture. */
async function openCustomInterview(target: MianYanApp, transcript: string): Promise<string> {
  const candidate = target.addCandidate(team.orgId, team.jobId, '张伟', '8 年经验，后端工程师。');
  const interview = target.flow.schedule(humanActor(team.hr), {
    jobId: team.jobId,
    candidateId: candidate.id,
    interviewerIds: [team.interviewer.id],
    scheduledAt: target.ctx.clock.now().toISOString(),
    channel: 'video',
    round: 1,
  });
  const prompt = target.flow.presentConsent(interview.id);
  target.flow.answerConsent(humanActor(team.hr), interview.id, 'granted', prompt.presentedAt);
  target.flow.start(humanActor(team.interviewer), interview.id);
  const raw = await target.ctx.asr.transcribe({ inlineTranscript: transcript });
  target.flow.appendSegments(humanActor(team.interviewer), interview.id, raw);
  closeInterview(target, team, interview.id);
  return interview.id;
}

function scheduleRound(candidateId: string, round: number) {
  return app.flow.schedule(humanActor(team.hr), {
    jobId: team.jobId,
    candidateId,
    interviewerIds: [team.interviewer.id],
    scheduledAt: clock.now().toISOString(),
    channel: 'video',
    round,
  });
}

function submitDraft(draftId: string): void {
  const actor = humanActor(team.interviewer);
  app.evaluation.setRecommendation(actor, draftId, '建议进入下一轮');
  const draft = app.store.findDraft(draftId);
  for (const check of draft?.checks ?? []) {
    if (check.aiEvidence.length > 0) {
      app.evaluation.reviseCheck(actor, draftId, check.id, { finalScore: check.aiScore ?? 'medium' });
    }
  }
  app.evaluation.submit(actor, draftId, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: false });
}

describe('定标 Agent：问题跟着回答走', () => {
  it('回答覆盖四个面后主动停下并产出维度草稿，而不是把脚本问完', async () => {
    const { run, questions, finalStatus } = await driveStandard(RICH_ANSWERS);

    expect(questions).toHaveLength(4);
    expect(questions[0]).toContain('交易系统扩容');
    expect(questions[1]).toContain('60 分');
    expect(finalStatus).toBe('completed');
    expect(run.result?.summary).toContain('考察维度');
    const standard = app.store.findStandard(run.result?.standardId ?? '');
    expect(standard?.dimensions.length).toBeGreaterThanOrEqual(4);
    expect(run.steps.filter((s) => s.kind === 'answer')).toHaveLength(4);
    expect(run.steps.some((s) => s.tool === 'build_standard_draft' && s.ok)).toBe(true);
    for (const question of questions) {
      expect(scanForProtectedAttributes({ question })).toEqual([]);
    }
    expect(run.llm.model).toBe('mock-deterministic-v1');
  });

  it('回答里没有信息时继续问，六轮之后才整理草稿', async () => {
    const { questions, finalStatus } = await driveStandard(Array.from({ length: 6 }, () => '嗯，我再想想。'));
    expect(questions).toHaveLength(6);
    expect(new Set(questions).size).toBe(6);
    expect(finalStatus).toBe('completed');
  });

  it('负向：受保护特征的回答被拒绝，待回答的问题原样保留', async () => {
    const actor = humanActor(team.hr);
    const started = await app.agent.startStandard(actor, team.jobId, INTAKE);
    const pending = started.run.question;
    expect(pending).not.toBeNull();

    await expect(app.agent.answer(started.run.id, actor, '最好是已婚已育的男生，稳定一点。')).rejects.toMatchObject({
      code: 'protected_attribute_detected',
    });

    const run = app.agent.getRun(started.run.id);
    expect(run.status).toBe('awaiting_human');
    expect(run.question?.id).toBe(pending?.id);
    expect(run.question?.answeredAt).toBeNull();
    expect(run.steps.some((s) => s.kind === 'answer')).toBe(false);

    const answered = await app.agent.answer(run.id, actor, RICH_ANSWERS[0] as string);
    expect(answered.run.status).toBe('awaiting_human');
    expect(answered.run.question?.question).not.toBe(pending?.question);
  });
});

describe('面评 Agent：找不到原话就标缺口，不编结论', () => {
  it('逐维度检索并核对引用，缺口交给人决定是否带进下一轮', async () => {
    const { interviewId } = await evaluationReady();
    const actor = humanActor(team.interviewer);
    const bundle = await app.agent.startEvaluation(actor, interviewId);

    expect(bundle.run.phase).toBe('evaluation');
    expect(bundle.run.budget.maxSteps).toBe(44);
    expect(bundle.run.status).toBe('awaiting_human');
    expect(bundle.run.question?.options.map((o) => o.value)).toEqual(['carry_over', 'not_carry']);

    const draft = bundle.draft;
    expect(draft?.agentRunId).toBe(bundle.run.id);
    expect(draft?.checks.every((c) => c.finalScore === null)).toBe(true);

    const segments = app.store.listSegments(interviewId);
    for (const check of draft?.checks ?? []) {
      if (check.aiScore === null) continue;
      expect(check.aiEvidence.length).toBeGreaterThan(0);
      for (const ref of check.aiEvidence) {
        const segment = segments.find((s) => s.id === ref.segmentId);
        expect(segment).toBeTruthy();
        expect(ref.quote).toBe(segment?.text);
        expect(ref.startMs).toBe(segment?.startMs);
      }
    }

    const gap = draft?.checks.find((c) => c.dimensionName === '结构化表达');
    expect(gap?.aiScore).toBeNull();
    expect(gap?.needsHumanInput).toBe(true);
    expect(gap?.aiSummary).toContain('没找到');
    expect(draft?.gapDimensionIds).toEqual([gap?.dimensionId]);

    const retries = bundle.run.steps.filter(
      (s) => s.tool === 'search_transcript' && s.data?.dimensionId === gap?.dimensionId,
    );
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries.some((s) => String(s.detail).includes('没有找到'))).toBe(true);
    const marked = bundle.run.steps.find((s) => s.tool === 'mark_gap' && s.data?.dimensionId === gap?.dimensionId);
    expect(marked?.data?.reason).toBe('没有找到候选人的原话');

    await expect(app.agent.answer(bundle.run.id, actor, 'maybe')).rejects.toMatchObject({
      code: 'invalid_gap_disposition',
    });
    expect(app.agent.getRun(bundle.run.id).status).toBe('awaiting_human');

    const answered = await app.agent.answer(bundle.run.id, actor, 'carry_over');
    expect(answered.run.status).toBe('completed');
    expect(answered.draft?.gapDisposition).toBe('carry_over');
    expect(answered.run.steps.some((s) => s.label === '你选择：带进下一轮')).toBe(true);
    expect(answered.run.result?.summary).toContain('1 个留了缺口');
  });

  it('模型指向不存在的片段时被拒，缺口与拒绝原因都留下', async () => {
    class GhostLlm extends MockLlmProvider {
      override async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
        const result = await super.draftEvaluation(req);
        return {
          ...result,
          dimensions: result.dimensions.map((d) => ({ ...d, segmentIds: ['seg_ghost'] })),
        };
      }
    }
    const ghostApp = await freshApp(new GhostLlm());
    seedConfirmedStandard(ghostApp, team);
    const opened = await openInterview(ghostApp, team);
    closeInterview(ghostApp, team, opened.interview.id);

    const bundle = await ghostApp.agent.startEvaluation(humanActor(team.interviewer), opened.interview.id);
    const draft = bundle.draft;
    expect(draft?.checks.every((c) => c.aiScore === null)).toBe(true);
    expect(bundle.run.steps.some((s) => s.tool === 'draft_dimension' && !s.ok)).toBe(true);
    expect(draft?.rejectedClaims.some((r) => r.reason === 'unknown_segment')).toBe(true);
    expect(bundle.run.status).toBe('awaiting_human');
    expect(bundle.run.question?.question).toContain('4 个维度');
  });

  it('换个词重新查时，之前找到的原话不会丢', async () => {
    class FailFirstDraft extends MockLlmProvider {
      calls = 0;
      override async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
        this.calls += 1;
        const result = await super.draftEvaluation(req);
        if (this.calls > 1) return result;
        return { ...result, dimensions: result.dimensions.map((d) => ({ ...d, score: null, segmentIds: [] })) };
      }
    }
    const customApp = await freshApp(new FailFirstDraft());
    seedConfirmedStandard(customApp, team, ['跨部门推动力']);
    const interviewId = await openCustomInterview(
      customApp,
      [
        '[00:01:10] 候选人：跨部门的事情我主动牵头，把上下游拉到一张表上排期。',
        '[00:02:10] 候选人：联调时我逐个和合作方协作，把时间提前了一周。',
      ].join('\n'),
    );

    const bundle = await customApp.agent.startEvaluation(humanActor(team.interviewer), interviewId);
    const reads = bundle.run.steps.filter((s) => s.tool === 'read_segments');
    expect(reads).toHaveLength(2);
    expect(reads[0]?.data?.segmentIds).toHaveLength(1);
    const secondReadIds = reads[1]?.data?.segmentIds as string[];
    expect(secondReadIds).toHaveLength(2);

    const segments = customApp.store.listSegments(interviewId);
    const check = bundle.draft?.checks[0];
    expect(check?.aiScore).not.toBeNull();
    expect(check?.aiEvidence.map((e) => e.segmentId).sort()).toEqual([...secondReadIds].sort());
    for (const ref of check?.aiEvidence ?? []) {
      expect(segments.find((s) => s.id === ref.segmentId)?.text).toBe(ref.quote);
    }
  });

  it('标准很大、模型又反复给不出结论时，先把没查完的维度标成缺口，草稿照样交给人', async () => {
    class NoScoreLlm extends MockLlmProvider {
      override async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
        const result = await super.draftEvaluation(req);
        return { ...result, dimensions: result.dimensions.map((d) => ({ ...d, score: null, segmentIds: [] })) };
      }
    }
    const bigApp = await freshApp(new NoScoreLlm());
    const std = seedConfirmedStandard(bigApp, team, [
      '系统设计能力',
      '跨部门推动力',
      '抗压稳定性',
      '结构化表达',
      '业务理解与结果导向',
      '主动性与主人翁',
      '数据驱动',
    ]);
    const transcript = std.dimensions
      .map((d, i) => `[00:${String(10 + i).padStart(2, '0')}:00] 候选人：${searchQueries(d).join('，')}，我负责推进。`)
      .join('\n');
    const interviewId = await openCustomInterview(bigApp, transcript);

    const bundle = await bigApp.agent.startEvaluation(humanActor(team.interviewer), interviewId);
    expect(bundle.run.status).toBe('awaiting_human');
    expect(bundle.draft?.checks).toHaveLength(7);
    expect(bundle.run.steps.some((s) => s.label.includes('步数用完了'))).toBe(false);

    const budgetGaps = bundle.run.steps.filter(
      (s) => s.tool === 'mark_gap' && Array.isArray(s.data?.queries) && (s.data?.queries as unknown[]).length === 0,
    );
    expect(budgetGaps.length).toBeGreaterThan(0);
    expect(String(budgetGaps[0]?.detail)).toContain('步数');
    expect(bundle.draft?.checks.some((c) => c.aiScore === null && c.aiSummary?.includes('步数'))).toBe(true);

    const gapSteps = bundle.run.steps.filter((s) => s.tool === 'mark_gap');
    expect(gapSteps).toHaveLength(7);
    expect(gapSteps.filter((s) => (s.data?.queries as unknown[]).length === 3).length).toBeGreaterThanOrEqual(3);
    expect(bundle.run.steps.length).toBeLessThanOrEqual(bundle.run.budget.maxSteps);

    const answered = await bigApp.agent.answer(bundle.run.id, humanActor(team.interviewer), 'carry_over');
    expect(answered.run.status).toBe('completed');
    expect(answered.draft?.gapDisposition).toBe('carry_over');
  });

  it('调查顺序和检索词由 AI 排：它挑的词先查，标准关键词只做兜底', async () => {
    class PlanningLlm extends MockLlmProvider {
      override async planEvaluation(req: EvaluationPlanRequest): Promise<EvaluationPlan> {
        const push = req.dimensions.find((d) => d.name === '跨部门推动力');
        const sys = req.dimensions.find((d) => d.name === '系统设计能力');
        return {
          order: [push?.id ?? '', 'dim_ghost', sys?.id ?? ''],
          queries: {
            [push?.id ?? '']: ['牵头', '推'],
            [sys?.id ?? '']: [],
          },
          rationale: '候选人讲推动经历时更可能说具体动作，而不是标准里的抽象词',
        };
      }

      override async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
        const result = await super.draftEvaluation(req);
        return {
          ...result,
          dimensions: result.dimensions.map((d) => {
            const first = req.segments[0];
            if (d.score !== null || !first) return d;
            return {
              ...d,
              score: 'medium' as const,
              segmentIds: [first.id],
              summary: '候选人讲了一个具体动作，可以作为这个维度的证据',
              needsHumanInput: false,
            };
          }),
        };
      }
    }

    const planApp = await freshApp(new PlanningLlm());
    const std = seedConfirmedStandard(planApp, team, ['系统设计能力', '跨部门推动力']);
    const pushDim = std.dimensions.find((d) => d.name === '跨部门推动力');
    const interviewId = await openCustomInterview(
      planApp,
      [
        '[00:00:10] 面试官：先做个自我介绍。',
        '[00:00:25] 候选人：我做后端八年，最近在一家云服务公司。',
        '[00:01:00] 面试官：讲一次你推动事情落地的经历。',
        '[00:01:20] 候选人：当时需求方和研发互相不认，我牵头把两边拉到一张桌上，最后按期上线。',
        '[00:02:00] 面试官：讲一次架构决策。',
        '[00:02:15] 候选人：我主导了订单系统的架构重构，用缓存分层把接口耗时降低四成。',
      ].join('\n'),
    );

    const bundle = await planApp.agent.startEvaluation(humanActor(team.interviewer), interviewId);
    const planStep = bundle.run.steps.find((s) => s.tool === 'plan_searches');
    expect(planStep?.data?.source).toBe('model');
    const plan = planStep?.data?.plan as Array<{ dimensionId: string; queries: string[] }>;
    expect(plan[0]?.dimensionId).toBe(pushDim?.id);
    expect(plan[0]?.queries[0]).toBe('牵头');
    expect(plan.some((p) => p.dimensionId === 'dim_ghost')).toBe(false);
    expect(plan[0]?.queries).not.toContain('推');

    const searches = bundle.run.steps.filter((s) => s.tool === 'search_transcript');
    expect(searches[0]?.data?.dimensionId).toBe(pushDim?.id);
    expect(searches[0]?.data?.query).toBe('牵头');

    const check = bundle.draft?.checks.find((c) => c.dimensionId === pushDim?.id);
    expect(check?.aiScore).toBe('medium');
    expect(check?.aiEvidence[0]?.quote).toContain('牵头');
    expect(bundle.draft?.checks.every((c) => c.aiScore !== null)).toBe(true);
    expect(bundle.run.status).toBe('completed');
  });

  it('AI 排计划失败时，Agent 按标准关键词兜底，照样交草稿', async () => {
    class BrokenPlanLlm extends MockLlmProvider {
      override async planEvaluation(): Promise<EvaluationPlan> {
        throw new Error('planner down');
      }
    }
    const fallbackApp = await freshApp(new BrokenPlanLlm());
    seedConfirmedStandard(fallbackApp, team);
    const opened = await openInterview(fallbackApp, team);
    closeInterview(fallbackApp, team, opened.interview.id);

    const bundle = await fallbackApp.agent.startEvaluation(humanActor(team.interviewer), opened.interview.id);
    const planStep = bundle.run.steps.find((s) => s.tool === 'plan_searches');
    expect(planStep?.data?.source).toBe('fallback');
    expect(String(planStep?.data?.error)).toContain('planner down');
    expect(String(planStep?.detail)).toContain('AI 没给出计划');
    const firstSearch = bundle.run.steps.find((s) => s.tool === 'search_transcript');
    expect(firstSearch?.data?.query).toBe('系统设计');
    expect(bundle.run.status).toBe('awaiting_human');
    expect(bundle.draft?.checks.find((c) => c.dimensionName === '结构化表达')?.aiScore).toBeNull();
  });

  it('持久化边界再核一次：没有原文支撑的 AI 评分不会落进草稿', async () => {
    const std = seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const dim = std.dimensions[0];
    if (!dim) throw new Error('fixture dimension missing');
    const fake: StandardDimensionCheck = {
      id: 'chk_fake',
      interviewId: interview.id,
      dimensionId: dim.id,
      dimensionName: dim.name,
      aiScore: 'high',
      aiSummary: '候选人架构能力很强',
      aiEvidence: [{ segmentId: 'seg_ghost', startMs: 0, quote: '我主导了订单系统' }],
      aiRedFlagHits: [],
      needsHumanInput: false,
      finalScore: null,
      finalSummary: null,
      finalEvidence: [],
      revisedBy: [],
      status: 'auto_filled',
    };
    const draft = app.evaluation.assembleAgentDraft(humanActor(team.interviewer), interview.id, {
      interviewerId: team.interviewer.id,
      checks: [fake],
      rejectedClaims: [],
      aiModel: 'unit-test',
      agentRunId: null,
    });
    const check = draft.checks.find((c) => c.dimensionId === dim.id);
    expect(check?.aiScore).toBeNull();
    expect(check?.needsHumanInput).toBe(true);
    expect(check?.aiEvidence).toEqual([]);
    expect(draft.rejectedClaims.some((r) => r.dimensionId === dim.id && r.reason === 'no_evidence')).toBe(true);
  });
});

describe('证据账本：提交过的面评才形成跨轮次记忆', () => {
  async function firstRoundWithDisposition(disposition: 'carry_over' | 'not_carry') {
    const { candidateId, interviewId } = await evaluationReady();
    const actor = humanActor(team.interviewer);
    const bundle = await app.agent.startEvaluation(actor, interviewId);
    const answered = await app.agent.answer(bundle.run.id, actor, disposition);
    const draftId = answered.draft?.id;
    if (!draftId) throw new Error('draft missing');
    submitDraft(draftId);
    return { candidateId, draftId };
  }

  it('带进下一轮：账本留下原因，二面一页纸先补这个维度', async () => {
    const { candidateId, draftId } = await firstRoundWithDisposition('carry_over');
    const ledger = app.agent.ledgerFor(candidateId, team.jobId);
    const gap = ledger.find((e) => e.dimensionName === '结构化表达');
    expect(gap?.status).toBe('missing');
    expect(gap?.reason).toBe('没有找到候选人的原话');
    expect(gap?.carryOver).toBe(true);
    expect(ledger.find((e) => e.dimensionName === '抗压稳定性')).toMatchObject({
      status: 'contradicted',
      carryOver: false,
    });
    expect(app.store.findDraft(draftId)?.status).toBe('submitted');

    const second = scheduleRound(candidateId, 2);
    const prep = await app.agent.startPrep(humanActor(team.interviewer), second.id);
    expect(prep.run.status).toBe('completed');
    expect(prep.pack?.carryOver).toEqual([
      {
        dimensionId: gap?.dimensionId,
        dimensionName: '结构化表达',
        fromRound: 1,
        reason: '没有找到候选人的原话',
      },
    ]);
    expect(prep.pack?.questions[0]?.dimensionId).toBe(gap?.dimensionId);
    expect(prep.pack?.alignment.find((a) => a.dimensionId === gap?.dimensionId)?.mark).toBe('needs_probe');
    expect(prep.run.steps.some((s) => s.tool === 'read_ledger' && String(s.detail).includes('结构化表达'))).toBe(true);
    expect(prep.run.steps.some((s) => s.tool === 'validate_pack' && s.ok)).toBe(true);
    expect(prep.run.result?.summary).toContain('1 个来自上一轮的缺口');
  });

  it('带着缺口进二面：面评先从上一轮没结论的维度查起', async () => {
    const { candidateId } = await firstRoundWithDisposition('carry_over');
    const gap = app.agent.ledgerFor(candidateId, team.jobId).find((e) => e.dimensionName === '结构化表达');
    const second = scheduleRound(candidateId, 2);
    const prompt = app.flow.presentConsent(second.id);
    app.flow.answerConsent(humanActor(team.hr), second.id, 'granted', prompt.presentedAt);
    app.flow.start(humanActor(team.interviewer), second.id);
    const raw = await app.ctx.asr.transcribe({ inlineTranscript: TRANSCRIPT_TEXT });
    app.flow.appendSegments(humanActor(team.interviewer), second.id, raw);
    closeInterview(app, team, second.id);

    const bundle = await app.agent.startEvaluation(humanActor(team.interviewer), second.id);
    expect(bundle.run.steps.find((s) => s.tool === 'read_memory')?.detail).toContain('这轮先补');
    expect(bundle.run.steps.find((s) => s.tool === 'plan_searches')?.detail).toContain('先补前几轮留下的 1 个缺口');
    const searches = bundle.run.steps.filter((s) => s.tool === 'search_transcript');
    expect(searches[0]?.data?.dimensionId).toBe(gap?.dimensionId);
    const checks = bundle.draft?.checks ?? [];
    expect(checks.filter((c) => c.aiScore === null).map((c) => c.dimensionId)).toEqual([gap?.dimensionId]);
    expect(checks.some((c) => String(c.aiSummary).includes('步数不够'))).toBe(false);
  });

  it('只留在这轮：账本有缺口但下一轮不再带', async () => {
    const { candidateId } = await firstRoundWithDisposition('not_carry');
    const gap = app.agent.ledgerFor(candidateId, team.jobId).find((e) => e.dimensionName === '结构化表达');
    expect(gap?.status).toBe('missing');
    expect(gap?.carryOver).toBe(false);

    const second = scheduleRound(candidateId, 2);
    const prep = await app.agent.startPrep(humanActor(team.interviewer), second.id);
    expect(prep.pack?.carryOver).toEqual([]);
    expect(prep.run.steps.some((s) => s.tool === 'read_ledger' && String(s.detail).includes('没有需要补的缺口'))).toBe(true);
  });

  it('草稿没提交就不算记忆：二面不会继承没人确认过的缺口', async () => {
    const { candidateId, interviewId } = await evaluationReady();
    const actor = humanActor(team.interviewer);
    const bundle = await app.agent.startEvaluation(actor, interviewId);
    await app.agent.answer(bundle.run.id, actor, 'carry_over');

    const ledger = app.agent.ledgerFor(candidateId, team.jobId);
    expect(ledger).toEqual([]);

    const second = scheduleRound(candidateId, 2);
    const prep = await app.agent.startPrep(actor, second.id);
    expect(prep.pack?.carryOver).toEqual([]);
  });
});

describe('一页纸 Agent：自己检查、自己修，但不编内容', () => {
  class BadPrepLlm extends MockLlmProvider {
    override async buildPrepPack(): Promise<PrepPackResult> {
      return {
        ...this.info,
        crux: [],
        alignment: [],
        questions: [{ text: '候选人结婚了吗？打算什么时候要孩子？', dimensionId: null, why: '随便问问' }],
        redFlagChecks: [],
      };
    }
  }

  it('自检发现缺口后按规则补上，违合规的追问被删掉', async () => {
    const badApp = await freshApp(new BadPrepLlm());
    seedConfirmedStandard(badApp, team);
    const opened = await openInterview(badApp, team);
    const bundle = await badApp.agent.startPrep(humanActor(team.interviewer), opened.interview.id);

    expect(bundle.run.status).toBe('completed');
    const validateSteps = bundle.run.steps.filter((s) => s.tool === 'validate_pack');
    expect(validateSteps.length).toBeGreaterThanOrEqual(2);
    expect(validateSteps[0]?.ok).toBe(false);
    expect(validateSteps[validateSteps.length - 1]?.ok).toBe(true);
    expect(bundle.run.steps.some((s) => s.tool === 'repair_pack' && s.ok)).toBe(true);

    const pack = bundle.pack;
    expect(pack?.questions.length).toBeGreaterThanOrEqual(3);
    expect(pack?.questions.every((q) => scanForProtectedAttributes({ question: q.text }).length === 0)).toBe(true);
    expect(pack?.alignment).toHaveLength(4);
    expect(pack?.crux.length).toBeGreaterThan(0);
    expect(pack?.redFlagChecks.length).toBeGreaterThan(0);
  });
});

describe('Agent 运行时：预算、重复与失败回灌', () => {
  function baseRun(maxSteps: number): AgentRun {
    const at = clock.now().toISOString();
    return {
      id: `run_unit_${Math.random().toString(36).slice(2, 8)}`,
      orgId: team.orgId,
      phase: 'prep',
      goal: '单元测试',
      subject: { jobId: team.jobId, candidateId: null, interviewId: null, standardId: null },
      status: 'running',
      steps: [],
      budget: { maxSteps },
      question: null,
      result: null,
      stopReason: null,
      llm: { driver: 'unit', model: 'unit' },
      interviewerId: null,
      startedAt: at,
      updatedAt: at,
      endedAt: null,
    };
  }

  it('步数预算用完就停，并把当前进展交给人', async () => {
    const run = baseRun(2);
    app.store.saveAgentRun(run);
    let plans = 0;
    const driver: AgentDriver = {
      maxSteps: 2,
      next: (): AgentAction => {
        plans += 1;
        return { type: 'note', kind: 'plan', label: `第 ${plans} 次计划` };
      },
      act: () => ({}),
    };
    const finished = await driveAgent(app.ctx, run, driver, humanActor(team.hr), (r) => app.store.saveAgentRun(r));
    expect(finished.status).toBe('stopped');
    expect(finished.stopReason).toContain('步数');
    expect(finished.steps.filter((s) => s.kind !== 'stop')).toHaveLength(2);
  });

  it('同一步连续重复三次就停下，不再空转', async () => {
    const run = baseRun(10);
    app.store.saveAgentRun(run);
    const driver: AgentDriver = {
      maxSteps: 10,
      next: (): AgentAction => ({ type: 'tool', tool: 'same_tool', label: '再看一眼' }),
      act: () => ({ detail: '还是同样的结果' }),
    };
    const finished = await driveAgent(app.ctx, run, driver, humanActor(team.hr), (r) => app.store.saveAgentRun(r));
    expect(finished.status).toBe('stopped');
    expect(finished.stopReason).toContain('重复');
    expect(finished.steps.filter((s) => s.tool === 'same_tool')).toHaveLength(3);
  });

  it('工具失败变成可见的失败步骤，下一轮决策能看到并改道', async () => {
    const run = baseRun(10);
    app.store.saveAgentRun(run);
    let calls = 0;
    const driver: AgentDriver = {
      maxSteps: 10,
      next: (current): AgentAction => {
        const failed = current.steps.find((s) => !s.ok);
        if (failed) return { type: 'final', summary: '刚才那一步没成功，改走另一条路' };
        return { type: 'tool', tool: 'flaky', label: '调一次外部接口' };
      },
      act: () => {
        calls += 1;
        throw new Error('接口暂时不可用');
      },
    };
    const finished = await driveAgent(app.ctx, run, driver, humanActor(team.hr), (r) => app.store.saveAgentRun(r));
    expect(calls).toBe(1);
    expect(finished.steps[0]).toMatchObject({ kind: 'read', ok: false, detail: '接口暂时不可用' });
    expect(finished.status).toBe('completed');
    expect(finished.result?.summary).toContain('改走另一条路');
  });
});
