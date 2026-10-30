import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FileCheck, FileText, Lock, Quote, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useDirectory, useLoader, useSession } from '../session';
import type { AgentRun, ScoreLevel } from '../api/types';
import { AgentTrace } from '../AgentTrace';
import {
  Badge,
  Btn,
  CLAIM_REASON_LABEL,
  Check,
  Chip,
  DRAFT_LABEL,
  Empty,
  ErrorNote,
  Field,
  InterviewPill,
  Label,
  OkNote,
  Panel,
  SCORE_LABEL,
  ScoreRow,
  Segmented,
  StatStrip,
  Subhead,
  WorkflowStepper,
  clock,
  cx,
} from '../ui';

export function DraftScreen({
  interviewId,
  onPickInterview,
}: {
  interviewId: string;
  onPickInterview: (id: string) => void;
}) {
  const { org, users, interviews } = useSession();
  const orgId = org?.id ?? '';
  const dir = useDirectory(orgId);
  const drafts = useLoader(
    interviewId ? () => api.listDrafts(interviewId) : async () => ({ drafts: [], note: null }),
    [interviewId],
  );
  const [draftId, setDraftId] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { err: string | null; ok: string | null }>>({});
  const [recommendation, setRecommendation] = useState('');
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState({ fillUnscored: false, agreeUsedForDecision: false, anonymizeName: true });
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [activeCheckId, setActiveCheckId] = useState('');
  const defaultedFor = useRef('');

  const detail = useLoader(draftId ? () => api.draftDetail(draftId) : async () => null, [draftId]);
  const notice = useLoader(() => api.notice(), []);
  const agentRuns = useLoader(
    interviewId ? () => api.agent.runsForInterview(interviewId) : async () => [],
    [interviewId],
  );

  useEffect(() => {
    const latest =
      [...(agentRuns.data ?? [])]
        .filter((r) => r.phase === 'evaluation')
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
    setRun(latest);
  }, [agentRuns.data]);

  useEffect(() => {
    setRun(null);
  }, [interviewId]);

  const d = detail.data;
  const activeDraftId = draftId || (drafts.data?.drafts[0]?.id ?? '');

  useEffect(() => {
    if (!draftId && drafts.data && drafts.data.drafts.length > 0) setDraftId(drafts.data.drafts[0]?.id ?? '');
  }, [drafts.data, draftId]);

  useEffect(() => {
    if (!d) return;
    setRecommendation(d.draft.humanRecommendation ?? '');
    const next: Record<string, string> = {};
    for (const c of d.draft.checks) next[c.id] = c.finalSummary ?? '';
    setSummaries(next);
  }, [d]);

  /** 换一份面评时，把工作台停在这份草稿最该继续的那一步；同一份草稿刷新不抢当前步骤。 */
  if (d && defaultedFor.current !== d.draft.id) {
    defaultedFor.current = d.draft.id;
    setStep(d.draft.status === 'submitted' ? 3 : d.draft.checks.length === 0 ? 1 : 2);
    setActiveCheckId(d.draft.checks.find((c) => !c.finalScore)?.id ?? d.draft.checks[0]?.id ?? '');
    setOpenCheck(null);
  }

  const evidenceByCheck = useMemo(() => new Map((d?.evidence ?? []).map((e) => [e.checkId, e])), [d]);

  const setNote = (key: string, patch: { err?: string | null; ok?: string | null }) =>
    setNotes((prev) => ({ ...prev, [key]: { ...prev[key], err: null, ok: null, ...patch } }));
  const noteOf = (key: string) => ({ err: notes[key]?.err ?? null, ok: notes[key]?.ok ?? null });

  const nameOf = (userId: string) => users.find((u) => u.id === userId)?.name ?? '未署名面试官';

  const guard = async (label: string, fn: () => Promise<unknown>, done: string, key?: string) => {
    const slot = key ?? label;
    setPending(label);
    setNote(slot, {});
    try {
      await fn();
      setNote(slot, { ok: done });
      drafts.reload();
      detail.reload();
      interviews.reload();
    } catch (err) {
      setNote(slot, { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  const it = (interviews.data ?? []).find((x) => x.id === interviewId) ?? null;

  /** The agent reads the transcript dimension by dimension; whatever it cannot ground becomes a gap. */
  const startEvaluation = async () => {
    setPending('起草');
    setNote('起草', {});
    try {
      const bundle = await api.agent.evaluate(interviewId);
      setRun(bundle.run);
      if (bundle.draft) setDraftId(bundle.draft.id);
      setNote('起草', {
        ok:
          bundle.run.status === 'awaiting_human'
            ? '草稿已生成，有缺口等你决定怎么处理。'
            : '草稿已生成，请逐条看原话、给出你的判断。',
      });
      drafts.reload();
      interviews.reload();
      agentRuns.reload();
    } catch (err) {
      setNote('起草', { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  const answerGap = async (answer: string) => {
    if (!run) return;
    setPending('处理缺口');
    setNote('缺口', {});
    try {
      const bundle = await api.agent.answer(run.id, answer);
      setRun(bundle.run);
      if (bundle.draft) setDraftId(bundle.draft.id);
      setNote('缺口', { ok: '已按你的选择处理。' });
      drafts.reload();
      agentRuns.reload();
    } catch (err) {
      setNote('缺口', { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  if (!interviewId) {
    const list = interviews.data ?? [];
    return (
      <Panel title="面评" subtitle="选一场已经结束的面试，开始整理面评。" icon={FileText}>
        <div className="flex flex-col gap-1.5">
          {list.length === 0 ? <Empty text="还没有面试" /> : null}
          {list.map((x) => (
            <Chip key={x.id} selected={false} onClick={() => onPickInterview(x.id)} right={<InterviewPill status={x.status} />}>
              {dir.labelOf(x)}
            </Chip>
          ))}
        </div>
      </Panel>
    );
  }

  const isSubmitted = d?.draft.status === 'submitted';
  const checks = d?.draft.checks ?? [];
  const scored = checks.filter((c) => c.finalScore).length;
  const withEvidence = checks.filter((c) => (c.finalEvidence.length || c.aiEvidence.length) > 0).length;
  const draftList = drafts.data?.drafts ?? [];
  const activeCheck = checks.find((c) => c.id === activeCheckId) ?? checks[0] ?? null;
  const activeIndex = activeCheck ? checks.findIndex((c) => c.id === activeCheck.id) : -1;

  const goCheck = (offset: number) => {
    const next = checks[activeIndex + offset];
    if (!next) return;
    setActiveCheckId(next.id);
    setOpenCheck(null);
  };

  /** 灰着的按钮要说得清为什么灰着，而不是让人自己猜。 */
  const draftBlockedReason = !it
    ? '先在右上角选择一场面试。'
    : it.status === 'scheduled'
      ? '这场面试还没开始，结束后就可以起草。'
      : it.status === 'in_progress'
        ? '这场面试还在进行中，结束后就可以起草。'
        : it.status === 'audio_done'
          ? '这场面试的录音还在处理，稍后就可以起草。'
          : it.status === 'eval_submitted'
            ? '这场面试的面评已经提交。'
            : run?.status === 'awaiting_human'
              ? '草稿里还有问题等你回答，答完就能继续。'
              : null;

  return (
    <div className="grid gap-4">
      {d ? (
        <div className="surface-2 p-4 sm:p-5">
          <WorkflowStepper
            current={step}
            onSelect={(index) => setStep(index as 1 | 2 | 3)}
            steps={[
              { index: 1, label: '起草', desc: 'AI 先按考察标准整理原话' },
              { index: 2, label: `逐项确认（${scored}/${checks.length}）`, desc: '每一项由你终评' },
              { index: 3, label: '综合与提交', desc: '写意见并提交' },
            ]}
          />
        </div>
      ) : null}

      {step === 1 ? (
        <>
      <Panel
        title="面评工作台"
        subtitle={notice.data ? notice.data.aiLabel.cardBadge : 'AI 生成的草稿，需要面试官逐条确认'}
        icon={Sparkles}
        tone="ai"
        right={
          <Btn
            variant="primary"
            busy={pending === '起草'}
            busyLabel="起草中…"
            disabled={pending !== null || Boolean(draftBlockedReason)}
            disabledReason={draftBlockedReason ?? undefined}
            onClick={() => void startEvaluation()}
            icon={Sparkles}
          >
            让 AI 先起一稿
          </Btn>
        }
      >
        {draftList.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-mist-dim">谁的面评</span>
            {draftList.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setDraftId(x.id)}
                className={cx(
                  'press rounded-lg px-3 py-1.5 text-[12px]',
                  x.id === activeDraftId ? 'bg-brand/12 font-medium text-paper' : 'text-mist hover:bg-raise-soft hover:text-paper',
                )}
              >
                {nameOf(x.interviewerId)}
                <span className="ml-1.5 text-[11px] text-mist-dim">{DRAFT_LABEL[x.status]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="inset p-4">
            <p className="text-[13px] font-medium text-paper">本场还没有面评草稿</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-mist">
              {draftBlockedReason ?? '点右上角的「让 AI 先起一稿」，AI 会先按考察标准把原话整理一遍。'}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">
              草稿只引用对话原话，每一项的评分和结论仍然由你给出。
            </p>
          </div>
        )}

        {drafts.data?.note ? <p className="mt-3 text-[12px] leading-relaxed text-mist">{drafts.data.note}</p> : null}

        <ErrorNote message={noteOf('起草').err ?? drafts.error ?? detail.error} />
        <OkNote message={noteOf('起草').ok} />
      </Panel>

      {run ? (
        <AgentTrace
          run={run}
          title="这次面评是怎么查的"
          onAnswer={(answer) => void answerGap(answer)}
          answering={pending === '处理缺口'}
          error={noteOf('缺口').err}
        />
      ) : null}

      {d && d.draft.rejectedClaims.length > 0 ? (
        <details className="surface-2 group px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13px] text-mist">
            <span>有 {d.draft.rejectedClaims.length} 处推测没有找到原话，已略去</span>
            <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
          </summary>
          <ul className="mt-3 flex flex-col gap-1.5 border-t border-line-soft pt-3">
            {d.draft.rejectedClaims.map((c, i) => (
              <li key={`${c.claim}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                <span className="min-w-0 text-mist">{c.claim}</span>
                <span className="text-[11px] text-mist-dim">{CLAIM_REASON_LABEL[c.reason]}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
        </>
      ) : null}

      {d && step === 2 ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-paper">逐项确认</h2>
            <span className="text-[12px] text-mist-dim">先看 AI 起草的原话，再给出你的判断</span>
          </div>

          <div className="surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] text-mist">考察维度</span>
              <span className="text-[12px] text-mist-dim">
                已终评 <span className="num font-medium text-paper">{scored}</span> / {checks.length} · 有原话可查{' '}
                <span className="num font-medium text-paper">{withEvidence}</span> / {checks.length}
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5" role="tablist" aria-label="考察维度">
              {checks.map((check, idx) => {
                const on = check.id === activeCheck?.id;
                return (
                  <button
                    key={check.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => {
                      setActiveCheckId(check.id);
                      setOpenCheck(null);
                    }}
                    className={cx(
                      'press flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]',
                      on
                        ? 'border-brand/50 bg-brand/12 font-medium text-paper'
                        : 'border-line/60 bg-raise-soft text-mist hover:text-paper',
                    )}
                  >
                    <span className="num text-[11px] text-mist-dim">{idx + 1}</span>
                    <span className="max-w-[150px] truncate">{check.dimensionName}</span>
                    <span
                      aria-hidden
                      className={cx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        check.finalScore ? 'bg-ok' : check.aiScore ? 'bg-warn' : 'bg-line-field',
                      )}
                    />
                    <span className="sr-only">
                      {check.finalScore ? '已终评' : check.aiScore ? '待终评' : '没有原话'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {run?.status === 'awaiting_human' ? (
            <div className="callout callout-warn flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[12px] leading-relaxed text-tint-warn">
              <span>草稿里还有一个问题等你回答，答完这一稿才算完整。</span>
              <Btn variant="quiet" onClick={() => setStep(1)}>
                回到起草
              </Btn>
            </div>
          ) : null}

          <div className="flex flex-col gap-4">
            {checks.length === 0 ? <Empty text="这份草稿里没有需要确认的维度。" /> : null}
            {checks.map((check, idx) => {
              if (check.id !== activeCheck?.id) return null;
              const ev = evidenceByCheck.get(check.id);
              const open = openCheck === check.id;

              return (
                <Panel
                  key={check.id}
                  title={`${idx + 1}. ${check.dimensionName}`}
                  headingLevel={3}
                  icon={Quote}
                  right={
                    <Badge tone={check.finalScore ? 'human' : check.aiScore ? 'warn' : 'idle'}>
                      {check.finalScore ? '已终评' : check.aiScore ? '待你终评' : '没有原话'}
                    </Badge>
                  }
                >
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <Subhead as={4} className="mb-2 text-mist">
                        AI 的草稿
                      </Subhead>
                      <div className="inset-ai p-4">
                        <ScoreRow ai={check.aiScore} final={check.finalScore} />

                        <p className="mt-3 text-[13px] leading-relaxed text-paper">
                          {check.aiSummary ?? '这段对话里没有足够的原话支撑这一项。'}
                        </p>

                        {check.aiRedFlagHits.length > 0 ? (
                          <div className="mt-2 text-[12px] leading-relaxed text-tint-bad">
                            <span className="font-medium">需要留意：</span>
                            {check.aiRedFlagHits.join('；')}
                          </div>
                        ) : null}

                        <div className="mt-3">
                          <p className="mb-1.5 text-[12px] text-mist-dim">对话原话</p>
                          <div className="flex flex-col gap-2">
                            {(ev?.resolvedText ?? []).map((r) => (
                              <blockquote key={r.segmentId} className="border-l border-brand/40 pl-3">
                                <span className="num text-[11px] text-mist-dim">
                                  {clock(ev?.refs.find((x) => x.segmentId === r.segmentId)?.startMs ?? 0)}
                                </span>
                                <p className="mt-0.5 font-serif text-[14px] leading-[1.85] text-paper">
                                  {r.text ?? '（这段录音已到留存期限，文字已清理）'}
                                </p>
                              </blockquote>
                            ))}
                            {(ev?.resolvedText.length ?? 0) === 0 ? (
                              <p className="text-[12px] leading-relaxed text-mist-dim">
                                这一项没有直接引用的原话，可以依据你自己的提问和记录来判断。
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <Subhead as={4} className="mb-2 text-mist">
                        我的判断
                      </Subhead>
                      <div className="inset-human p-4">
                        <Segmented<ScoreLevel>
                          options={[
                            { id: 'high', label: SCORE_LABEL.high },
                            { id: 'medium', label: SCORE_LABEL.medium },
                            { id: 'low', label: SCORE_LABEL.low },
                          ]}
                          value={check.finalScore}
                          onChange={(level) =>
                            void guard(
                              '填分',
                              async () => {
                                await api.reviseCheck(d.draft.id, check.id, { finalScore: level });
                              },
                              `「${check.dimensionName}」已终评为：${SCORE_LABEL[level]}`,
                              `check:${check.id}`,
                            )
                          }
                          label={`${check.dimensionName} 的终评`}
                          disabled={pending !== null || isSubmitted}
                          disabledReason={isSubmitted ? '这份面评已经提交，不能再改。' : undefined}
                          full
                        />

                        <div className="mt-3">
                          <Field
                            label="判断依据"
                            multiline
                            rows={4}
                            value={summaries[check.id] ?? ''}
                            onChange={(v) => setSummaries((prev) => ({ ...prev, [check.id]: v }))}
                            placeholder="写下你基于对话事实的判断…"
                          />

                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <Btn
                              disabled={pending !== null || isSubmitted || (summaries[check.id] ?? '') === (check.finalSummary ?? '')}
                              disabledReason={
                                isSubmitted
                                  ? '这份面评已经提交，不能再改。'
                                  : (summaries[check.id] ?? '') === (check.finalSummary ?? '')
                                    ? '结论没有改动，不用保存。'
                                    : undefined
                              }
                              onClick={() =>
                                void guard(
                                  '保存结论',
                                  async () => {
                                    await api.reviseCheck(d.draft.id, check.id, {
                                      finalSummary: (summaries[check.id] ?? '').trim(),
                                    });
                                  },
                                  '你的判断已保存。',
                                  `check:${check.id}`,
                                )
                              }
                            >
                              保存这一项
                            </Btn>

                            <Btn variant="quiet" icon={ChevronDown} onClick={() => setOpenCheck(open ? null : check.id)}>
                              {open ? '收起原文' : '对照全文'}
                            </Btn>
                          </div>

                          <ErrorNote message={noteOf(`check:${check.id}`).err} />
                          <OkNote message={noteOf(`check:${check.id}`).ok} />
                        </div>

                        {open ? (
                          <div className="mt-3 max-h-60 overflow-y-auto rounded-xl bg-ink-1000/50 p-3 [scrollbar-gutter:stable]">
                            {d.transcript.map((seg) => (
                              <p key={seg.segmentId} className="mb-1.5 text-[12px] leading-relaxed">
                                <span className="num mr-1.5 text-mist-dim">{clock(seg.startMs)}</span>
                                <span className="text-paper">{seg.text}</span>
                              </p>
                            ))}
                            {d.transcript.length === 0 ? <p className="text-[12px] text-mist-dim">原文已到留存期限并清理。</p> : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Panel>
              );
            })}
          </div>

          <div className="surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <Btn disabled={activeIndex <= 0} disabledReason="已经是第一项。" onClick={() => goCheck(-1)}>
              上一项
            </Btn>
            <span className="num text-[12px] text-mist-dim">
              {activeIndex + 1} / {checks.length}
            </span>
            {activeIndex < checks.length - 1 ? (
              <Btn onClick={() => goCheck(1)}>下一项</Btn>
            ) : (
              <Btn variant="primary" onClick={() => setStep(3)}>
                去写综合意见
              </Btn>
            )}
          </div>
        </>
      ) : null}

      {d && step === 3 ? (
        <>
          <Panel title="综合意见" subtitle="这部分由你自由书写，AI 不替你做结论。" icon={FileText}>
            <Field
              label="你的推荐意见与后续建议"
              multiline
              rows={4}
              value={recommendation}
              onChange={setRecommendation}
              placeholder="例：建议进入终面。候选人在故障定位追问里能讲清自己的判断过程，也承认了当时判断失误。建议下一轮重点核实跨团队推动中的真实角色…"
            />
            <div className="mt-2">
              <Btn
                disabled={pending !== null || recommendation.trim().length < 2 || isSubmitted}
                disabledReason={
                  isSubmitted
                    ? '这份面评已经提交，不能再改。'
                    : recommendation.trim().length < 2
                      ? '先写下推荐意见。'
                      : undefined
                }
                onClick={() =>
                  void guard('保存推荐', () => api.setRecommendation(d.draft.id, recommendation.trim()), '推荐意见已保存。')
                }
              >
                保存推荐意见
              </Btn>
            </div>
            <ErrorNote message={noteOf('保存推荐').err} />
            <OkNote message={noteOf('保存推荐').ok} />
          </Panel>

          <Panel title="提交条件" icon={FileCheck} right={<Badge tone={isSubmitted ? 'ok' : 'warn'}>{isSubmitted ? '已提交' : '待你确认'}</Badge>}>
            <StatStrip
              className="lg:grid-cols-2"
              items={[
                { label: '已给出终评', value: `${scored} / ${checks.length}` },
                { label: '有原话可查', value: `${withEvidence} / ${checks.length}` },
              ]}
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Label>能不能交</Label>
              <span className={cx('text-[13px] font-medium', isSubmitted || d.requirements.ok ? 'text-tint-ok' : 'text-tint-warn')}>
                {isSubmitted ? '已提交' : d.requirements.ok ? '可以提交' : '还差一些内容'}
              </span>
            </div>

            {!isSubmitted && !d.requirements.ok ? (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {d.requirements.missing.map((m) => (
                  <li key={m} className="rounded-md border border-warn/25 bg-warn/[0.07] px-2 py-1 text-[12px] text-tint-warn">
                    {m}
                  </li>
                ))}
              </ul>
            ) : null}
            {isSubmitted && d.draft.acknowledgedGaps.length > 0 ? (
              <p className="mt-3 text-[12px] leading-relaxed text-mist">
                提交时有 {d.draft.acknowledgedGaps.length} 项没有终评，已按缺口如实留空：
                {d.draft.acknowledgedGaps.map((gap) => gap.split(' · ')[0]).join('、')}。
              </p>
            ) : null}
            {d.stale ? (
              <p className="mt-3 text-[12px] leading-relaxed text-mist">
                距面试结束已超过 24 小时。这份草稿仍然有效，随时可以继续修改。
              </p>
            ) : null}
            {d.draft.gapDisposition ? (
              <p className="mt-3 text-[12px] leading-relaxed text-mist">
                {d.draft.gapDisposition === 'carry_over'
                  ? '留了缺口的维度会带到下一轮，下一场一页纸会先补这些维度。'
                  : '留了缺口的维度只留在这场记录里，不带到下一轮。'}
              </p>
            ) : null}
          </Panel>

          <Panel title="提交" subtitle="提交后，这份面评会进入团队汇总，并停止提醒。" icon={Lock}>
            {isSubmitted ? (
              <div className="flex items-center gap-2 rounded-lg border border-ok/25 bg-ok/[0.05] p-4 text-[13px] leading-relaxed text-tint-ok">
                <FileCheck className="h-4 w-4 shrink-0" />
                <span>这份面评已提交，已进入团队汇总，提醒已停止。</span>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Check checked={confirm.fillUnscored} onChange={(v) => setConfirm({ ...confirm, fillUnscored: v })}>
                    允许未评分的维度如实留空提交
                  </Check>
                  <Check
                    checked={confirm.agreeUsedForDecision}
                    onChange={(v) => setConfirm({ ...confirm, agreeUsedForDecision: v })}
                  >
                    我已逐条复核，这份面评由我负责
                  </Check>
                  <Check
                    checked={confirm.anonymizeName}
                    onChange={(v) => setConfirm({ ...confirm, anonymizeName: v })}
                  >
                    在团队汇总里隐去候选人姓名
                  </Check>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Btn
                    variant="primary"
                    disabled={pending !== null || !confirm.agreeUsedForDecision}
                    disabledReason={confirm.agreeUsedForDecision ? undefined : '先勾上「这份面评由我负责」。'}
                    onClick={() => void guard('提交', () => api.submitDraft(d.draft.id, confirm), '面评已提交。')}
                    icon={FileCheck}
                  >
                    确认并提交
                  </Btn>
                  <span className="text-[12px] text-mist-dim">
                    {checks.filter((c) => !c.finalScore).length > 0
                      ? `还有 ${checks.filter((c) => !c.finalScore).length} 项没有终评。`
                      : '所有维度都已终评。'}
                  </span>
                </div>
              </>
            )}
            <ErrorNote message={noteOf('提交').err} />
            <OkNote message={noteOf('提交').ok} />
          </Panel>
        </>
      ) : null}
    </div>
  );
}
