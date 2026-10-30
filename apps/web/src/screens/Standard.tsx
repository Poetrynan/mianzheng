import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Award,
  ChevronDown,
  FileCheck,
  MessageSquare,
  Scale,
  User,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useLoader, useSession } from '../session';
import type { AgentRun, JobStandard, StandardDimension } from '../api/types';
import { AgentTrace } from '../AgentTrace';
import {
  Badge,
  Btn,
  Empty,
  ErrorNote,
  Field,
  Loading,
  OkNote,
  Panel,
  Select,
  STANDARD_LABEL,
  WorkflowStepper,
  cx,
} from '../ui';

const toLines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const fromLines = (list: string[]) => list.join('\n');

type NoteKey = 'interview' | 'talk' | 'conflict' | 'dims' | 'sign';
const GUARD_SECTION: Record<string, NoteKey> = {
  开始访谈: 'interview',
  记录回答: 'interview',
  提取草稿: 'dims',
  保存维度: 'dims',
  确认维度: 'dims',
  裁定冲突: 'conflict',
  用人经理签署: 'sign',
  'HR 签署': 'sign',
  定稿: 'sign',
};
const sectionOf = (label: string): NoteKey => GUARD_SECTION[label] ?? 'interview';

interface EditState {
  name: string;
  positiveEvidence: string;
  redFlags: string;
  probes: string;
  matchKeywords: string;
}

function editOf(dim: StandardDimension): EditState {
  return {
    name: dim.name,
    positiveEvidence: fromLines(dim.positiveEvidence),
    redFlags: fromLines(dim.redFlags),
    probes: fromLines(dim.probes),
    matchKeywords: dim.matchKeywords.join('、'),
  };
}

export function StandardScreen({ focusJobId = '' }: { focusJobId?: string }) {
  const { org, me } = useSession();
  const orgId = org?.id ?? '';
  const jobs = useLoader(() => api.listJobs(orgId), [orgId]);

  const [jobId, setJobId] = useState(focusJobId);
  const [painPoints, setPainPoints] = useState('');
  const [standard, setStandard] = useState<JobStandard | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<NoteKey, { err: string | null; ok: string | null }>>({
    interview: { err: null, ok: null },
    talk: { err: null, ok: null },
    conflict: { err: null, ok: null },
    dims: { err: null, ok: null },
    sign: { err: null, ok: null },
  });
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [stage, setStage] = useState<1 | 2 | 3 | 4>(1);
  /** 首屏先把标准读完再画步骤，否则会先闪一帧「0 轮 / 0/0」再跳到定稿页。 */
  const [booting, setBooting] = useState(true);
  const [openDim, setOpenDim] = useState<string | null>(null);
  const stageFor = useRef('');

  const job = useMemo(() => (jobs.data ?? []).find((x) => x.id === jobId) ?? null, [jobs.data, jobId]);
  const confirmedCount = standard?.dimensions.filter((d) => d.confirmedBy).length ?? 0;

  const setNote = (key: NoteKey, patch: { err?: string | null; ok?: string | null }) =>
    setNotes((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const guard = async (label: string, fn: () => Promise<unknown>, done: string) => {
    const where = sectionOf(label);
    setPending(label);
    setNote(where, { err: null, ok: null });
    try {
      await fn();
      setNote(where, { ok: done });
    } catch (err) {
      setNote(where, { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  const startInterview = () =>
    void guard(
      '开始访谈',
      async () => {
        if (!job) throw new Error('先在上方选择一个岗位');
        const bundle = await api.agent.startStandard(job.id, {
          jobTitle: job.title,
          level: job.level ?? '未填职级',
          reportsTo: job.reportsTo ?? '未填',
          teamSize: job.teamSize ?? 0,
          painPoints: painPoints.trim() || job.description.slice(0, 40),
          description: job.description,
        });
        setRun(bundle.run);
        setStandard(bundle.standard ?? null);
        setEdits(bundle.standard ? Object.fromEntries(bundle.standard.dimensions.map((d) => [d.id, editOf(d)])) : {});
      },
      '访谈已开始，第一个问题已经问出来了。',
    );

  /** One answer goes straight back into the same loop; the agent decides what to ask next. */
  const answerStandard = async (text: string) => {
    if (!run) return;
    setPending('回答');
    setNote('talk', { err: null, ok: null });
    try {
      const bundle = await api.agent.answer(run.id, text);
      setRun(bundle.run);
      if (bundle.standard) {
        setStandard(bundle.standard);
        setEdits(Object.fromEntries(bundle.standard.dimensions.map((d) => [d.id, editOf(d)])));
      }
    } catch (err) {
      setNote('talk', { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  const reloadStandard = async () => {
    if (!standard) return;
    setStandard(await api.getStandard(standard.id));
  };

  const resumeStandard = async (id: string) => {
    setPending('载入金标准');
    setNote('interview', { err: null, ok: null });
    try {
      if (!id) {
        setStandard(null);
        setRun(null);
        setEdits({});
        return;
      }
      const list = await api.listStandards(id);
      const latest = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
      const runs = await api.agent.runsForJob(id);
      const active = [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
      const bundle = active ? await api.agent.run(active.id) : null;
      const shown = bundle?.standard ?? latest;
      setRun(bundle?.run ?? null);
      setStandard(shown);
      setEdits(shown ? Object.fromEntries(shown.dimensions.map((d) => [d.id, editOf(d)])) : {});
      if (shown) {
        setNote('interview', {
          ok: `已载入：${shown.answers.length} 轮回答 · ${shown.dimensions.length} 个维度 · ${STANDARD_LABEL[shown.status]}`,
        });
      }
    } catch (err) {
      setNote('interview', { err: messageOf(err) });
    } finally {
      setPending(null);
    }
  };

  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || jobId) return;
    const first = jobs.data?.[0];
    if (!first) return;
    autoPicked.current = true;
    setJobId(first.id);
    void resumeStandard(first.id).finally(() => setBooting(false));
  }, [jobs.data, jobId]);

  /** 没有岗位时不存在“载入标准”这回事，直接落到选择页。 */
  useEffect(() => {
    if (!jobs.loading && (jobs.data?.length ?? 0) === 0) setBooting(false);
  }, [jobs.loading, jobs.data]);

  /** 从「今天」带着一个岗位进来时，直接载入这个岗位的标准，不让人再选一次。 */
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusJobId) return;
    focused.current = true;
    void resumeStandard(focusJobId).finally(() => setBooting(false));
  }, [focusJobId]);

  /** 载入另一份标准时，停在这份标准最该继续的一步；同一份标准刷新不抢当前阶段。 */
  useEffect(() => {
    if (!standard) {
      setStage(1);
      return;
    }
    if (stageFor.current === standard.id) return;
    stageFor.current = standard.id;
    const confirmed = standard.dimensions.filter((d) => d.confirmedBy).length;
    setStage(
      standard.status === 'confirmed'
        ? 4
        : standard.dimensions.length === 0
          ? 2
          : confirmed < standard.dimensions.length
            ? 3
            : 4,
    );
    setOpenDim(standard.dimensions.find((d) => !d.confirmedBy)?.id ?? null);
  }, [standard]);

  const saveDimension = (dim: StandardDimension) =>
    void guard(
      '保存维度',
      async () => {
        const e = edits[dim.id];
        if (!e || !standard) return;
        await api.reviseDimension(standard.id, dim.id, {
          name: e.name,
          positiveEvidence: toLines(e.positiveEvidence),
          redFlags: toLines(e.redFlags),
          probes: toLines(e.probes),
          matchKeywords: toLines(e.matchKeywords.replace(/,/g, '、')).flatMap((s) => s.split('、')).filter(Boolean),
        });
        await reloadStandard();
      },
      '维度已保存。',
    );

  if (booting) {
    return <Loading label="正在载入这个岗位的考察标准" rows={3} />;
  }

  return (
    <div className="grid gap-4">
      <div className="surface-2 p-4 sm:p-5">
        <WorkflowStepper
          current={stage}
          onSelect={(index) => setStage(index as 1 | 2 | 3 | 4)}
          steps={[
            { index: 1, label: '选择岗位', desc: '从岗位出发' },
            { index: 2, label: `访谈（${standard ? standard.answers.length : 0} 轮）`, desc: '问出真实标准' },
            { index: 3, label: `逐项确认（${confirmedCount}/${standard?.dimensions.length ?? 0}）`, desc: '人来看一遍' },
            { index: 4, label: '双方签署定稿', desc: '标准才生效' },
          ]}
        />

        {stage === 1 ? (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.2fr_auto] sm:items-end">
              <Select label="岗位" value={jobId} onChange={(v) => { setJobId(v); void resumeStandard(v); }}>
                <option value="">选择…</option>
                {(jobs.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} · {x.level ?? '未填职级'}（{x.confirmedStandardId ? '已定稿' : '未定稿'}）
                  </option>
                ))}
              </Select>
              <Field
                label="这次最想弄清的问题"
                value={painPoints}
                onChange={setPainPoints}
                placeholder="例：跨部门推进时，他到底能推动到什么程度"
              />
              <Btn
                variant="primary"
                className="min-w-[124px]"
                busy={pending === '开始访谈'}
                busyLabel="准备中…"
                disabled={pending !== null || !jobId || Boolean(standard)}
                disabledReason={
                  !jobId ? '先选一个岗位。' : standard ? '这个岗位的访谈已经开始了，点上方「访谈」继续。' : undefined
                }
                onClick={startInterview}
              >
                {standard ? '访谈已开始' : '开始访谈'}
              </Btn>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">
              助手一次只问一个问题，答案只用来整理考察维度；标准最后由用人经理和 HR 一起签署才生效。
            </p>
          </>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-paper">{job?.title ?? '这次访谈'}</p>
              <p className="mt-0.5 text-[12px] text-mist">
                {[
                  job?.level,
                  job?.reportsTo ? `汇报给${job.reportsTo}` : null,
                  standard ? `${standard.answers.length} 轮回答` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <Btn variant="quiet" onClick={() => setStage(1)}>
              换岗位
            </Btn>
          </div>
        )}
        <ErrorNote message={notes.interview.err} />
        <OkNote message={notes.interview.ok} />
      </div>

      {standard && stage === 2 ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
          <div className="grid gap-3">
            {run ? (
              <AgentTrace
                run={run}
                title="这场访谈是怎么问的"
                onAnswer={(text) => void answerStandard(text)}
                answering={pending === '回答'}
                error={notes.talk.err}
              />
            ) : (
              <Panel title="访谈已经结束" subtitle="这份标准是之前问出来的，回答都记在右边。" icon={MessageSquare}>
                <p className="text-[13px] leading-relaxed text-mist">
                  想补充回答，可以直接去「逐项确认」改维度，不需要重新访谈。
                </p>
              </Panel>
            )}

            <div className="surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="text-[12px] text-mist">
                {standard.dimensions.length > 0
                  ? `助手已经整理出 ${standard.dimensions.length} 个考察维度。`
                  : '再回答几轮，助手会整理出考察维度。'}
              </span>
              <Btn
                variant="primary"
                disabled={standard.dimensions.length === 0}
                disabledReason="助手还没有整理出考察维度，再回答两轮。"
                onClick={() => setStage(3)}
              >
                去逐项确认
              </Btn>
            </div>
          </div>

          <Panel
            title={`访谈记录（${standard.answers.length} 轮）`}
            subtitle="每一轮都来自你的原话；助手只负责追问，不替你定标准。"
            icon={MessageSquare}
            right={<Badge tone="idle">{standard.answers.length} 轮</Badge>}
          >
            {standard.answers.length === 0 ? (
              <Empty text="回答第一个问题后，这里会留下记录。" />
            ) : (
              <div className="flex max-h-[560px] flex-col overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {standard.answers.map((a, i) => (
                  <div key={`${a.question}-${i}`} className="border-b border-line-soft/70 py-2.5 last:border-0 first:pt-0">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="num font-medium text-mist-dim">{i + 1}</span>
                      <span className="font-medium text-paper">{a.question}</span>
                    </div>
                    <p className="mt-1.5 border-l border-line pl-3 text-[13px] leading-relaxed text-mist">{a.answer}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {standard && stage === 3 ? (
        <div className="grid gap-4">
          {standard.conflicts.filter((c) => c.resolved === null).length > 0 ? (
            <Panel
              title="和原来的岗位描述不一致"
              subtitle="访谈里问出来的要求，和原岗位描述有出入。以哪边为准，需要招聘负责人来定。"
              icon={AlertTriangle}
              tone="danger"
            >
              {standard.conflicts.map((c) => (
                <div key={c.dimensionId} className="inset mb-2 p-3">
                  <p className="text-[13px] font-medium leading-relaxed text-paper">{c.note}</p>
                  {c.resolved ? (
                    <div className="mt-2">
                      <Badge tone="ok">已裁定：{c.resolved === 'keep_standard' ? '保留金标准' : '保留职位描述'}</Badge>
                    </div>
                  ) : (
                    <div className="mt-2 flex gap-2">
                      {(['keep_standard', 'keep_job_description'] as const).map((side) => (
                        <Btn
                          key={side}
                          disabled={pending !== null || me?.role !== 'hr'}
                          disabledReason={me?.role === 'hr' ? undefined : '冲突由招聘负责人裁定。'}
                          onClick={() =>
                            void guard('裁定冲突', async () => {
                              await api.resolveConflict(standard.id, c.dimensionId, side);
                              await reloadStandard();
                            }, '冲突已裁定')
                          }
                        >
                          {side === 'keep_standard' ? '以这次访谈为准' : '以原岗位描述为准'}
                        </Btn>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {me?.role !== 'hr' ? <p className="text-[12px] text-warn">当前身份不是 HR，仅 HR 拥有裁定权限。</p> : null}
              <ErrorNote message={notes.conflict.err} />
              <OkNote message={notes.conflict.ok} />
            </Panel>
          ) : null}

          <Panel
            title={`考察维度（${standard.dimensions.length} 个）`}
            subtitle="每个维度都要有值得看的表现、需要警惕的信号和追问建议。逐项展开看，确认过的会折起来。"
            icon={Award}
            right={
              <Badge tone={confirmedCount === standard.dimensions.length && standard.dimensions.length > 0 ? 'ok' : 'warn'}>
                已确认 {confirmedCount}/{standard.dimensions.length}
              </Badge>
            }
          >
            <ErrorNote message={notes.dims.err} />
            <OkNote message={notes.dims.ok} />
            {standard.dimensions.length === 0 ? (
              <Empty text="助手整理出考察维度后，会显示在这里等你逐项确认。" />
            ) : null}

            <div className="flex flex-col gap-2">
              {standard.dimensions.map((dim, idx) => {
                const e = edits[dim.id] ?? editOf(dim);
                const setE = (patch: Partial<EditState>) =>
                  setEdits((prev) => ({ ...prev, [dim.id]: { ...e, ...patch } }));
                const isConfirmed = Boolean(dim.confirmedBy);
                const open = openDim === dim.id;

                return (
                  <div key={dim.id} className={cx('p-3 transition', isConfirmed ? 'inset-ok' : 'inset')}>
                    <div className="flex items-center gap-2">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-brand/15 text-[12px] font-bold text-brand">
                        {idx + 1}
                      </span>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenDim(open ? null : dim.id)}
                        className="press min-w-0 flex-1 rounded px-1 py-0.5 text-left"
                      >
                        <span className="block truncate text-[13px] font-medium text-paper">{e.name}</span>
                        <span className="mt-0.5 block text-[11px] text-mist-dim">
                          {toLines(e.positiveEvidence).length} 条值得看 · {toLines(e.redFlags).length} 条警惕信号 ·{' '}
                          {toLines(e.probes).length} 条追问
                        </span>
                      </button>
                      <Badge tone={isConfirmed ? 'ok' : 'warn'}>{isConfirmed ? '已确认' : '待确认'}</Badge>
                      <ChevronDown
                        className={cx('h-4 w-4 shrink-0 text-mist-dim transition', open && 'rotate-180')}
                        aria-hidden
                      />
                    </div>

                    {open ? (
                      <div className="mt-3 border-t border-line-soft pt-3">
                        <Field label="维度名称" value={e.name} onChange={(v) => setE({ name: v })} />

                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Field
                            label="值得看的表现"
                            multiline
                            rows={3}
                            value={e.positiveEvidence}
                            onChange={(v) => setE({ positiveEvidence: v })}
                          />
                          <Field
                            label="需要警惕的信号"
                            multiline
                            rows={3}
                            value={e.redFlags}
                            onChange={(v) => setE({ redFlags: v })}
                          />
                        </div>

                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Field
                            label="追问建议"
                            multiline
                            rows={3}
                            value={e.probes}
                            onChange={(v) => setE({ probes: v })}
                          />
                          <Field
                            label="匹配关键词（顿号分隔）"
                            value={e.matchKeywords}
                            onChange={(v) => setE({ matchKeywords: v })}
                          />
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2">
                          <Btn disabled={pending !== null} onClick={() => saveDimension(dim)}>
                            保存修改
                          </Btn>
                          <Btn
                            variant={isConfirmed ? 'secondary' : 'primary'}
                            className="min-w-[132px]"
                            disabled={pending !== null || isConfirmed}
                            disabledReason={isConfirmed ? '这一项已经确认过了。' : undefined}
                            onClick={() =>
                              void guard('确认维度', async () => {
                                await api.confirmDimension(standard.id, dim.id);
                                await reloadStandard();
                                setOpenDim(standard.dimensions.find((d) => d.id !== dim.id && !d.confirmedBy)?.id ?? null);
                              }, '已确认这一项。')
                            }
                          >
                            {isConfirmed ? '已确认' : '确认这一项'}
                          </Btn>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Panel>

          <div className="surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="text-[12px] text-mist">
              已确认 <span className="num font-medium text-paper">{confirmedCount}</span> /{' '}
              {standard.dimensions.length} 个维度
            </span>
            <Btn
              variant="primary"
              disabled={standard.dimensions.length === 0}
              disabledReason="还没有考察维度。"
              onClick={() => setStage(4)}
            >
              去签署定稿
            </Btn>
          </div>
        </div>
      ) : null}

      {standard && stage === 4 ? (
        <Panel
          title="双方确认与定稿"
          subtitle="用人经理和 HR 都签署后，考察标准才会生效。"
          icon={Scale}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={standard.confirmedByHiringManager ? 'ok' : 'idle'}>
              用人经理：{standard.confirmedByHiringManager ? '已签署' : '待签署'}
            </Badge>
            <Badge tone={standard.confirmedByHr ? 'ok' : 'idle'}>
              HR 审核：{standard.confirmedByHr ? '已签署' : '待签署'}
            </Badge>
            <Badge tone={confirmedCount === standard.dimensions.length && standard.dimensions.length > 0 ? 'ok' : 'warn'}>
              维度全确认：{confirmedCount}/{standard.dimensions.length}
            </Badge>
            <Badge tone={standard.status === 'confirmed' ? 'ok' : 'info'}>
              版本：{STANDARD_LABEL[standard.status]} · {standard.version}
            </Badge>
          </div>

          {standard.dimensions.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-1.5 border-t border-line-soft pt-3">
              {standard.dimensions.map((dim, i) => (
                <li key={dim.id} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate text-mist">
                    {i + 1}. {dim.name}
                  </span>
                  <Badge tone={dim.confirmedBy ? 'ok' : 'warn'}>{dim.confirmedBy ? '已确认' : '待确认'}</Badge>
                </li>
              ))}
            </ul>
          ) : null}

          {standard.status === 'confirmed' ? (
            <p className="mt-4 rounded-lg border border-ok/25 bg-ok/[0.05] px-3 py-2 text-[12px] leading-relaxed text-tint-ok">
              双方都已签署，这份标准已经定稿生效，排面试和准备都会按它来查。
            </p>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                <Btn
                  disabled={pending !== null || me?.role !== 'hiring_manager' || Boolean(standard.confirmedByHiringManager)}
                  disabledReason={
                    standard.confirmedByHiringManager
                      ? '用人经理已经签过。'
                      : me?.role !== 'hiring_manager'
                        ? '这一步由用人经理签署。'
                        : undefined
                  }
                  onClick={() =>
                    void guard('用人经理签署', async () => {
                      await api.sign(standard.id, 'hiring_manager');
                      await reloadStandard();
                    }, '用人经理已签署')
                  }
                  icon={User}
                >
                  以用人经理身份签署
                </Btn>
                <Btn
                  disabled={pending !== null || me?.role !== 'hr' || Boolean(standard.confirmedByHr)}
                  disabledReason={
                    standard.confirmedByHr ? 'HR 已经签过。' : me?.role !== 'hr' ? '这一步由招聘负责人签署。' : undefined
                  }
                  onClick={() =>
                    void guard('HR 签署', async () => {
                      await api.sign(standard.id, 'hr');
                      await reloadStandard();
                    }, 'HR 已签署')
                  }
                  icon={Users}
                >
                  以 HR 身份签署
                </Btn>
                <Btn
                  variant="primary"
                  disabled={
                    pending !== null ||
                    standard.dimensions.length === 0 ||
                    !standard.confirmedByHiringManager ||
                    !standard.confirmedByHr ||
                    confirmedCount < standard.dimensions.length
                  }
                  disabledReason={
                    standard.dimensions.length === 0
                      ? '还没有考察维度。'
                      : !standard.confirmedByHiringManager || !standard.confirmedByHr
                        ? '两方都签署后才能定稿。'
                        : confirmedCount < standard.dimensions.length
                          ? '还有维度没有逐项确认。'
                          : undefined
                  }
                  onClick={() =>
                    void guard('定稿', async () => {
                      await api.finalize(standard.id);
                      await reloadStandard();
                    }, '考察标准已定稿，可以去排面试了。')
                  }
                  icon={FileCheck}
                >
                  定稿考察标准
                </Btn>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">
                双方签署后「定稿」才会解锁；演示工作区可以在左侧切换身份完成签署。
              </p>
            </>
          )}
          <ErrorNote message={notes.sign.err} />
          <OkNote message={notes.sign.ok} />
        </Panel>
      ) : null}
    </div>
  );
}
