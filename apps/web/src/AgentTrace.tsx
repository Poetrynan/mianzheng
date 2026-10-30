import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Flag,
  HelpCircle,
  History,
  ListChecks,
  PencilLine,
  Search,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRun, AgentRunStatus, AgentStep } from './api/types';
import { Badge, Btn, ErrorNote, Panel, Subhead, cx, useBottomFade } from './ui';

const STATUS: Record<AgentRunStatus, { label: string; tone: 'ai' | 'human' | 'ok' | 'warn' | 'bad' }> = {
  running: { label: '正在做', tone: 'ai' },
  awaiting_human: { label: '等你回答', tone: 'human' },
  completed: { label: '已完成', tone: 'ok' },
  stopped: { label: '停在这里', tone: 'warn' },
  failed: { label: '没有完成', tone: 'bad' },
};

const KIND_ICON: Record<AgentStep['kind'], LucideIcon> = {
  plan: ListChecks,
  read: BookOpen,
  search: Search,
  draft: PencilLine,
  verify: ShieldCheck,
  ask: HelpCircle,
  remember: History,
  answer: UserCheck,
  stop: Flag,
};

type StepTone = 'ai' | 'human' | 'ok' | 'warn';

function toneOf(step: AgentStep, run: AgentRun): StepTone {
  if (step.kind === 'ask' || step.kind === 'answer') return 'human';
  if (!step.ok) return 'warn';
  if (step.tool === 'mark_gap') return 'warn';
  if (step.kind === 'verify') return 'ok';
  if (step.kind === 'stop') return run.status === 'completed' ? 'ok' : 'warn';
  return 'ai';
}

const STEP_TONE: Record<StepTone, { icon: string; row: string }> = {
  ai: { icon: 'bg-brand/12 text-tint-brand', row: 'bg-brand/[0.05]' },
  human: { icon: 'bg-human/15 text-tint-human', row: 'bg-human/[0.06]' },
  ok: { icon: 'bg-ok/12 text-tint-ok', row: 'bg-ok/[0.05]' },
  warn: { icon: 'bg-warn/14 text-tint-warn', row: 'bg-warn/[0.05]' },
};

function isEmptySearch(step: AgentStep): boolean {
  if (step.tool !== 'search_transcript' || !step.ok) return false;
  const ids = step.data?.segmentIds;
  return Array.isArray(ids) && ids.length === 0;
}

/**
 * The run trace is the agent's visible work: what it chose to do, what failed, which gaps it
 * left, and where a person has to decide. It never prints tool names or ids.
 */
export function AgentTrace({
  run,
  title = '助手的工作记录',
  onAnswer,
  answering = false,
  error = null,
}: {
  run: AgentRun;
  title?: string;
  onAnswer?: (answer: string) => void;
  answering?: boolean;
  error?: string | null;
}) {
  const [text, setText] = useState('');
  const questionId = run.question?.id ?? null;
  const { ref: listRef, more: moreBelow, sync: syncFade } = useBottomFade<HTMLDivElement>();

  useEffect(() => {
    setText('');
  }, [questionId]);

  /**
   * Follow the newest move while the run is live; once it is over, start from the first move
   * so a finished record reads top-down instead of opening on its tail.
   */
  const live = run.status === 'running' || run.status === 'awaiting_human';
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = live ? el.scrollHeight : 0;
  }, [run.steps.length, questionId, live]);

  const visible = useMemo(() => run.steps.filter((s) => s.kind !== 'stop'), [run.steps]);
  const attempts = useMemo(() => {
    const seen = new Map<string, number>();
    return visible.map((step) => {
      const dim = typeof step.data?.dimensionId === 'string' ? step.data.dimensionId : '';
      const key = step.tool ? `${step.tool}:${dim}` : null;
      if (!key || step.kind === 'ask' || step.kind === 'answer') return 0;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return n;
    });
  }, [visible]);

  const status = STATUS[run.status];
  const pending = run.status === 'awaiting_human' ? run.question : null;
  const question = pending;
  const showFreeText = question?.freeText !== false;
  const canAnswer = Boolean(onAnswer);

  return (
    <Panel
      title={title}
      subtitle={run.goal}
      icon={HelpCircle}
      tone={run.status === 'awaiting_human' ? 'human' : run.status === 'stopped' || run.status === 'failed' ? 'warn' : 'ai'}
      right={<Badge tone={status.tone}>{status.label}</Badge>}
    >
      {visible.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-mist-dim">刚开始，还没有动作。</p>
      ) : (
        <div className="relative">
          <div
            ref={listRef}
            onScroll={syncFade}
            className="flex max-h-[340px] flex-col gap-1.5 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
          >
            {visible.map((step, i) => {
              const tone = toneOf(step, run);
              const cfg = STEP_TONE[tone];
              const Icon = KIND_ICON[step.kind];
              const attempt = attempts[i] ?? 0;
              return (
                <div key={step.index} className={cx('flex items-start gap-2 rounded-lg px-3 py-2', cfg.row)}>
                  <span className={cx('mt-[1px] grid h-6 w-6 shrink-0 place-items-center rounded-md', cfg.icon)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className={cx('text-[13px] font-medium leading-snug', step.kind === 'answer' || step.kind === 'ask' ? 'text-tint-human' : 'text-paper')}>
                        {step.label}
                      </p>
                      {step.tool === 'mark_gap' && step.ok ? <Badge tone="warn">缺口</Badge> : null}
                      {isEmptySearch(step) ? <Badge tone="warn">没有找到</Badge> : null}
                      {!step.ok ? (
                        <Badge tone="warn">
                          {step.kind === 'verify' ? '没通过' : '没成'}
                        </Badge>
                      ) : null}
                      {attempt > 1 ? <span className="text-[11px] text-mist-dim">第 {attempt} 次</span> : null}
                    </div>
                    {step.detail ? (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-mist">{step.detail}</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {moreBelow ? <div className="fade-below" aria-hidden /> : null}
        </div>
      )}

      {run.status === 'completed' && run.result ? (
        <div className="callout callout-ok mt-3 flex items-start gap-2 px-3 py-2 text-[13px] leading-relaxed text-tint-ok">
          <CheckCircle2 className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span>{run.result.summary}</span>
        </div>
      ) : null}

      {run.stopReason ? (
        <div className="callout callout-warn mt-3 flex items-start gap-2 px-3 py-2 text-[13px] leading-relaxed text-tint-warn">
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span>{run.stopReason}</span>
        </div>
      ) : null}

      {question ? (
        <div className="inset-human mt-4 p-4">
          <Subhead icon={HelpCircle}>到你了</Subhead>
          <p className="mt-1 text-[13px] font-medium leading-relaxed text-paper">{question.question}</p>
          {question.detail ? <p className="mt-1 text-[12px] leading-relaxed text-mist">{question.detail}</p> : null}

          {question.options.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {question.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={!canAnswer || answering}
                  onClick={() => onAnswer?.(option.value)}
                  className="press rounded-lg border border-line-soft bg-raise-soft px-3 py-2 text-left disabled:pointer-events-none disabled:opacity-50 hover:border-human/55 hover:bg-human/[0.07]"
                >
                  <span className="block text-[13px] font-medium text-paper">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-mist">{option.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {showFreeText ? (
            <div className="mt-3">
              <textarea
                className="field-base text-[13px] leading-relaxed"
                rows={4}
                placeholder="按平时的说法写就好"
                value={text}
                disabled={!canAnswer || answering}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Btn
                  variant="primary"
                  disabled={!canAnswer || answering || text.trim().length < 2}
                  busy={answering}
                  busyLabel="记下中…"
                  onClick={() => onAnswer?.(text.trim())}
                >
                  记下回答
                </Btn>
                <span className="text-[11px] text-mist-dim">助手只记录你的原话，不替你下结论</span>
              </div>
            </div>
          ) : null}

          {!showFreeText && question.options.length === 0 ? (
            <p className="mt-2 text-[12px] text-mist">这一步需要你来决定。</p>
          ) : null}
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}
