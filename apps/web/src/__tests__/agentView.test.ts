import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentStep } from '../api/types';
import { summarizeRun } from '../agentView';

function step(index: number, extra: Partial<AgentStep>): AgentStep {
  return {
    index,
    at: '2026-11-04T00:00:00Z',
    kind: 'read',
    label: '读记录',
    detail: null,
    ok: true,
    tool: 'read_ledger',
    data: null,
    ...extra,
  };
}
function run(extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run1',
    orgId: 'org1',
    phase: 'evaluation',
    goal: '查原话，保留缺口',
    subject: { interviewId: 'i1', jobId: 'j1', candidateId: 'c1', standardId: 's1' },
    status: 'completed',
    steps: [],
    budget: { maxSteps: 44 },
    question: null,
    result: { summary: '已查到两段原话' },
    stopReason: null,
    llm: { driver: 'mock', model: 'mock-deterministic-v1' },
    interviewerId: 'u1',
    startedAt: '',
    updatedAt: '',
    endedAt: '',
    ...extra,
  };
}

describe('Agent 摘要只陈述运行记录中存在的事实', () => {
  it('历史样例没有理由时，明确缺失，不冒充模型决策', () => {
    const view = summarizeRun(run({ steps: [step(0, { detail: '查到两段原话' })] }));
    expect(view.mode).toBe('样例推理');
    expect(view.decision).toBeNull();
    expect(view.reason).toContain('未保存决策理由');
    expect(view.observation).toBe('查到两段原话');
  });

  it('模型出错后按规则兜底，不能因为接了真实模型就说这一步由模型决定', () => {
    const decision = {
      by: 'rule',
      reason: '模型未给出合法动作，按规则继续',
      chosen: '读记录',
      considered: ['读记录', '继续搜索'],
    };
    const view = summarizeRun(
      run({ llm: { driver: 'openai-compatible', model: 'test' }, steps: [step(0, { data: { decision } })] }),
    );
    expect(view.decision?.by).toBe('rule');
    expect(view.reason).toContain('按规则继续');
  });

  it('有待回答的问题时优先展示人工闸门；停止步骤不计入已用预算', () => {
    const view = summarizeRun(
      run({
        status: 'awaiting_human',
        steps: [
          step(0, {}),
          step(1, { kind: 'ask', tool: null, label: '是否带入下一轮？' }),
          step(2, { kind: 'stop', tool: null }),
        ],
        question: {
          id: 'q1',
          question: '缺口要带入下一轮吗？',
          detail: null,
          freeText: false,
          options: [],
          askedAt: '',
          answeredAt: null,
          answeredBy: null,
          answer: null,
        },
      }),
    );
    expect(view.handoff).toBe('缺口要带入下一轮吗？');
    expect(view.usedSteps).toBe(2);
  });

  it('最新动作没有理由时，不把前一步的理由安到它身上', () => {
    const view = summarizeRun(
      run({
        steps: [
          step(0, { data: { decision: { by: 'mock', reason: '先找候选人', chosen: '读记录', considered: [] } } }),
          step(1, { label: '核对原话', kind: 'verify', tool: 'verify_quotes', detail: '引用逐字一致' }),
        ],
      }),
    );
    expect(view.lastAction).toBe('核对原话');
    expect(view.decision).toBeNull();
    expect(view.reason).toContain('未保存决策理由');
  });

  it('停止或失败时直接显示实际停止原因', () => {
    const view = summarizeRun(run({ status: 'stopped', result: null, stopReason: '步数用完，交给人处理' }));
    expect(view.reason).toBe('步数用完，交给人处理');
    expect(view.handoff).toContain('交给人处理');
  });

  it('人工暂停的解释不借用上一个工具的模型决定标签', () => {
    const view = summarizeRun(
      run({
        status: 'awaiting_human',
        steps: [
          step(0, { data: { decision: { by: 'model', reason: '继续找证据', chosen: '读记录', considered: [] } } }),
        ],
        question: {
          id: 'q1',
          question: '缺口如何处理？',
          detail: '两组证据仍然缺失，等你决定',
          freeText: false,
          options: [],
          askedAt: '',
          answeredAt: null,
          answeredBy: null,
          answer: null,
        },
      }),
    );
    expect(view.reason).toBe('两组证据仍然缺失，等你决定');
    expect(view.decision).toBeNull();
  });
});
