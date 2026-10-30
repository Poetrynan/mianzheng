import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, Hexagon, Users } from 'lucide-react';
import { api } from '../api/client';
import type { CandidateResultCell, CandidateResultRow, CandidateResults } from '../api/types';
import { useLoader, useSession } from '../session';
import { DimensionRadar } from '../Radar';
import {
  Badge,
  Btn,
  Empty,
  ErrorNote,
  InfoNote,
  Loading,
  Panel,
  SCORE_LABEL,
  Select,
  StatStrip,
  Subhead,
  cx,
  fmtTime,
} from '../ui';

const LEVEL_TONE: Record<string, 'ok' | 'warn' | 'bad'> = { high: 'ok', medium: 'warn', low: 'bad' };
const LEVEL_TEXT: Record<string, string> = { high: 'text-tint-ok', medium: 'text-tint-warn', low: 'text-tint-bad' };

/** 转写里的时间码：指向原话在录音里的大致位置。 */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function scoreBadge(cell: CandidateResultCell) {
  if (cell.level === null) return <Badge tone="idle">没评</Badge>;
  return <Badge tone={LEVEL_TONE[cell.level] ?? 'idle'}>{SCORE_LABEL[cell.level]}</Badge>;
}

/** 缺口有两种：这一维压根没评，和评了却一句原话都没挂。混成一句「还空着」会把前者藏起来。 */
function gapNote(row: CandidateResultRow): string {
  if (row.submittedRounds === 0) return '还没有面评';
  if (row.gaps === 0) return '都填上了';
  const unscored = row.cells.filter((c) => c.level === null).length;
  const unbacked = row.gaps - unscored;
  const parts: string[] = [];
  if (unscored > 0) parts.push(`${unscored} 维没终评`);
  if (unbacked > 0) parts.push(`${unbacked} 维没原话`);
  return parts.join(' · ');
}

/**
 * 这一屏回答的是「按这个岗位定下的标准，这几个人各是什么样子、还缺哪几维」。
 * 表、图、缺口必须同时在视野里：只并排维度看不出人，只看图又看不出缺什么。
 * 轴上的取值只认面试官提交版里的最终评分，AI 起评分不参与。
 */
export function ResultsScreen({ onOpenDraft }: { onOpenDraft: (interviewId: string) => void }) {
  const { org } = useSession();
  const orgId = org?.id ?? '';
  const jobs = useLoader(() => (orgId ? api.listJobs(orgId) : Promise.resolve([])), [orgId]);
  const [jobId, setJobId] = useState('');

  const jobList = jobs.data ?? [];
  const activeJobId = jobId || jobList[0]?.id || '';
  const results = useLoader<CandidateResults | null>(
    () => (orgId && activeJobId ? api.candidateResults(orgId, activeJobId) : Promise.resolve(null)),
    [orgId, activeJobId],
  );

  const rows = results.data?.candidates ?? [];
  const [pickedId, setPickedId] = useState('');
  useEffect(() => {
    if (rows.some((r) => r.candidateId === pickedId)) return;
    const first = rows.find((r) => r.submittedRounds > 0) ?? rows[0];
    if (first) setPickedId(first.candidateId);
  }, [rows, pickedId]);
  const picked = rows.find((r) => r.candidateId === pickedId) ?? null;

  const dims = results.data?.standard?.dimensions ?? [];
  const interviewed = rows.filter((r) => r.submittedRounds > 0);
  const missing = rows.filter((r) => r.submittedRounds === 0);
  const gapTotal = interviewed.reduce((sum, r) => sum + r.gaps, 0);

  const standardNote = useMemo(() => {
    const std = results.data?.standard;
    if (!std) return '这个岗位的考察标准还没定稿。标准定稿并双签之后，这里才会按维度把候选人的结果摆出来。';
    return null;
  }, [results.data]);

  return (
    <div className="grid gap-4">
      <Panel
        title="按岗位看候选人结果"
        subtitle="要给这个岗位一个说法时先看这一屏：每个人落在哪一维、还缺哪几维的证据。轴上的取值只认面试官提交版里的最终评分，没评的、没挂上原话的，都原样留空。"
        icon={Hexagon}
      >
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Select
            label="岗位"
            value={activeJobId}
            onChange={(next) => {
              setJobId(next);
              setPickedId('');
            }}
          >
            {jobList.length === 0 ? <option value="">还没有岗位</option> : null}
            {jobList.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
                {job.level ? ` · ${job.level}` : ''}
              </option>
            ))}
          </Select>
          <StatStrip
            className="lg:grid-cols-3"
            items={[
              { label: '考察维度', value: dims.length || '—', hint: results.data?.standard ? `标准 ${results.data.standard.version}` : '标准未定稿' },
              { label: '有已交面评', value: rows.length ? `${interviewed.length}/${rows.length}` : '—', hint: '按候选人计，一个岗位下的所有人' },
              {
                label: '还缺证据的维度',
                value: interviewed.length ? gapTotal : '—',
                tone: gapTotal > 0 ? 'warn' : 'default',
                hint: '只算已经交了面评的人：没终评、或评了却没挂原话',
              },
            ]}
          />
        </div>
      </Panel>

      <ErrorNote message={jobs.error ?? results.error} />
      {results.loading ? <Loading label="正在汇总这个岗位下的面评结果" rows={4} /> : null}

      {!results.loading && standardNote ? <InfoNote message={standardNote} /> : null}

      {!results.loading && !standardNote && rows.length === 0 ? <Empty text="这个岗位还没有候选人。去「岗位与面试」录入简历并排一场面试。" icon={Users} /> : null}

      {!results.loading && rows.length > 0 ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
            <CompareTable rows={rows} dims={dims} pickedId={picked?.candidateId ?? ''} missing={missing} onPick={setPickedId} />
            {picked ? <Snapshot row={picked} /> : null}
          </div>
          {picked ? <CandidateDetail key={picked.candidateId} row={picked} onOpenDraft={onOpenDraft} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** 维度做行、候选人做列：同一把标准下一眼横着比。只并排，不排名。 */
function CompareTable({
  rows,
  dims,
  pickedId,
  missing,
  onPick,
}: {
  rows: CandidateResultRow[];
  dims: Array<{ id: string; name: string }>;
  pickedId: string;
  missing: CandidateResultRow[];
  onPick: (id: string) => void;
}) {
  if (dims.length === 0) return null;
  return (
    <Panel
      title="并排看：每个维度落在哪"
      subtitle="同一把标准下横向排开，不排名、不给总分。点一个人的名字，右边就是他自己的矩阵和缺口。"
      icon={Users}
      headingLevel={3}
      className="min-w-0"
    >
      <div className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1">
        <table className="w-full min-w-[620px] border-separate border-spacing-0 text-left">
          <caption className="sr-only">这个岗位下每个候选人各考察维度的结果，以及还缺什么</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[34%] border-b border-line-soft pb-2 pr-3 text-[11px] font-medium text-mist-dim">
                考察维度
              </th>
              {rows.map((row) => {
                const on = row.candidateId === pickedId;
                return (
                  <th key={row.candidateId} scope="col" className="border-b border-line-soft pb-2 pr-3 text-left align-bottom">
                    <button
                      type="button"
                      onClick={() => onPick(row.candidateId)}
                      aria-current={on ? 'true' : undefined}
                      className={cx(
                        'press inline-flex flex-col items-start gap-1 rounded-lg px-1.5 py-1 text-left transition',
                        on ? 'bg-brand/[0.10]' : 'hover:bg-raise',
                      )}
                    >
                      <span className="text-[13px] font-medium text-paper">{row.name}</span>
                      {row.submittedRounds === 0 ? (
                        <span className="text-[11px] text-mist-dim">还没交</span>
                      ) : (
                        <span className="text-[11px] text-mist-dim">{row.submittedRounds} 轮已交</span>
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {dims.map((dim) => (
              <tr key={dim.id}>
                <th scope="row" className="border-b border-line-soft py-2.5 pr-3 align-top text-[12px] font-normal leading-snug text-mist">
                  {dim.name}
                </th>
                {rows.map((row) => {
                  const cell = row.cells.find((c) => c.dimensionId === dim.id);
                  return (
                    <td key={row.candidateId} className="border-b border-line-soft py-2.5 pr-3 align-top text-[12px]">
                      {!cell || cell.level === null ? (
                        <span className="text-mist-dim">没评</span>
                      ) : (
                        <span className={LEVEL_TEXT[cell.level] ?? 'text-paper'}>
                          {SCORE_LABEL[cell.level]}
                          {cell.evidenceCount === 0 ? (
                            <span className="mt-0.5 block text-[11px] text-tint-warn">没挂原话</span>
                          ) : (
                            <span className="mt-0.5 block text-[11px] text-mist-dim">{cell.evidenceCount} 段原话</span>
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-2.5 pr-3 text-[12px] font-medium text-paper">
                还缺
              </th>
              {rows.map((row) => (
                <td key={row.candidateId} className="py-2.5 pr-3 text-[12px] text-mist">
                  {gapNote(row)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-mist-dim sm:hidden">表格可以左右滑动。</p>
      {missing.length > 0 ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-mist">
          <span className="inline-flex items-center gap-1 text-tint-warn">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            还没交面评
          </span>
          {missing.map((row) => (
            <span key={row.candidateId} className="text-paper">
              {row.name}
              <span className="ml-1 text-[11px] text-mist-dim">
                {row.upcomingAt ? `面试排在 ${fmtTime(row.upcomingAt)}` : '还没有排面试'}
              </span>
            </span>
          ))}
        </p>
      ) : null}
    </Panel>
  );
}

/** 图紧挨着缺口：选中谁，右边就是他的形状和缺的那几维，不用上下翻。 */
function Snapshot({ row }: { row: CandidateResultRow }) {
  const missingCells = row.cells.filter((c) => c.level === null || c.evidenceCount === 0);
  return (
    <Panel
      title={`${row.name} · 维度矩阵`}
      subtitle={
        row.submittedRounds === 0
          ? `还没有已提交的面评${row.upcomingAt ? `，面试排在 ${fmtTime(row.upcomingAt)}` : ''}。`
          : `已交 ${row.submittedRounds} 轮，后面的轮次覆盖前面的。`
      }
      icon={Hexagon}
      headingLevel={3}
      className="min-w-0"
    >
      <div className="flex flex-col items-center gap-3">
        <DimensionRadar cells={row.cells} caption={row.name} />
        <div className="w-full rounded-xl border border-line-soft px-3 py-2.5">
          <p className="text-[11px] text-mist-dim">还缺哪几维</p>
          {row.submittedRounds === 0 ? (
            <p className="mt-1 text-[12px] text-mist">还没有面评，等面试官提交后再看。</p>
          ) : missingCells.length === 0 ? (
            <p className="mt-1 text-[12px] text-mist">每一维都有终评、也都挂了原话。</p>
          ) : (
            <ul className="mt-1 grid gap-1">
              {missingCells.map((cell) => (
                <li key={cell.dimensionId} className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                  <span className="text-paper">{cell.dimensionName}</span>
                  <span className="text-[11px] text-tint-warn">{cell.level === null ? '没终评' : '没挂原话'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function CandidateDetail({ row, onOpenDraft }: { row: CandidateResultRow; onOpenDraft: (interviewId: string) => void }) {
  const [openDim, setOpenDim] = useState('');
  return (
    <Panel
      title={`${row.name} · 逐维结果`}
      subtitle="点开某一维，就能看到面试官当时挂上的那几句原话和它在转写里的位置；没评的和没挂原话的分开标。"
      icon={Users}
      headingLevel={3}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <ul className="flex flex-col divide-y divide-line-soft rounded-xl border border-line-soft">
          {row.cells.map((cell) => {
            const open = openDim === cell.dimensionId;
            return (
              <li key={cell.dimensionId}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenDim(open ? '' : cell.dimensionId)}
                  className="press flex w-full flex-col gap-1 px-3 py-2.5 text-left transition hover:bg-raise-soft"
                >
                  <span className="flex w-full flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-paper">{cell.dimensionName}</span>
                    {scoreBadge(cell)}
                    {cell.level !== null && cell.evidenceCount > 0 ? (
                      <span className="text-[12px] text-mist-dim">{cell.evidenceCount} 句原话</span>
                    ) : null}
                    {cell.level !== null && cell.evidenceCount === 0 ? (
                      <span className="text-[12px] text-tint-warn">没挂上原话</span>
                    ) : null}
                    {cell.redFlagHits.length > 0 ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-tint-bad">
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        踩到 {cell.redFlagHits.length} 条红旗
                      </span>
                    ) : null}
                    <ChevronDown
                      className={cx('h-3.5 w-3.5 shrink-0 text-mist-dim transition-transform', open && 'rotate-180')}
                      aria-hidden
                    />
                  </span>
                  {cell.summary ? <span className="block text-[12px] leading-relaxed text-mist">{cell.summary}</span> : null}
                  {cell.round > 0 ? (
                    <span className="block text-[11px] text-mist-dim">
                      第 {cell.round} 轮 · {cell.interviewerName} 提交 · {fmtTime(cell.submittedAt)}
                    </span>
                  ) : (
                    <span className="block text-[11px] text-tint-warn">这一维在所有已提交的面评里都是空的</span>
                  )}
                </button>
                {open ? (
                  <div className="px-3 pb-3">
                    {cell.evidence.length > 0 ? (
                      <ul className="grid gap-2">
                        {cell.evidence.map((item, index) => (
                          <li key={`${cell.dimensionId}-${index}`} className="border-l-2 border-human/40 pl-2.5">
                            <p className="text-[12px] leading-relaxed text-paper">「{item.quote}」</p>
                            <p className="mt-0.5 text-[11px] text-mist-dim">转写 {fmtClock(item.startMs)}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[12px] leading-relaxed text-mist">
                        {cell.level === null
                          ? '这一维还没有终评，也没有原话。'
                          : '这一维下了判断，但一句原话都没挂——所以矩阵上是空心圈。'}
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="flex min-w-0 flex-col gap-3">
          <Subhead as={4}>面试官的综合意见</Subhead>
          {row.recommendation ? (
            <div className="rounded-xl border border-line-soft bg-raise-soft px-3 py-2.5">
              <p className="text-[13px] leading-relaxed text-paper">{row.recommendation}</p>
            </div>
          ) : (
            <p className="text-[12px] text-mist">还没有人写下综合意见。</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {row.cells
              .filter((c) => c.interviewId)
              .slice(0, 1)
              .map((c) => (
                <Btn key={c.interviewId} variant="quiet" icon={ArrowRight} onClick={() => onOpenDraft(c.interviewId)}>
                  看这一轮的面评
                </Btn>
              ))}
            {row.lastSubmittedAt ? <span className="text-[11px] text-mist-dim">最近一次提交：{fmtTime(row.lastSubmittedAt)}</span> : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}
