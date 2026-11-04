import { useState } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Sparkles } from 'lucide-react';
import { api } from './api/client';
import { useLoader, useSession, type Directory } from './session';
import { Badge } from './ui';

const DEMO_EMAILS = new Set([
  'wang@demo.mianzheng.local',
  'hr@demo.mianzheng.local',
  'zhao@demo.mianzheng.local',
]);

/** A reading route through existing sample records; never creates or changes an interview. */
export function DemoGuide({
  directory,
  onOpenInterview,
  onOpenStandard,
  onAsk,
  busy = false,
}: {
  directory: Directory;
  onOpenInterview: (tab: 'prep' | 'draft', interviewId: string) => void;
  onOpenStandard: (jobId: string) => void;
  onAsk: (question: string) => void;
  busy?: boolean;
}) {
  const { me, interviews } = useSession();
  const isDemo = DEMO_EMAILS.has(me?.email ?? '');
  const health = useLoader(isDemo ? () => api.health() : async () => null, [isDemo]);
  const [task, setTask] = useState('');
  if (!isDemo) return null;

  const all = interviews.data ?? [];
  const first = [...all]
    .sort((a, b) => a.round - b.round || a.scheduledAt.localeCompare(b.scheduledAt))
    .find((it) => it.status === 'eval_submitted' && all.some((next) =>
      next.candidateId === it.candidateId && next.jobId === it.jobId && next.round > it.round));
  const next = first ? [...all]
    .filter((it) => it.candidateId === first.candidateId && it.jobId === first.jobId && it.round > first.round)
    .sort((a, b) => a.round - b.round)[0] : undefined;
  const name = first ? directory.labelOf(first).split(' · ')[0] : null;
  const examples = name ? [`${name}哪几个维度还没有证据？`, `帮我准备${name}下一轮的追问`, `${name}提到过「分库分表」吗？`] : ['还有谁的面评没交？'];

  return (
    <section className="surface-2 overflow-hidden" aria-labelledby="demo-guide-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand/10 bg-brand/[0.06] px-4 py-3 sm:px-6">
        <span className="inline-flex items-center gap-2 text-[12px] font-medium text-mist">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          示例工作区 · 虚构数据
        </span>
        <Badge>{health.data?.llmDriver === 'mock' ? '样例推理 · 非真实模型' : health.data ? '已接入模型' : '正在确认运行环境'}</Badge>
      </div>
      <div className="p-4 sm:p-5">
        <h2 id="demo-guide-title" className="flex items-center gap-2 text-[20px] font-semibold text-paper"><Sparkles className="h-5 w-5 text-tint-brand" aria-hidden />给面试证据 Agent 一个任务</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-mist">
          查上一轮缺口、找候选人原话、准备追问。你说目标，它查记录并显示每一步的理由；要改数据时先等你确认。
        </p>
        <form className="mt-4" onSubmit={(e) => { e.preventDefault(); if (!busy && task.trim()) { onAsk(task.trim()); setTask(''); } }}>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-[var(--field-bg)] p-2 focus-within:border-brand/50">
            <input value={task} onChange={(e) => setTask(e.target.value)} maxLength={500} aria-label="给面试证据 Agent 一个任务" placeholder={name ? `例如：${name}哪几个维度还没有证据？` : '例如：还有谁的面评没交？'} className="min-h-11 min-w-0 flex-1 bg-transparent px-2 text-[14px] text-paper outline-none placeholder:text-mist-dim" />
            <button type="submit" disabled={busy || !task.trim()} className="press flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-brand px-3 text-[13px] font-medium text-on-brand disabled:opacity-40" aria-label="交给 Agent 查证"><span className="hidden sm:inline">交给 Agent</span><ArrowUp className="h-4 w-4" aria-hidden /></button>
          </div>
        </form>
        <div className="mt-3 grid gap-2 md:grid-cols-3" aria-label="可以交给 Agent 的任务">
          {examples.map((question) => <button key={question} type="button" disabled={busy} onClick={() => onAsk(question)} className="press min-h-11 rounded-lg border border-line-soft bg-raise-soft px-3 py-2 text-left text-[12px] leading-relaxed text-paper hover:border-brand/40 disabled:opacity-50">{question}</button>)}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-mist-dim">只围绕面试证据查证；证据不足不代表能力不达标。终评分数和提交由面试官完成。</p>
        {first && next ? (
          <details className="mt-4 border-t border-line-soft pt-3">
            <summary className="cursor-pointer text-[12px] font-medium text-mist">查看三个阶段样例：定标、面评、下一轮准备</summary>
            <p className="mt-3 text-[12px] text-mist-dim">{directory.labelOf(first)}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                { title: '看岗位标准', desc: '维度与行为标准先由人确认。', action: () => onOpenStandard(first.jobId) },
                { title: `看第 ${first.round} 轮面评`, desc: '在面评里，点时间戳查原文。', action: () => onOpenInterview('draft', first.id) },
                { title: `看第 ${next.round} 轮准备`, desc: '看上一轮的缺口如何进入本轮追问。', action: () => onOpenInterview('prep', next.id) },
              ].map((item, index) => (
                <button key={item.title} type="button" onClick={item.action}
                  className="press group rounded-lg border border-line bg-ink-900 p-4 text-left hover:border-brand/40 hover:bg-brand/[0.04]">
                  <span className="flex items-center justify-between gap-2 text-[13px] font-medium text-paper">
                    <span><span className="num mr-2 text-brand">0{index + 1}</span>{item.title}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-mist-dim" aria-hidden />
                  </span>
                  <span className="mt-2 block text-[12px] leading-relaxed text-mist">{item.desc}</span>
                </button>
              ))}
            </div>
          </details>
        ) : (
          <p className="mt-3 text-[12px] leading-relaxed text-mist-dim">
            {interviews.loading ? '正在读取样例面试…' : '当前没有可串联的两轮面试，可从下方待办或页面导航继续。'}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] leading-relaxed text-mist-dim">共享样例会随操作变化；看板数字用于展示口径，尚未经过客户试点验证。</p>
          <a href="/landing.html#faq" className="text-[12px] text-mist underline underline-offset-4 hover:text-paper">了解产品边界与验证方式</a>
        </div>
      </div>
    </section>
  );
}
