import { DomainError, isDomainError } from '../errors.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from '../services/context.js';
import type { AgentQuestion, AgentQuestionOption, AgentResult, AgentRun, AgentStep, AgentStepKind } from './types.js';

export interface AgentQuestionDraft {
  question: string;
  detail?: string | null;
  freeText?: boolean;
  options?: AgentQuestionOption[];
}

export type AgentAction =
  | { type: 'tool'; tool: string; label: string; kind?: AgentStepKind; detail?: string | null }
  | { type: 'ask'; question: AgentQuestionDraft }
  | { type: 'note'; kind: 'plan' | 'remember' | 'verify'; label: string; detail?: string | null; data?: Record<string, unknown> }
  | { type: 'final'; summary: string; result?: Omit<AgentResult, 'summary'> }
  | { type: 'stop'; reason: string };

export interface AgentToolOutcome {
  label?: string;
  detail?: string | null;
  kind?: AgentStepKind;
  data?: Record<string, unknown>;
}

export interface AgentAnswerOutcome {
  label: string;
  detail?: string | null;
}

/**
 * A phase agent supplies only two decisions: what to do next, and how to execute one tool.
 * Pausing, resuming, step budgets, repeated-action guards and persistence live in the runtime.
 */
export interface AgentDriver {
  maxSteps: number;
  next(run: AgentRun): Promise<AgentAction> | AgentAction;
  act(run: AgentRun, tool: string): Promise<AgentToolOutcome> | AgentToolOutcome;
  /** Applies a human answer to the domain (record it, set a disposition) before the loop resumes. */
  applyAnswer?(run: AgentRun, question: AgentQuestion, answer: string): Promise<AgentAnswerOutcome | void> | AgentAnswerOutcome | void;
  finalize?(run: AgentRun, result: AgentResult): Promise<void> | void;
}

const MAX_HARD_STEPS = 120;
const MAX_SAME_ACTION = 3;

function appendStep(ctx: ServiceContext, run: AgentRun, step: Omit<AgentStep, 'index' | 'at'>): AgentStep {
  const full: AgentStep = { index: run.steps.length, at: nowIso(ctx), ...step };
  run.steps.push(full);
  run.updatedAt = full.at;
  return full;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorData(err: unknown): Record<string, unknown> | null {
  /** Tool context such as dimensionId must stay on the step itself so the next decision can find it. */
  if (isDomainError(err)) return { code: err.code, ...err.details, details: err.details };
  return null;
}

function stopRun(ctx: ServiceContext, run: AgentRun, actor: Actor, reason: string, detail: string | null, ok: boolean): void {
  run.status = 'stopped';
  run.stopReason = reason;
  run.endedAt = nowIso(ctx);
  appendStep(ctx, run, {
    kind: 'stop',
    label: reason,
    detail,
    ok,
    tool: null,
    data: null,
  });
  recordAudit(ctx, actor, 'agent.run.stop', 'AgentRun', run.id, run.orgId, { reason });
}

/**
 * The loop: observe state -> decide -> execute a tool or ask a human -> feed the result back.
 * A tool failure becomes a failed step (visible to the next decision), not a crash.
 */
export async function driveAgent(
  ctx: ServiceContext,
  run: AgentRun,
  driver: AgentDriver,
  actor: Actor,
  save: (run: AgentRun) => void,
): Promise<AgentRun> {
  if (run.status !== 'running') return run;
  let lastKey = '';
  let repeats = 0;

  for (let guard = 0; guard < MAX_HARD_STEPS; guard += 1) {
    const used = run.steps.filter((s) => s.kind !== 'stop').length;
    if (used >= run.budget.maxSteps) {
      stopRun(ctx, run, actor, '步数用完了，先把现在的进展交给你', `本次最多走 ${run.budget.maxSteps} 步，剩下的判断留给人`, true);
      save(run);
      return run;
    }

    let action: AgentAction;
    try {
      action = await driver.next(run);
    } catch (err) {
      run.status = 'failed';
      run.stopReason = errorMessage(err);
      run.endedAt = nowIso(ctx);
      appendStep(ctx, run, {
        kind: 'stop',
        label: '这一步没走通',
        detail: errorMessage(err),
        ok: false,
        tool: null,
        data: errorData(err),
      });
      save(run);
      return run;
    }

    if (action.type === 'note') {
      appendStep(ctx, run, {
        kind: action.kind,
        label: action.label,
        detail: action.detail ?? null,
        ok: true,
        tool: null,
        data: action.data ?? null,
      });
      save(run);
      continue;
    }

    if (action.type === 'tool') {
      const key = `${action.tool}|${action.label}|${action.detail ?? ''}`;
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats > MAX_SAME_ACTION) {
        stopRun(ctx, run, actor, '同一步连续重复了三次，先停下', '很可能卡在同一个问题上，把当前结果交给人来接手', true);
        save(run);
        return run;
      }

      try {
        const outcome = await driver.act(run, action.tool);
        appendStep(ctx, run, {
          kind: outcome.kind ?? action.kind ?? 'read',
          label: outcome.label ?? action.label,
          detail: outcome.detail ?? action.detail ?? null,
          ok: true,
          tool: action.tool,
          data: outcome.data ?? null,
        });
      } catch (err) {
        appendStep(ctx, run, {
          kind: action.kind ?? 'read',
          label: action.label,
          detail: errorMessage(err),
          ok: false,
          tool: action.tool,
          data: errorData(err),
        });
      }
      save(run);
      continue;
    }

    if (action.type === 'ask') {
      const q: AgentQuestion = {
        id: makeId(ctx, 'qst'),
        question: action.question.question,
        detail: action.question.detail ?? null,
        freeText: action.question.freeText ?? false,
        options: action.question.options ?? [],
        askedAt: nowIso(ctx),
        answeredAt: null,
        answeredBy: null,
        answer: null,
      };
      run.question = q;
      run.status = 'awaiting_human';
      appendStep(ctx, run, {
        kind: 'ask',
        label: `等你回答：${q.question}`,
        detail: q.detail,
        ok: true,
        tool: null,
        data: { questionId: q.id, options: q.options.map((o) => o.value) },
      });
      save(run);
      recordAudit(ctx, actor, 'agent.run.ask', 'AgentRun', run.id, run.orgId, { question: q.question, options: q.options.map((o) => o.value) });
      return run;
    }

    if (action.type === 'final') {
      const result: AgentResult = { summary: action.summary, ...(action.result ?? {}) };
      run.result = result;
      run.status = 'completed';
      run.endedAt = nowIso(ctx);
      appendStep(ctx, run, {
        kind: 'stop',
        label: '这件事做完了',
        detail: result.summary,
        ok: true,
        tool: null,
        data: { result },
      });
      save(run);
      await driver.finalize?.(run, result);
      recordAudit(ctx, actor, 'agent.run.finish', 'AgentRun', run.id, run.orgId, { summary: result.summary });
      return run;
    }

    stopRun(ctx, run, actor, action.reason, null, true);
    save(run);
    return run;
  }

  stopRun(ctx, run, actor, '循环次数超出上限，先停下', null, false);
  save(run);
  return run;
}

/** Records the human's answer as an amber step, then hands control back to the same loop. */
export async function answerAgentQuestion(
  ctx: ServiceContext,
  run: AgentRun,
  driver: AgentDriver,
  actor: Actor,
  answer: string,
  save: (run: AgentRun) => void,
): Promise<AgentRun> {
  if (run.status !== 'awaiting_human' || !run.question) {
    throw new DomainError('no_pending_question', '现在没有等你回答的问题', { status: run.status });
  }
  if (run.question.answeredAt) throw new DomainError('already_answered', '这个问题已经回答过了');
  const text = answer.trim();
  if (text.length === 0) throw new DomainError('answer_required', '请先填写回答再继续');

  const question = run.question;
  const applied = await driver.applyAnswer?.(run, question, text);
  run.question = {
    ...question,
    answeredAt: nowIso(ctx),
    answeredBy: actor.kind === 'human' ? actor.userId : actor.kind === 'ai' ? `ai:${actor.model}` : `system:${actor.name}`,
    answer: text,
  };
  const label =
    question.options.length > 0 && applied?.label
      ? applied.label
      : `你回答：${text.length > 36 ? `${text.slice(0, 36)}…` : text}`;
  appendStep(ctx, run, {
    kind: 'answer',
    label,
    detail: applied?.detail ?? null,
    ok: true,
    tool: null,
    data: { questionId: question.id },
  });
  /** The answered question lives in the step history; nothing is pending any more. */
  run.question = null;
  run.status = 'running';
  save(run);
  recordAudit(ctx, actor, 'agent.run.answer', 'AgentRun', run.id, run.orgId, { questionId: question.id, answer: text });
  return run;
}

// ---- helpers shared by the phase drivers ----

export function stepOf(run: AgentRun, tool: string): AgentStep | undefined {
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const s = run.steps[i];
    if (s?.tool === tool) return s;
  }
  return undefined;
}

export function stepsOf(run: AgentRun, tool: string): AgentStep[] {
  return run.steps.filter((s) => s.tool === tool);
}

export function failedCount(run: AgentRun, tool: string): number {
  return stepsOf(run, tool).filter((s) => !s.ok).length;
}

export function succeeded(run: AgentRun, tool: string): boolean {
  return stepsOf(run, tool).some((s) => s.ok);
}

export function dataString(step: AgentStep | undefined, key: string): string | null {
  const v = step?.data?.[key];
  return typeof v === 'string' ? v : null;
}

export function dataNumber(step: AgentStep | undefined, key: string): number | null {
  const v = step?.data?.[key];
  return typeof v === 'number' ? v : null;
}
