import type { ReactNode } from 'react';
import { ChevronDown, Compass, Hand, Sparkles } from 'lucide-react';
import type { AgentRun } from './api/types';
import { summarizeRun } from './agentView';
import { Badge } from './ui';

const PHASE = { standard: '定标', prep: '准备', evaluation: '面评', assistant: '查证' };
const STATUS = {
  running: '正在查证',
  awaiting_human: '等你决定',
  completed: '已完成查证',
  stopped: '已停下',
  failed: '需要接手',
};
const SOURCE = { model: '模型决定', mock: '样例推理', rule: '程序规则' };

/** A small, always-visible reading of this run; the full trace is never a separate workflow. */
export function AgentRunSummary({ run, children }: { run: AgentRun; children: ReactNode }) {
  const view = summarizeRun(run);
  const pending = run.status === 'awaiting_human';
  return (
    <section className="surface-2 overflow-hidden" aria-label={`${PHASE[run.phase]} Agent 决策摘要`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3 sm:px-5">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-paper">
          <Compass className="h-4 w-4 text-tint-brand" aria-hidden />
          {PHASE[run.phase]} Agent · {STATUS[run.status]}
        </h2>
        <div className="flex items-center gap-2 text-[12px] text-mist-dim">
          <Badge tone="idle">{view.mode}</Badge>
          <span>
            {view.usedSteps} / {run.budget.maxSteps} 步
          </span>
        </div>
      </header>
      <dl className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[1fr_1fr_1.25fr]">
        <div>
          <dt className="text-[12px] text-mist-dim">任务目标</dt>
          <dd className="mt-1 text-[13px] leading-relaxed text-paper">{run.goal}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mist-dim">最近查了什么</dt>
          <dd className="mt-1 text-[13px] leading-relaxed text-paper">
            {view.lastAction}
            <span className="mt-1 block text-[12px] text-mist">{view.observation}</span>
          </dd>
        </div>
        <div>
          <dt className="flex flex-wrap items-center gap-2 text-[12px] text-mist-dim">
            为什么继续或停下{view.decision ? <Badge tone="idle">{SOURCE[view.decision.by]}</Badge> : null}
          </dt>
          <dd className="mt-1 text-[13px] leading-relaxed text-paper">
            {view.reason}
            {!pending &&
            view.decision &&
            !view.reason.includes('没选') &&
            view.decision.considered.some((c) => c !== view.decision?.chosen) ? (
              <span className="mt-1 block text-[12px] text-mist">
                没选：{view.decision.considered.filter((c) => c !== view.decision?.chosen).join('、')}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      <p className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-human/[0.06] px-3 py-2 text-[12px] leading-relaxed text-mist sm:mx-5">
        <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tint-human" aria-hidden />
        <span>
          <b className="font-medium text-tint-human">{pending ? '现在等你决定：' : '留给你：'}</b>
          {view.handoff}
        </span>
      </p>
      <details key={run.id} open={pending || undefined} className="group border-t border-line-soft">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-[12px] font-medium text-tint-brand sm:px-5">
          <span className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            查看完整过程 · {view.usedSteps} 步{pending ? ' · 回答后才继续' : ''}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-line-soft p-3 sm:p-4">{children}</div>
      </details>
    </section>
  );
}
