import type { ReactNode } from 'react';
import { Bell, CalendarClock, FileCheck2, FileText, Mic, Target } from 'lucide-react';
import { api } from '../api/client';
import { useDirectory, useLoader, useSession } from '../session';
import type { BoardRow, Interview } from '../api/types';
import {
  Badge,
  Btn,
  Empty,
  ErrorNote,
  InterviewPill,
  Loading,
  Panel,
  fmtTime,
} from '../ui';

const byScheduled = (a: Interview, b: Interview) => (a.scheduledAt < b.scheduledAt ? -1 : 1);
const byEnded = (a: Interview, b: Interview) => ((a.endedAt ?? a.scheduledAt) < (b.endedAt ?? b.scheduledAt) ? -1 : 1);

const hoursSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 36e5));
};

const waitedText = (hours: number | null): string | null => {
  if (hours === null) return null;
  if (hours < 1) return '不到 1 小时';
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
};

function TodoRow({ title, meta, right }: { title: string; meta: string; right: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-soft py-3 first:pt-0 last:border-b-0 last:pb-0">
      {/* 窄屏上按钮另起一行，先让标题和「已等多久」读完整。 */}
      <div className="min-w-0 w-full sm:w-auto sm:flex-1">
        <p className="truncate text-[13px] text-paper">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-mist-dim">{meta}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
    </li>
  );
}

/**
 * 每个身份只回答一个问题：现在该我做哪一件。
 * 面试官一年只面 8–11 场，记不住路径，所以待办必须自己找上门；HR 每天看的是谁没交；
 * 用人经理每个岗位只来一次，看的是标准落了没有。
 */
export function TodayScreen({
  onOpenInterview,
  onOpenStandard,
  onOpenBoard,
  onOpenSetup,
}: {
  onOpenInterview: (tab: 'prep' | 'live' | 'draft', interviewId: string) => void;
  onOpenStandard: (jobId: string) => void;
  onOpenBoard: (interviewId?: string) => void;
  onOpenSetup: () => void;
}) {
  const { org, me, interviews } = useSession();
  const orgId = org?.id ?? '';
  const meId = me?.id ?? '';
  const dir = useDirectory(orgId, interviews.data);
  const jobs = useLoader(() => api.listJobs(orgId), [orgId]);
  const isHr = me?.role === 'hr';
  const rows = useLoader(() => (isHr ? api.rows(orgId) : Promise.resolve<BoardRow[]>([])), [orgId, isHr]);

  const all = interviews.data ?? [];
  const jobList = jobs.data ?? [];
  const pendingJobs = jobList.filter((job) => !job.confirmedStandardId);

  if (interviews.loading && !interviews.data) return <Loading rows={3} />;

  const error = interviews.error ?? jobs.error ?? (isHr ? rows.error : null);

  if (me?.role === 'hiring_manager') {
    const live = jobList.filter((job) => job.confirmedStandardId);
    const usedIn = (jobId: string) => all.filter((it) => it.jobId === jobId).length;
    return (
      <div className="grid gap-4">
        <ErrorNote message={error} />
        <Panel
          title="等你定标的岗位"
          subtitle="每个岗位只来一次：把标准说出来，逐条确认，签完字就走。"
          icon={Target}
          right={pendingJobs.length > 0 ? <Badge tone="warn">{pendingJobs.length} 个</Badge> : undefined}
        >
          {jobs.loading && !jobs.data ? (
            <Loading rows={2} />
          ) : pendingJobs.length === 0 ? (
            <Empty
              text={
                jobList.length === 0
                  ? '还没有岗位。岗位录入之后，会出现在这里等你定标。'
                  : '所有岗位的标准都已定稿，不需要你再看一遍。'
              }
            />
          ) : (
            <ul>
              {pendingJobs.map((job) => (
                <TodoRow
                  key={job.id}
                  title={`${job.title}${job.level ? ` · ${job.level}` : ''}`}
                  meta="还没有生效的考察标准，定稿之后才能排期面试"
                  right={
                    <Btn variant="primary" onClick={() => onOpenStandard(job.id)}>
                      去定标
                    </Btn>
                  }
                />
              ))}
            </ul>
          )}
          {jobList.length === 0 ? (
            <div className="mt-3">
              <Btn variant="primary" onClick={onOpenSetup}>
                去录入岗位
              </Btn>
            </div>
          ) : null}
        </Panel>

        {live.length > 0 ? (
          <Panel title="标准已经生效" subtitle="这些岗位的每一场面试，都按同一套维度打分。" icon={FileCheck2}>
            <ul>
              {live.map((job) => (
                <TodoRow
                  key={job.id}
                  title={`${job.title}${job.level ? ` · ${job.level}` : ''}`}
                  meta={`已用于 ${usedIn(job.id)} 场面试`}
                  right={<Btn onClick={() => onOpenStandard(job.id)}>看标准</Btn>}
                />
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    );
  }

  if (isHr) {
    /* 已标记失效的面试也带 overdue 灯，但它不属于「还没交」，不能混进这张催办清单。 */
    const late = (rows.data ?? [])
      .filter((row) => row.light === 'attention')
      .sort((a, b) => (b.waitingHours ?? 0) - (a.waitingHours ?? 0));
    return (
      <div className="grid gap-4">
        <ErrorNote message={error} />
        <Panel
          title="到时限还没交"
          subtitle="超过 24 小时还没提交的面评，等得最久的排在最上面。完整清单、催办和周报在交付看板。"
          icon={Bell}
          tone={late.length > 0 ? 'warn' : 'default'}
          right={
            <div className="flex items-center gap-2">
              {late.length > 0 ? <Badge tone="warn">{late.length} 场</Badge> : null}
              <Btn onClick={() => onOpenBoard()}>打开交付看板</Btn>
            </div>
          }
        >
          {rows.loading && !rows.data ? (
            <Loading rows={2} />
          ) : late.length === 0 ? (
            <Empty text="现在没有到时限还没交的面评。" />
          ) : (
            <ul>
              {late.map((row) => (
                <TodoRow
                  key={row.interviewId}
                  title={`${row.candidateLabel} · ${row.jobTitle} · 第 ${row.round} 轮`}
                  meta={[row.interviewers.join('、'), row.waitingHours !== null ? `已等 ${waitedText(row.waitingHours)}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                  right={<Btn onClick={() => onOpenBoard(row.interviewId)}>看这一场</Btn>}
                />
              ))}
            </ul>
          )}
          {all.length === 0 ? (
            <div className="mt-3">
              <Btn variant="primary" onClick={onOpenSetup}>
                去录入岗位，排出第一场面试
              </Btn>
            </div>
          ) : null}
        </Panel>
      </div>
    );
  }

  const mine = all.filter((it) => it.interviewerIds.includes(meId));
  const awaiting = [...mine]
    .filter((it) => it.status === 'audio_done' || it.status === 'eval_pending')
    .sort(byEnded);
  const ongoing = mine.filter((it) => it.status === 'in_progress');
  const upcomingMine = mine.filter((it) => it.status === 'scheduled').sort(byScheduled);

  return (
    <div className="grid gap-4">
      <ErrorNote message={error} />
      <Panel
        title="等你写面评"
        subtitle="面完的记录都在。打开只需要逐条改分、写一句推荐，然后提交。"
        icon={FileText}
        tone={awaiting.length > 0 ? 'warn' : 'default'}
        right={awaiting.length > 0 ? <Badge tone="warn">{awaiting.length} 份</Badge> : undefined}
      >
        {awaiting.length === 0 ? (
          <Empty text="现在没有等你写的面评。面试结束、转写进来之后，会出现在这里。" />
        ) : (
          <ul>
            {awaiting.map((it) => {
              const waited = waitedText(hoursSince(it.endedAt));
              return (
                <TodoRow
                  key={it.id}
                  title={dir.labelOf(it)}
                  meta={[
                    it.endedAt ? `面完于 ${fmtTime(it.endedAt)}` : `排期 ${fmtTime(it.scheduledAt)}`,
                    waited ? `已等 ${waited}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  right={
                    <>
                      <InterviewPill status={it.status} />
                      <Btn variant="primary" onClick={() => onOpenInterview('draft', it.id)}>
                        写面评
                      </Btn>
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </Panel>

      {ongoing.length > 0 ? (
        <Panel title="正在进行" subtitle="同意、记录和转写都在现场记录里。" icon={Mic}>
          <ul>
            {ongoing.map((it) => (
              <TodoRow
                key={it.id}
                title={dir.labelOf(it)}
                meta={`开始于 ${fmtTime(it.startedAt ?? it.scheduledAt)}`}
                right={
                  <>
                    <InterviewPill status={it.status} />
                    <Btn onClick={() => onOpenInterview('live', it.id)}>回到现场记录</Btn>
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      ) : null}

      {upcomingMine.length > 0 ? (
        <Panel
          title="接下来要面"
          subtitle="赛前 3 分钟打开一页纸：这一轮验什么、上一轮哪里没问清。"
          icon={CalendarClock}
        >
          <ul>
            {upcomingMine.slice(0, 3).map((it) => (
              <TodoRow
                key={it.id}
                title={dir.labelOf(it)}
                meta={fmtTime(it.scheduledAt)}
                right={<Btn onClick={() => onOpenInterview('prep', it.id)}>看一页纸</Btn>}
              />
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
