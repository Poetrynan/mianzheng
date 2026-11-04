import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Loader2, Sparkles, X } from 'lucide-react';
import { api } from './api/client';
import type { AgentRun, AssistantProposal, AssistantTurn } from './api/types';
import { messageOf, useLoader } from './session';
import { Badge, cx } from './ui';
import { DecisionNote, KIND_ICON, decisionOf } from './AgentTrace';

type NavTab = 'prep' | 'draft' | 'board' | 'results';

interface Turn {
  id: string;
  question: string;
  run: AgentRun | null;
  error: string | null;
}

const POLL_MS = 600;
/** Steps land in the same tick in sample mode; reveal them one by one so the loop is readable. */
const REVEAL_MS = 320;

function candidateOf(label: string | null): string | null {
  const name = label?.split(' · ')[0]?.trim();
  return name && name.length <= 8 ? name : null;
}

function suggestions(focusLabel: string | null): string[] {
  const name = candidateOf(focusLabel) ?? '张伟';
  return [`${name}哪几个维度还没有证据？`, `帮我准备${name}下一轮的追问`, `${name}提到过「分库分表」吗？`, '还有谁的面评没交？'];
}

/**
 * 「问面证」：一个贴在右侧的查证 agent。一句话进去，能看到它每一步查了什么、为什么这么查，
 * 最后给出有出处的回答；会改数据的事只给建议按钮，由人点了才做。
 */
export function AssistantDrawer({
  focusInterviewId,
  focusLabel,
  onNavigate,
}: {
  focusInterviewId: string | null;
  focusLabel: string | null;
  onNavigate: (tab: NavTab, interviewId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const health = useLoader(() => api.health(), []);
  const sample = health.data?.llmDriver === 'mock';
  const busy = turns.some((t) => t.run?.status === 'running' || (!t.run && !t.error));

  // ⌘K / Ctrl+K 打开，Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const patch = useCallback((id: string, next: Partial<Turn>) => {
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }, []);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = `t${Date.now()}`;
    const history: AssistantTurn[] = turns
      .filter((t) => t.run?.result?.summary)
      .slice(-3)
      .flatMap((t) => [
        { role: 'user' as const, text: t.question },
        { role: 'assistant' as const, text: t.run!.result!.summary },
      ]);
    setTurns((list) => [...list, { id, question: q, run: null, error: null }]);
    setText('');
    try {
      let { run } = await api.agent.ask(q, focusInterviewId, history);
      patch(id, { run });
      while (run.status === 'running') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        run = (await api.agent.run(run.id)).run;
        patch(id, { run });
      }
    } catch (err) {
      patch(id, { error: messageOf(err) });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  const act = async (p: AssistantProposal) => {
    if (p.kind === 'run_prep' && p.interviewId) {
      setActing(p.label);
      try {
        await api.agent.prep(p.interviewId);
        onNavigate('prep', p.interviewId);
        setOpen(false);
      } catch (err) {
        setTurns((list) => [...list, { id: `e${Date.now()}`, question: p.label, run: null, error: messageOf(err) }]);
      } finally {
        setActing(null);
      }
      return;
    }
    const tab: NavTab = p.kind === 'open_prep' ? 'prep' : p.kind === 'open_draft' ? 'draft' : p.kind === 'open_board' ? 'board' : 'results';
    onNavigate(tab, p.interviewId);
    setOpen(false);
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="assistant-launcher press fixed bottom-5 right-5 z-40 flex min-h-12 items-center gap-2 rounded-full px-5 text-[14px] font-semibold text-on-brand max-lg:bottom-20 max-lg:right-4"
          aria-label="打开问面证（Ctrl+K）"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          问面证
          <kbd className="ml-1 hidden rounded-md bg-white/20 px-1.5 py-0.5 text-[11px] font-medium lg:inline">Ctrl K</kbd>
        </button>
      ) : null}

      {open ? (
        <aside
          role="dialog"
          aria-label="问面证"
          className="assistant-panel fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line-soft sm:w-[440px]"
        >
          <header className="flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/12 text-tint-brand">
                  <Sparkles className="h-4 w-4" aria-hidden />
                </span>
                <h2 className="text-[16px] font-semibold text-paper">问面证</h2>
                {sample ? <Badge tone="idle">样例模式</Badge> : health.data ? <Badge tone="ai">{health.data.llmDriver === 'openai-compatible' ? '真实模型' : health.data.llmDriver}</Badge> : null}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-mist">
                说出你想知道什么，它自己决定查哪里、查几次。只读，不替你下结论。
              </p>
              {focusLabel ? (
                <p className="mt-1.5 truncate text-[12px] text-mist-dim">
                  当前面试：<span className="text-paper">{focusLabel}</span>
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="press grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mist hover:bg-raise hover:text-paper"
              aria-label="关闭问面证"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4" aria-live="polite">
            {turns.length === 0 ? (
              <div>
                <p className="text-[13px] leading-relaxed text-mist">可以这样问：</p>
                <div className="mt-2 flex flex-col gap-2">
                  {suggestions(focusLabel).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void ask(s)}
                      className="press rounded-xl border border-line-soft bg-raise-soft px-3 py-2.5 text-left text-[13px] text-paper hover:border-brand/40 hover:bg-brand/[0.05]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {sample ? (
                  <p className="mt-4 rounded-xl border border-dashed border-line px-3 py-2.5 text-[12px] leading-relaxed text-mist-dim">
                    演示环境没有接真实模型：查询、调工具、核对数据都是真的，但「下一步查什么」由样例规则推理，每一步都标着「样例推理」。接上模型后会显示「模型决定」。
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                {turns.map((turn) => (
                  <TurnView key={turn.id} turn={turn} acting={acting} onAct={(p) => void act(p)} />
                ))}
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="border-t border-line-soft px-4 py-3">
            <div className="flex items-end gap-2 rounded-2xl border border-line bg-[var(--field-bg)] p-2 focus-within:border-brand/50">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void ask(text);
                  }
                }}
                rows={1}
                maxLength={500}
                placeholder="例如：张伟一面哪几维没证据？"
                aria-label="向问面证提问"
                className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-relaxed text-paper outline-none placeholder:text-mist-dim"
              />
              <button
                type="submit"
                disabled={busy || text.trim().length === 0}
                className="press grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-on-brand disabled:opacity-40"
                aria-label="发送"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[12px] text-mist-dim">Enter 发送 · Shift+Enter 换行 · Esc 关闭</p>
          </form>
        </aside>
      ) : null}
    </>
  );
}

function TurnView({ turn, acting, onAct }: { turn: Turn; acting: string | null; onAct: (p: AssistantProposal) => void }) {
  const run = turn.run;
  const steps = (run?.steps ?? []).filter((s) => s.kind !== 'stop');
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= steps.length) return;
    const t = window.setTimeout(() => setShown((n) => n + 1), REVEAL_MS);
    return () => window.clearTimeout(t);
  }, [shown, steps.length]);

  const revealing = shown < steps.length;
  const finished = run && run.status !== 'running' && !revealing;

  return (
    <div>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-on-brand">{turn.question}</p>
      </div>

      <div className="mt-3">
        {steps.length > 0 ? (
          <ol className="flex flex-col gap-1.5 border-l-2 border-brand/20 pl-3">
            {steps.slice(0, shown).map((step) => {
              const Icon = KIND_ICON[step.kind];
              const decision = decisionOf(step);
              return (
                <li key={step.index} className="assistant-step">
                  <div className="flex items-start gap-2">
                    <span className={cx('mt-[1px] grid h-5 w-5 shrink-0 place-items-center rounded-md', step.ok ? 'bg-brand/12 text-tint-brand' : 'bg-warn/14 text-tint-warn')}>
                      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium leading-snug text-paper">{step.label}</p>
                      {step.detail ? <p className="mt-0.5 text-[12px] leading-relaxed text-mist">{step.detail}</p> : null}
                      {decision ? <DecisionNote decision={decision} /> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}

        {!turn.error && (!run || run.status === 'running' || revealing) ? (
          <p className="mt-2 flex items-center gap-2 pl-3 text-[12px] text-mist">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-tint-brand" aria-hidden />
            {steps.length === 0 ? '在想先查什么…' : '继续查…'}
          </p>
        ) : null}

        {finished && run.status === 'completed' && run.result ? (
          <div className="assistant-step mt-3 rounded-2xl rounded-tl-md border border-line-soft bg-raise-soft px-4 py-3">
            <p className="whitespace-pre-wrap text-[14px] leading-[1.85] text-paper">{run.result.summary}</p>
            {run.result.proposals && run.result.proposals.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-line-soft pt-3">
                {run.result.proposals.map((p) => (
                  <button
                    key={`${p.kind}-${p.interviewId ?? ''}`}
                    type="button"
                    disabled={acting !== null}
                    onClick={() => onAct(p)}
                    className={cx(
                      'press rounded-lg px-3 py-2 text-[12px] font-medium disabled:opacity-50',
                      p.kind === 'run_prep' ? 'bg-brand text-on-brand' : 'border border-line bg-[var(--panel-bg)] text-paper hover:border-brand/40',
                    )}
                  >
                    {acting === p.label ? '处理中…' : p.label}
                    {p.kind === 'run_prep' ? <span className="ml-1 opacity-75">· 需你确认</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[12px] text-mist-dim">
              {steps.length} 步 · {run.llm.driver === 'mock' ? '样例推理' : run.llm.model}
            </p>
          </div>
        ) : null}

        {finished && run.status !== 'completed' ? (
          <p className="mt-3 rounded-xl border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[13px] text-tint-warn">
            {run.stopReason ?? '这次没能完成，换个说法再问一次试试。'}
          </p>
        ) : null}

        {turn.error ? (
          <p className="mt-3 rounded-xl border border-bad/30 bg-bad/[0.06] px-3 py-2 text-[13px] text-tint-bad">{turn.error}</p>
        ) : null}
      </div>
    </div>
  );
}
