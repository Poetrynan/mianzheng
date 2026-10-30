import { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  ClipboardList,
  Copy,
  FileCheck2,
  Filter,
  HelpCircle,
  History,
  Plus,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useDirectory, useLoader, useSession } from '../session';
import type { AgentRun, AlignmentMark, LedgerStatus } from '../api/types';
import { AgentTrace } from '../AgentTrace';
import {
  Badge,
  Btn,
  Chip,
  Empty,
  ErrorNote,
  Field,
  InterviewPill,
  Loading,
  OkNote,
  Panel,
  Segmented,
  Select,
  Subhead,
  fmtTime,
  useBottomFade,
} from '../ui';

const MARK: Record<AlignmentMark, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  matched: { label: '简历有对应经历', tone: 'ok' },
  needs_probe: { label: '需要追问确认', tone: 'warn' },
  weak: { label: '简历里看不出来', tone: 'bad' },
};

const LEDGER: Record<LedgerStatus, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  covered: { label: '已覆盖', tone: 'ok' },
  missing: { label: '没有原话', tone: 'warn' },
  unscored: { label: '没有终评', tone: 'warn' },
  contradicted: { label: '终评不达标', tone: 'bad' },
};

const LEDGER_DETAIL: Record<LedgerStatus, string> = {
  covered: '有原话，也已终评',
  missing: '没有找到原话',
  unscored: '有原话，但没有终评',
  contradicted: '有原话，终评不达标',
};

const LEDGER_RANK: Record<LedgerStatus, number> = { missing: 0, unscored: 1, contradicted: 2, covered: 3 };

export function PrepScreen({
  interviewId,
  onPickInterview,
}: {
  interviewId: string;
  onPickInterview: (id: string) => void;
}) {
  const { org, me, interviews } = useSession();
  const orgId = org?.id ?? '';
  const dir = useDirectory(orgId);
  const pack = useLoader(interviewId ? () => api.getPrepPack(interviewId) : async () => null, [interviewId]);
  const standard = useLoader(
    async () => {
      const it = (interviews.data ?? []).find((x) => x.id === interviewId);
      return it ? api.getStandard(it.standardId) : null;
    },
    [interviewId, interviews.data],
  );

  const [text, setText] = useState('');
  const [dimensionId, setDimensionId] = useState('');
  const [filterMark, setFilterMark] = useState<'all' | 'matched' | 'needs_probe' | 'weak'>('all');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);

  const it = (interviews.data ?? []).find((x) => x.id === interviewId) ?? null;
  const runs = useLoader(
    interviewId ? () => api.agent.runsForInterview(interviewId) : async () => [],
    [interviewId],
  );
  const ledger = useLoader(
    it ? () => api.ledger(it.candidateId, it.jobId) : async () => ({ entries: [] }),
    [it?.candidateId, it?.jobId],
  );

  useEffect(() => {
    const latest =
      [...(runs.data ?? [])]
        .filter((r) => r.phase === 'prep')
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
    setRun(latest);
  }, [runs.data]);

  useEffect(() => {
    setRun(null);
  }, [interviewId]);

  const guard = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setPending(label);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
      pack.reload();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  const data = pack.data;
  const dims = useMemo(() => standard.data?.dimensions ?? [], [standard.data]);
  const loadError = pack.error?.includes('还没有准备包') ? null : pack.error;

  const filteredAlignment = useMemo(() => {
    if (!data) return [];
    if (filterMark === 'all') return data.alignment;
    return data.alignment.filter((a) => a.mark === filterMark);
  }, [data, filterMark]);

  const ledgerEntries = useMemo(
    () =>
      [...(ledger.data?.entries ?? [])].sort(
        (a, b) => LEDGER_RANK[a.status] - LEDGER_RANK[b.status] || b.fromRound - a.fromRound,
      ),
    [ledger.data?.entries],
  );

  const { ref: ledgerRef, more: ledgerMoreBelow, sync: syncLedgerFade } = useBottomFade<HTMLDivElement>();
  const { ref: questionsRef, more: questionsMoreBelow, sync: syncQuestionsFade } = useBottomFade<HTMLDivElement>();

  if (!interviewId) {
    const list = interviews.data ?? [];
    return (
      <Panel
        title="一页纸准备"
        subtitle="选一场已经排好的面试，把考察标准和简历放在一起看。"
        icon={ClipboardList}
      >
        <div className="flex flex-col gap-1.5">
          {list.length === 0 ? <Empty text="还没有面试，先去「岗位与面试」排一场" /> : null}
          {list.map((it) => (
            <Chip key={it.id} selected={false} onClick={() => onPickInterview(it.id)} right={<InterviewPill status={it.status} />}>
              {dir.labelOf(it)}
            </Chip>
          ))}
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.18fr_1fr]">
      {/* Left Column: the run trace + the one-pager it produced */}
      <div className="grid gap-4">
        <Panel
        title="这一页"
        subtitle={data ? `生成于 ${fmtTime(data.generatedAt)}，面试前看这一页就够` : '还没有生成'}
        icon={Sparkles}
        tone="ai"
        right={
          <div className="flex items-center gap-2">
            <Btn
              variant="primary"
              busy={pending === '生成'}
              busyLabel="生成中…"
              disabled={pending !== null}
              onClick={() =>
                void guard(
                  '生成',
                  async () => {
                    const bundle = await api.agent.prep(interviewId);
                    setRun(bundle.run);
                    runs.reload();
                  },
                  '已按最新简历生成。',
                )
              }
            >
              {data ? '重新生成' : '生成一页纸'}
            </Btn>
            {data ? (
              <Btn
                icon={Copy}
                onClick={() => {
                  const lines = [
                    `【面证】一页纸准备`,
                    `生成时间：${fmtTime(data.generatedAt)}`,
                    '',
                    `一、这场面试最该看什么：`,
                    ...data.crux.map((c, i) => `  ${i + 1}. ${c}`),
                    '',
                    ...(data.carryOver && data.carryOver.length > 0
                      ? [
                          `上一轮没问清的：`,
                          ...data.carryOver.map((c) => `  · ${c.dimensionName}：第 ${c.fromRound} 轮${c.reason}`),
                          '',
                        ]
                      : []),
                    `二、考察维度与简历：`,
                    ...data.alignment.map((r) => `  · [${MARK[r.mark].label}] ${r.dimensionName}：${r.rationale}`),
                    '',
                    `三、追问提纲：`,
                    ...data.questions.map((q, i) => `  ${i + 1}. ${q.text}（${q.why}）`),
                    '',
                    `四、要主动核实的地方：`,
                    ...data.redFlagChecks.map((c) => `  · ${c}`),
                    '',
                    'AI 只整理信息，评价与结论由面试官作出。',
                  ];
                  void navigator.clipboard?.writeText(lines.join('\n'));
                  setOk('已复制，可以直接贴进会议记录。');
                }}
              >
                复制
              </Btn>
            ) : null}
          </div>
        }
      >
        <ErrorNote message={error ?? loadError} />
        <OkNote message={ok} />
        {pending === '生成' ? (
          <p className="mb-3 text-[12px] text-mist-dim">助手正在把考察标准和简历放在一起，通常需要半分钟到一分钟，请先别关页面。</p>
        ) : null}

        {pack.loading ? (
          <Loading label="正在读取准备包" rows={5} />
        ) : !data ? (
          <Empty text="点右上角「生成一页纸」，把考察标准和简历放在一起" />
        ) : (
          <div className="flex flex-col gap-4">
            {data.degraded ? (
              <div className="callout callout-warn flex items-start gap-2 p-3 text-[13px] leading-relaxed text-tint-warn">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">简历信息可能不完整</p>
                  <p className="mt-0.5 text-[12px] text-mist">{data.degradedReason}</p>
                  <p className="mt-0.5 text-[12px] text-mist">补充经历后重新生成会更准。</p>
                </div>
              </div>
            ) : null}

            {data.carryOver && data.carryOver.length > 0 ? (
              <div className="callout callout-warn p-4">
                <Subhead icon={History}>
                  上一轮没问清的，这轮先补
                </Subhead>
                <ul className="ml-1 mt-2 space-y-1.5 text-[13px] leading-relaxed text-paper">
                  {data.carryOver.map((c) => (
                    <li key={c.dimensionId} className="flex items-start gap-2">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-warn/80" aria-hidden />
                      <span>
                        <span className="font-medium">{c.dimensionName}</span>
                        <span className="text-mist">：第 {c.fromRound} 轮{c.reason}，追问已排在提纲最前面。</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="inset p-4">
              <Subhead icon={FileCheck2}>
                这场面试最该看什么
              </Subhead>
              <ul className="ml-1 mt-2 space-y-1.5 text-[13px] leading-relaxed text-paper">
                {data.crux.map((c, i) => (
                  <li key={c} className="flex items-start gap-2">
                    <span className="num mt-0.5 shrink-0 text-[11px] text-mist-dim">{i + 1}</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <Subhead icon={Filter}>
                  考察维度与简历
                </Subhead>
                <Segmented
                  options={[
                    { id: 'all', label: '全部' },
                    { id: 'matched', label: MARK.matched.label },
                    { id: 'needs_probe', label: MARK.needs_probe.label },
                    { id: 'weak', label: MARK.weak.label },
                  ]}
                  value={filterMark}
                  onChange={setFilterMark}
                  label="按简历覆盖情况筛选"
                />
              </div>

              <div className="overflow-x-auto rounded-xl border border-line-soft [scrollbar-gutter:stable]">
                <table className="w-full min-w-[560px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line-soft bg-raise-soft text-left text-mist-dim">
                      <th scope="col" className="w-[26%] py-2 pl-4 pr-2 font-medium">
                        考察维度
                      </th>
                      <th scope="col" className="w-[22%] py-2 pr-2 font-medium">
                        简历里有没有
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        依据
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAlignment.map((row) => (
                      <tr key={row.dimensionId} className="border-b border-line-soft/70 align-top last:border-0">
                        <td className="py-2 pl-4 pr-2 font-medium text-paper">{row.dimensionName}</td>
                        <td className="py-2 pr-2">
                          <Badge tone={MARK[row.mark].tone}>{MARK[row.mark].label}</Badge>
                        </td>
                        <td className="py-2 pr-4 leading-relaxed text-mist">{row.rationale}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="callout callout-bad p-4">
              <Subhead icon={AlertOctagon}>
                面试中要主动核实的地方
              </Subhead>
              <ul className="ml-1 mt-2 space-y-1.5 text-[13px] leading-relaxed text-paper">
                {data.redFlagChecks.map((c) => (
                  <li key={c} className="flex items-start gap-2">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-bad/70" aria-hidden />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
        {run ? <AgentTrace run={run} title="这一页纸是怎么来的" /> : null}
      </div>

      {/* Right Column: what the agent remembers + the question deck */}
      <div className="grid gap-4">
        <Panel
          title="候选人的证据账本"
          subtitle="这里只记录已经提交过的面评；下一场准备时，助手就是靠它接着问。"
          icon={History}
          right={<Badge tone="idle">{ledgerEntries.length} 项</Badge>}
        >
          {ledger.loading ? (
            <Loading label="正在翻看之前的记录" rows={3} />
          ) : ledgerEntries.length === 0 ? (
            <Empty text="还没有提交过的面评，这一场从零开始。" />
          ) : (
            <div className="relative">
              <div
                ref={ledgerRef}
                onScroll={syncLedgerFade}
                className="flex max-h-[280px] flex-col overflow-y-auto pr-1 [scrollbar-gutter:stable]"
              >
                {ledgerEntries.map((entry) => {
                  const cfg = LEDGER[entry.status];
                  const open = entry.status === 'missing' || entry.status === 'unscored';
                  return (
                    <div key={entry.id} className="border-b border-line-soft/70 py-2.5 last:border-0 last:pb-0 first:pt-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-paper">{entry.dimensionName}</span>
                        <Badge tone={cfg.tone}>{cfg.label}</Badge>
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-mist">
                        第 {entry.fromRound} 轮 · {entry.reason ?? LEDGER_DETAIL[entry.status]}
                        {open ? (entry.carryOver ? ' · 会带到下一轮' : ' · 只留在那一轮') : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
              {ledgerMoreBelow ? <div className="fade-below" aria-hidden /> : null}
            </div>
          )}
        </Panel>

      <Panel
        title="追问提纲"
        subtitle="按考察标准准备的几个问题；你也可以加自己的。"
        icon={HelpCircle}
        right={<Badge tone="idle">{data?.questions.length ?? 0} 个问题</Badge>}
      >
        <div className="relative">
          <div
            ref={questionsRef}
            onScroll={syncQuestionsFade}
            className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
          >
            {(data?.questions ?? []).length === 0 ? (
              <Empty text="生成一页纸后，这里会出现追问建议" />
            ) : null}

            {(data?.questions ?? []).map((q, idx) => (
              <div key={q.id} className="inset p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <span className="num mt-0.5 shrink-0 text-[11px] text-mist-dim">{idx + 1}</span>
                    <p className="text-[13px] font-medium leading-relaxed text-paper">{q.text}</p>
                  </div>
                  <Badge tone={q.source === 'interviewer' ? 'human' : q.source === 'ai' ? 'ai' : 'info'}>
                    {q.source === 'interviewer' ? '你加的' : q.source === 'ai' ? '助手建议' : '考察标准'}
                  </Badge>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2 text-[12px] text-mist">
                  <span>
                    对应
                    <strong className="ml-1 font-medium text-paper">{dims.find((d) => d.id === q.dimensionId)?.name ?? '自由追问'}</strong>
                    <span className="ml-2 text-mist-dim">{q.why}</span>
                  </span>

                  {me?.role === 'hr' ? (
                    <Btn
                      variant="quiet"
                      disabled={pending !== null}
                      onClick={() =>
                        void guard('否决', async () => {
                          await api.vetoQuestion(interviewId, q.id, '招聘负责人判断这个问题与本轮考察目标不符');
                        }, '已移除这个问题。')
                      }
                    >
                      移除
                    </Btn>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {questionsMoreBelow ? <div className="fade-below" aria-hidden /> : null}
        </div>

        <div className="mt-4 grid gap-3 border-t border-line-soft pt-4">
          <Subhead icon={Plus}>
            自己加一个问题
          </Subhead>
          <Field
            label="问题"
            value={text}
            onChange={setText}
            placeholder="例：请讲一次线上故障时，你从发现问题到定位原因的完整过程…"
          />
          <Select label="对应哪一项考察维度" value={dimensionId} onChange={setDimensionId}>
            <option value="">不指定（自由追问）</option>
            {dims.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <div>
            <Btn
              variant="primary"
              disabled={pending !== null || text.trim().length < 2}
              onClick={() =>
                void guard('加题', async () => {
                  await api.addQuestion(interviewId, text.trim(), dimensionId || null);
                  setText('');
                }, '已加入提纲。')
              }
              icon={Plus}
            >
              加入提纲
            </Btn>
          </div>
        </div>
      </Panel>
      </div>
    </div>
  );
}
