import { describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import { humanActor } from '../services/context.js';
import { MockLlmProvider } from '../ai/mockLlm.js';
import type { AssistantStepDecision, AssistantStepRequest, LlmProvider, NextStepChoice, NextStepRequest } from '../ai/llm.js';
import type { AgentRun } from '../agent/types.js';
import { closeInterview, defaultAppDeps, openInterview, seedConfirmedStandard, seedTeam } from './fixtures.js';

/** A provider that behaves like the sample model except where a test overrides a decision. */
function providerWith(overrides: Partial<LlmProvider>): LlmProvider {
  const base = new MockLlmProvider();
  return {
    driver: 'test-model',
    model: 'test-model-v1',
    extractStandard: (r) => base.extractStandard(r),
    buildPrepPack: (r) => base.buildPrepPack(r),
    draftEvaluation: (r) => base.draftEvaluation(r),
    planEvaluation: (r) => base.planEvaluation(r),
    chooseNextStep: (r) => base.chooseNextStep(r),
    assistantStep: (r) => base.assistantStep(r),
    ...overrides,
  };
}

async function evaluationApp(llm: LlmProvider) {
  const deps = defaultAppDeps();
  const app = await MianYanApp.open({ dbPath: ':memory:', clock: deps.clock, llm, asr: deps.asr });
  const team = seedTeam(app);
  seedConfirmedStandard(app, team);
  const { interview } = await openInterview(app, team);
  closeInterview(app, team, interview.id);
  return { app, team, interviewId: interview.id };
}

function decisions(run: AgentRun) {
  return run.steps
    .map((s) => ({ step: s, decision: s.data?.decision as { by: string; reason: string; chosen: string; considered: string[] } | undefined }))
    .filter((x) => x.decision);
}

describe('面评 Agent：下一步由模型在合法动作里挑', () => {
  it('模型选择「先多找一组原话」时，路径跟着变，但引用核对和预算照样生效', async () => {
    const picked: NextStepRequest[] = [];
    const llm = providerWith({
      async chooseNextStep(req): Promise<NextStepChoice> {
        picked.push(req);
        const last = req.options[req.options.length - 1]!;
        return { optionId: last.id, reason: '证据还少，先换个角度多找一段再下结论' };
      },
    });
    const { app, team, interviewId } = await evaluationApp(llm);
    const bundle = await app.agent.startEvaluation(humanActor(team.interviewer), interviewId);

    const made = decisions(bundle.run);
    expect(picked.length).toBeGreaterThan(0);
    expect(made.length).toBe(picked.length);
    expect(made.every((m) => m.decision!.by === 'model')).toBe(true);
    // 至少一次选的不是规则的默认项（默认项永远排在 considered 第一个）
    expect(made.some((m) => m.decision!.considered.length > 1 && m.decision!.chosen !== m.decision!.considered[0])).toBe(true);

    // 不管路径怎么走，落进草稿的每条 AI 引用都能在转写里逐字找到
    const segments = app.store.listSegments(interviewId).map((s) => s.text);
    for (const check of bundle.draft?.checks ?? []) {
      for (const ref of check.aiEvidence) expect(segments).toContain(ref.quote);
      if (check.aiScore !== null) expect(check.aiEvidence.length).toBeGreaterThan(0);
    }
    expect(bundle.run.steps.filter((s) => s.kind !== 'stop').length).toBeLessThanOrEqual(bundle.run.budget.maxSteps);
    expect(['awaiting_human', 'completed']).toContain(bundle.run.status);
  });

  it('模型选了列表外的动作，就按规则默认走，并把原因写在这一步上', async () => {
    const llm = providerWith({
      async chooseNextStep(): Promise<NextStepChoice> {
        return { optionId: 'opt99', reason: '随便选一个' };
      },
    });
    const { app, team, interviewId } = await evaluationApp(llm);
    const bundle = await app.agent.startEvaluation(humanActor(team.interviewer), interviewId);

    const made = decisions(bundle.run);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((m) => m.decision!.by === 'rule')).toBe(true);
    expect(made[0]!.decision!.reason).toContain('按默认顺序');
    expect(made.every((m) => m.decision!.chosen === m.decision!.considered[0])).toBe(true);
    expect(bundle.draft).toBeDefined();
  });
});

describe('问面证：一句话 → 计划 → 调工具 → 依据回答', () => {
  it('样例模式下也是真循环：先找人，再按问题去查转写，回答只引用查到的原话', async () => {
    const { app, team, interviewId } = await evaluationApp(new MockLlmProvider());
    const started = app.agent.startAssistant(humanActor(team.interviewer), team.orgId, '张伟提到过「分库分表」吗？', { interviewId });
    expect(started.run.phase).toBe('assistant');
    const run = await started.done;

    expect(run.status).toBe('completed');
    const tools = run.steps.filter((s) => s.tool).map((s) => s.tool);
    expect(tools).toEqual(['find_interviews', 'search_transcript']);
    expect(run.steps.find((s) => s.tool === 'search_transcript')?.data?.decision).toMatchObject({ by: 'mock' });
    expect(run.result?.summary).toContain('分库分表');
    expect(run.result?.summary).toContain('04:10');
    expect(run.result?.proposals?.[0]).toMatchObject({ kind: 'open_draft', interviewId });

    const stored = app.store.findAgentRun(run.id);
    expect(stored?.status).toBe('completed');
  });

  it('抽屉里给出的每条示例问题，样例模式都能听懂（不会落到帮助文案）', async () => {
    const { app, team, interviewId } = await evaluationApp(new MockLlmProvider());
    const examples = ['张伟哪几个维度还没有证据？', '帮我准备张伟下一轮的追问', '张伟提到过「分库分表」吗？', '还有谁的面评没交？'];
    for (const message of examples) {
      const run = await app.agent.startAssistant(humanActor(team.interviewer), team.orgId, message, { interviewId }).done;
      expect(run.status, message).toBe('completed');
      expect(run.steps.some((s) => s.tool), message).toBe(true);
      expect(run.result?.summary, message).not.toContain('我可以帮你查这些');
    }
  });

  it('查不到就说查不到，不替候选人补一句', async () => {
    const { app, team, interviewId } = await evaluationApp(new MockLlmProvider());
    const run = await app.agent.startAssistant(humanActor(team.interviewer), team.orgId, '张伟提到过「区块链」吗？', { interviewId }).done;
    expect(run.status).toBe('completed');
    expect(run.result?.summary).toContain('没有找到');
  });

  it('模型拿别的工作区的面试 id 来查，工具拒绝；建议里也不会出现那场面试', async () => {
    const { app, team, interviewId } = await evaluationApp(new MockLlmProvider());
    const other = app.createOrg('另一家公司');
    const outsider = app.addUser(other.id, 'interviewer', '外部 面试官');

    const llm = app.ctx.llm;
    let turn = 0;
    app.ctx.llm = providerWith({
      async assistantStep(req: AssistantStepRequest): Promise<AssistantStepDecision> {
        turn += 1;
        if (turn === 1) return { type: 'tool', tool: 'search_transcript', args: { interviewId, query: '订单' }, thought: '试试看' };
        return { type: 'answer', text: req.observations[0]?.ok ? '查到了' : '那场面试不在你的工作区', proposals: [{ kind: 'open_draft', interviewId }] };
      },
    });
    try {
      const run = await app.agent.startAssistant(humanActor(outsider), other.id, '查一下订单').done;
      const search = run.steps.find((s) => s.tool === 'search_transcript');
      expect(search?.ok).toBe(false);
      expect(run.result?.summary).toBe('那场面试不在你的工作区');
      expect(run.result?.proposals).toEqual([]);
    } finally {
      app.ctx.llm = llm;
    }
  });

  it('模型想调不存在的工具时直接停下，不会执行', async () => {
    const { app, team } = await evaluationApp(
      providerWith({
        async assistantStep(): Promise<AssistantStepDecision> {
          return { type: 'tool', tool: 'delete_everything', args: {}, thought: '' };
        },
      }),
    );
    const run = await app.agent.startAssistant(humanActor(team.hr), team.orgId, '帮我清空数据').done;
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toContain('不存在的工具');
    expect(run.steps.some((s) => s.tool === 'delete_everything')).toBe(false);
  });
});
