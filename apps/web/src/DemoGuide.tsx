import { ArrowRight, BookOpen } from 'lucide-react';
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
}: {
  directory: Directory;
  onOpenInterview: (tab: 'prep' | 'draft', interviewId: string) => void;
  onOpenStandard: (jobId: string) => void;
}) {
  const { me, interviews } = useSession();
  const isDemo = DEMO_EMAILS.has(me?.email ?? '');
  const health = useLoader(isDemo ? () => api.health() : async () => null, [isDemo]);
  if (!isDemo) return null;

  const all = interviews.data ?? [];
  const first = [...all]
    .sort((a, b) => a.round - b.round || a.scheduledAt.localeCompare(b.scheduledAt))
    .find((it) => it.status === 'eval_submitted' && all.some((next) =>
      next.candidateId === it.candidateId && next.jobId === it.jobId && next.round > it.round));
  const next = first ? [...all]
    .filter((it) => it.candidateId === first.candidateId && it.jobId === first.jobId && it.round > first.round)
    .sort((a, b) => a.round - b.round)[0] : undefined;

  return (
    <section className="surface-2 overflow-hidden" aria-labelledby="demo-guide-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft bg-raise-soft px-4 py-2.5 sm:px-5">
        <span className="inline-flex items-center gap-2 text-[12px] font-medium text-mist">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          示例工作区 · 虚构数据
        </span>
        <Badge>{health.data?.llmDriver === 'mock' ? 'AI 使用固定样例输出' : '流程演示'}</Badge>
      </div>
      <div className="p-4 sm:p-5">
        <h2 id="demo-guide-title" className="text-[17px] font-semibold text-paper">先看这一轮，再看下一轮怎么接</h2>
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-mist">
          看同一位候选人：按什么标准评价、哪些判断有原话、哪些仍需核实。证据不足表示尚未核实，不代表能力不达标。
        </p>
        {first && next ? (
          <>
            <p className="mt-3 text-[12px] text-mist-dim">{directory.labelOf(first)}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                { title: '看岗位标准', desc: '维度与行为标准先由人确认。', action: () => onOpenStandard(first.jobId) },
                { title: `看第 ${first.round} 轮面评`, desc: '在面评里，点时间戳查原文。', action: () => onOpenInterview('draft', first.id) },
                { title: `看第 ${next.round} 轮准备`, desc: '看上一轮的缺口如何进入本轮追问。', action: () => onOpenInterview('prep', next.id) },
              ].map((item, index) => (
                <button key={item.title} type="button" onClick={item.action}
                  className="press group rounded-xl border border-line bg-raise-soft p-3 text-left transition-colors hover:border-line-hi hover:bg-raise">
                  <span className="flex items-center justify-between gap-2 text-[13px] font-medium text-paper">
                    <span><span className="num mr-2 text-mist-dim">0{index + 1}</span>{item.title}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-mist-dim" aria-hidden />
                  </span>
                  <span className="mt-2 block text-[12px] leading-relaxed text-mist">{item.desc}</span>
                </button>
              ))}
            </div>
          </>
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
