import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  CalendarClock,
  Copy,
  FileText,
  Search,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useLoader, useSession } from '../session';
import {
  Badge,
  Btn,
  Empty,
  ErrorNote,
  INTERVIEW_LABEL,
  InterviewPill,
  Light,
  Loading,
  OkNote,
  Panel,
  REMINDER_LEVEL_LABEL,
  REMINDER_STATUS_LABEL,
  Segmented,
  StatStrip,
  Subhead,
  cx,
  fmtTime,
} from '../ui';

type BoardTab = 'delivery' | 'weekly';

const LIGHT_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'waiting', label: '进行中' },
  { id: 'attention', label: '已到时限' },
  { id: 'overdue', label: '已标记失效' },
  { id: 'done', label: '已面评' },
] as const;

export function BoardScreen({
  focusInterviewId = '',
  onPickInterview,
  onGoDraft,
}: {
  /** 从「今天」点某一场进来时，右侧直接落在这场面试上。 */
  focusInterviewId?: string;
  onPickInterview: (id: string) => void;
  onGoDraft?: () => void;
}) {
  const { org, me, interviews } = useSession();
  const orgId = org?.id ?? '';
  const overview = useLoader(() => api.overview(orgId), [orgId]);
  const rows = useLoader(() => api.rows(orgId), [orgId]);
  const weekly = useLoader(() => api.weeklyReport(orgId), [orgId]);

  const [activeTab, setActiveTab] = useState<BoardTab>('delivery');
  const [selected, setSelected] = useState(focusInterviewId);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLight, setFilterLight] = useState<(typeof LIGHT_FILTERS)[number]['id']>('all');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (focusInterviewId) setSelected(focusInterviewId);
  }, [focusInterviewId]);

  const filteredRows = useMemo(() => {
    let list = rows.data ?? [];
    if (filterLight !== 'all') list = list.filter((r) => r.light === filterLight);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (r) =>
          r.candidateLabel.toLowerCase().includes(q) ||
          r.jobTitle.toLowerCase().includes(q) ||
          r.interviewers.some((i) => i.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [rows.data, filterLight, searchQuery]);

  /**
   * 打开看板时右侧不该是一块「还没有选中面试」。列表有内容时默认落在第一行，
   * 筛选或搜索把选中的那一行滤掉之后，跟着落到还剩下的第一行。
   */
  const effectiveSelected = useMemo(() => {
    if (selected && filteredRows.some((r) => r.interviewId === selected)) return selected;
    return filteredRows[0]?.interviewId ?? '';
  }, [selected, filteredRows]);

  const reminders = useLoader(
    effectiveSelected ? () => api.listReminders(effectiveSelected) : async () => ({ events: [], suggestedActions: [] }),
    [effectiveSelected],
  );

  const refresh = () => {
    overview.reload();
    rows.reload();
    weekly.reload();
    reminders.reload();
  };

  const guard = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setPending(label);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
      refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  const tick = async () => {
    setPending('提醒');
    setError(null);
    setOk(null);
    try {
      const res = await api.tickReminders();
      setOk(res.fired.length === 0 ? '现在还没有到时限的面评，无需提醒。' : `已发出 ${res.fired.length} 条面评提醒。`);
      refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  const hr = me?.role === 'hr';
  const rate = overview.data?.onTimeRate;
  const usable = overview.data?.usable;
  const usableValue = usable?.rate ?? null;
  const selectedRow = (rows.data ?? []).find((r) => r.interviewId === effectiveSelected) ?? null;
  const selectedInterview = (interviews.data ?? []).find((x) => x.id === effectiveSelected) ?? null;
  const reminder = reminders.data?.events[0] ?? null;

  const pick = (interviewId: string) => {
    setSelected(interviewId);
    onPickInterview(interviewId);
  };

  return (
    <div className="grid gap-4">
      <Segmented<BoardTab>
        options={[
          { id: 'delivery', label: '待交付', icon: Users, badge: overview.data?.awaitingEval ?? 0 },
          { id: 'weekly', label: '本周周报', icon: FileText },
        ]}
        value={activeTab}
        onChange={setActiveTab}
        label="看板视图"
      />

      <ErrorNote message={error ?? overview.error ?? rows.error} />
      <OkNote message={ok} />

      {activeTab === 'delivery' ? (
        <>
          <Panel
            title="面评交付看板"
            subtitle="面试结束后 24 小时内，面评应该回到招聘决策里。交没交是一个问题，HR 拿到能不能直接用是另一个。"
            icon={BarChart3}
            right={
              <Btn icon={CalendarClock} disabled={pending !== null} onClick={() => void tick()}>
                检查到时限的提醒
              </Btn>
            }
          >
            <StatStrip
              className="lg:grid-cols-4"
              items={[
                {
                  label: '待提交',
                  value: overview.data?.awaitingEval ?? '—',
                  tone: overview.data?.awaitingEval ? 'warn' : 'default',
                },
                {
                  label: '已交面评',
                  value: overview.data?.evaluated ?? '—',
                  tone: overview.data?.evaluated ? 'ok' : 'default',
                },
                {
                  label: '已标记失效',
                  value: overview.data?.overdue ?? '—',
                  tone: overview.data?.overdue ? 'bad' : 'default',
                },
                {
                  label: '24 小时可用面评率',
                  value: usableValue === null ? '—' : `${Math.round(usableValue * 100)}%`,
                  hint:
                    usable && usable.due > 0
                      ? `${rate?.onTime ?? 0}/${usable.due} 份按时，其中 ${usable.usable} 份每个维度都有落点`
                      : '暂无已到期的面评',
                  tone: usableValue === null ? 'default' : usableValue >= 0.6 ? 'ok' : usableValue < 0.4 ? 'bad' : 'warn',
                },
              ]}
            />
          </Panel>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Panel title="所有面试" subtitle="灯只反映面评有没有按时交付，和候选人表现无关。" icon={Users}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <Segmented
                  options={LIGHT_FILTERS.map((l) => ({ id: l.id, label: l.label }))}
                  value={filterLight}
                  onChange={setFilterLight}
                  label="按交付状态筛选"
                />
                <div className="relative w-full sm:w-60">
                  <Search className="absolute left-2 top-3 h-3.5 w-3.5 text-mist-dim" aria-hidden />
                  <input
                    type="text"
                    placeholder="搜索候选人、岗位、面试官"
                    aria-label="搜索候选人、岗位、面试官"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="field-base pl-8 text-[12px]"
                  />
                </div>
              </div>

              {rows.loading ? (
                <Loading label="正在读取面试列表" rows={5} />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-line-soft [scrollbar-gutter:stable]">
                  <table className="w-full min-w-[760px] table-fixed border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-line-soft bg-raise-soft text-left text-mist-dim">
                        <th scope="col" className="w-[20%] py-2 pl-4 pr-2 font-medium">
                          候选人
                        </th>
                        <th scope="col" className="w-[24%] py-2 pr-2 font-medium">
                          岗位
                        </th>
                        <th scope="col" className="w-[15%] py-2 pr-2 font-medium">
                          状态
                        </th>
                        <th scope="col" className="w-[11%] py-2 pr-2 font-medium">
                          已等待
                        </th>
                        <th scope="col" className="w-[16%] py-2 pr-2 font-medium">
                          面试官
                        </th>
                        <th scope="col" className="w-[14%] py-2 pr-3 font-medium">
                          是否按时
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((r) => {
                        const isSel = effectiveSelected === r.interviewId;
                        return (
                          <tr
                            key={r.interviewId}
                            onClick={() => pick(r.interviewId)}
                            className={cx(
                              'cursor-pointer border-b border-line-soft/70 transition last:border-0',
                              isSel ? 'bg-brand/[0.08]' : 'hover:bg-raise-soft',
                            )}
                          >
                            <td className="py-3 pl-4 pr-2">
                              <button
                                type="button"
                                aria-current={isSel ? 'true' : undefined}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pick(r.interviewId);
                                }}
                                className="press max-w-full truncate text-left font-medium text-paper hover:text-brand-hi"
                              >
                                {r.candidateLabel}
                              </button>
                            </td>
                            <td className="py-3 pr-2 text-mist">
                              <span className="block truncate">{r.jobTitle}</span>
                              <span className="block text-[11px] text-mist-dim">
                                第 {r.round} 轮 · {INTERVIEW_LABEL[r.interviewStatus]}
                              </span>
                            </td>
                            <td className="py-3 pr-2">
                              <Light light={r.light} />
                            </td>
                            <td className="num py-3 pr-2 text-mist">
                              {r.waitingHours === null ? '—' : `${r.waitingHours} 小时`}
                            </td>
                            <td className="truncate py-3 pr-2 text-mist">{r.interviewers.join('、')}</td>
                            <td className="py-3 pr-3">
                              {r.submittedOnTime === null ? (
                                <span className="text-mist-dim">等待提交</span>
                              ) : r.submittedOnTime ? (
                                <Badge tone="ok">24 小时内</Badge>
                              ) : (
                                <Badge tone="bad">超过 24 小时</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {filteredRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8">
                            <Empty text="没有符合条件的面试" />
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <div className="flex flex-col gap-4">
              {selectedRow && selectedInterview ? (
                <Panel
                  title={selectedRow.candidateLabel}
                  subtitle={`${selectedRow.jobTitle} · 第 ${selectedRow.round} 轮`}
                  icon={Bell}
                  right={<InterviewPill status={selectedInterview.status} />}
                >
                  <p className="text-[13px] leading-relaxed text-mist">
                    {selectedRow.waitingHours === null
                      ? '面试还没有结束。'
                      : `面试结束已 ${selectedRow.waitingHours} 小时，面试官：${selectedRow.interviewers.join('、')}。`}
                  </p>

                  <div className="inset mt-3 p-4">
                    <Subhead>提醒</Subhead>
                    {reminder ? (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                        <span className="text-paper">{REMINDER_LEVEL_LABEL[reminder.level]}</span>
                        <span className="flex items-center gap-1.5">
                          {reminder.suspended ? <Badge tone="info">已暂停</Badge> : null}
                          <Badge tone={reminder.status === 'sent' ? 'warn' : reminder.status === 'acknowledged' ? 'ok' : 'idle'}>
                            {REMINDER_STATUS_LABEL[reminder.status]}
                          </Badge>
                        </span>
                        <span className="w-full text-[11px] text-mist-dim">
                          {reminder.status === 'sent' && reminder.sentAt
                            ? `已于 ${fmtTime(reminder.sentAt)} 发出`
                            : `计划 ${fmtTime(reminder.dueAt)} 发出`}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-2">
                        <p className="text-[12px] leading-relaxed text-mist">还没有安排提醒。</p>
                        <Btn
                          className="mt-2"
                          disabled={pending !== null || !hr}
                          disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                          onClick={() => void guard('安排提醒', () => api.queueReminders(effectiveSelected), '面试结束 24 小时后会提醒面试官一次。')}
                        >
                          安排 24 小时提醒
                        </Btn>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Btn
                      variant="primary"
                      disabled={!hr}
                      disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                      onClick={() => {
                        onPickInterview(effectiveSelected);
                        onGoDraft?.();
                      }}
                    >
                      去写面评
                    </Btn>
                    {reminder && !reminder.suspended ? (
                      <Btn
                        disabled={pending !== null || !hr}
                        disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                        onClick={() => void guard('暂停提醒', () => api.suspendReminders(effectiveSelected, '面试官出差或休假，返岗后继续'), '提醒已暂停。')}
                      >
                        暂停提醒
                      </Btn>
                    ) : null}
                    {reminder?.suspended ? (
                      <Btn
                        disabled={pending !== null || !hr}
                        disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                        onClick={() => void guard('恢复提醒', () => api.resumeReminders(effectiveSelected), '提醒已恢复。')}
                      >
                        恢复提醒
                      </Btn>
                    ) : null}
                    {selectedInterview.status !== 'expired' && selectedInterview.status !== 'eval_submitted' ? (
                      <Btn
                        variant="quiet"
                        disabled={pending !== null || !hr}
                        disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                        onClick={() => {
                          if (window.confirm('标记失效后，这场面试不再计入待交付；之后仍可以重启。')) {
                            void guard('标记失效', () => api.expire(effectiveSelected), '已标记失效，可以从这里重新启动。');
                          }
                        }}
                      >
                        标记失效
                      </Btn>
                    ) : null}
                    {selectedInterview.status === 'expired' ? (
                      <Btn
                        disabled={pending !== null || !hr}
                        disabledReason={hr ? undefined : '这些操作需要招聘负责人身份。'}
                        onClick={() => void guard('重启', () => api.restart(effectiveSelected), '面试已重启，准备包和考察标准都还在。')}
                      >
                        重启面试
                      </Btn>
                    ) : null}
                  </div>
                  {!hr ? <p className="mt-2 text-[12px] text-mist-dim">这些操作需要招聘负责人身份。</p> : null}

                  {(reminders.data?.suggestedActions.length ?? 0) > 0 && selectedInterview.status !== 'eval_submitted' ? (
                    <div className="mt-4 border-t border-line-soft pt-3">
                      <Subhead icon={AlertTriangle}>
                        还可以考虑
                      </Subhead>
                      <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-mist">
                        {reminders.data?.suggestedActions.map((a) => (
                          <li key={a}>· {a}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </Panel>
              ) : (
                <Panel title="选一场面试" subtitle="点左侧任意一行，查看它的提醒与处理方式。" icon={Bell}>
                  <Empty text="还没有可以查看的面试" />
                </Panel>
              )}
            </div>
          </div>
        </>
      ) : (
        <Panel
          title="本周周报"
          subtitle="可以直接复制发到招聘群里，不需要再手工统计。"
          icon={FileText}
          right={
            <Btn
              icon={Copy}
              disabled={!weekly.data?.report}
              disabledReason={weekly.loading ? '周报还在生成。' : '这一周还没有可用的周报。'}
              onClick={() => {
                if (weekly.data?.report) void navigator.clipboard?.writeText(weekly.data.report);
                setOk('周报已复制。');
              }}
            >
              复制
            </Btn>
          }
        >
          {weekly.loading ? (
            <Loading label="正在生成周报" rows={6} />
          ) : weekly.data?.report ? (
            <pre className="max-h-[520px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-raise-soft p-4 font-sans text-[13px] leading-[1.9] text-paper [scrollbar-gutter:stable]">
              {weekly.data.report}
            </pre>
          ) : (
            <Empty text="这一周还没有可以汇总的面试记录。" icon={FileText} />
          )}
        </Panel>
      )}
    </div>
  );
}
