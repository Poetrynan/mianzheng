import type { AgentDecision, AgentRun, AgentStep } from './api/types';

export function decisionOf(step: AgentStep): AgentDecision | null {
  const d = step.data?.decision as Partial<AgentDecision> | undefined;
  if (!d || !['model', 'mock', 'rule'].includes(d.by ?? '') || typeof d.reason !== 'string' || !d.reason.trim())
    return null;
  return {
    by: d.by!,
    reason: d.reason,
    chosen: d.chosen ?? step.label,
    considered: Array.isArray(d.considered) ? d.considered.filter((c): c is string => typeof c === 'string') : [],
  };
}

/** Display legacy audit text in product language without modifying the stored record. */
export function agentDetail(text: string): string {
  const scores: Record<string, string> = { high: '达标', medium: '部分达标', low: '不达标' };
  return text.replace(/AI 起评 (high|medium|low)\b/g, (_, score: string) => `AI 建议分：${scores[score]}（非终评）`);
}

export function summarizeRun(run: AgentRun) {
  const actions = run.steps.filter((s) => s.tool);
  const last = actions[actions.length - 1];
  const pending = run.status === 'awaiting_human' ? run.question : null;
  const stopped = run.status === 'stopped' || run.status === 'failed';
  const decision = !pending && !stopped && last ? decisionOf(last) : null;
  const reason = pending
    ? (pending.detail ?? pending.question)
    : ((stopped ? run.stopReason : null) ??
      decision?.reason ??
      '这份记录未保存决策理由；可查看实际调用与结果，不补写模型想法。');
  return {
    mode: run.llm.driver === 'mock' ? '样例推理' : '已接入模型',
    usedSteps: run.steps.filter((s) => s.kind !== 'stop').length,
    lastAction: last?.label ?? '尚未调用工具',
    observation: agentDetail(last?.detail ?? run.result?.summary ?? '等待工具返回结果'),
    reason,
    decision,
    handoff:
      pending?.question ??
      (stopped ? run.stopReason : null) ??
      (run.phase === 'prep'
        ? '追问由你使用和补充；重新生成前会确认。'
        : 'AI 建议分仅在草稿中；终评、综合意见和提交由你完成。'),
  };
}
