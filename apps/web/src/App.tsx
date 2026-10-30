import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Briefcase,
  ClipboardList,
  FileText,
  Hexagon,
  Home,
  LogOut,
  Mic,
  ShieldCheck,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { SessionProvider, useDirectory, useSession } from './session';
import { Brand, ThemeToggle } from './chrome';
import { Btn, InterviewPill, ROLE_LABEL, cx } from './ui';
import { AuthScreen } from './screens/AuthScreen';
import { BoardScreen } from './screens/Board';
import { ComplianceScreen } from './screens/Compliance';
import { DraftScreen } from './screens/Draft';
import { LiveScreen } from './screens/Live';
import { PrepScreen } from './screens/Prep';
import { ResultsScreen } from './screens/Results';
import { SetupScreen } from './screens/Setup';
import { StandardScreen } from './screens/Standard';
import { TeamScreen } from './screens/Team';
import { TodayScreen } from './screens/Today';

type Tab = 'today' | 'setup' | 'standard' | 'prep' | 'live' | 'draft' | 'results' | 'board' | 'compliance' | 'team';

interface NavItem {
  tab: Tab;
  group: string;
  label: string;
  desc: string;
  icon: LucideIcon;
}

/**
 * 「今天」是入口，不是第四个功能；三件主线（定标、一页纸、面评）跟着面试流程排在最上面；
 * 交付看板与岗位、隐私、账号这些支撑页收进「管理」，不再和主线抢同一层视觉重量。
 */
const NAV: NavItem[] = [
  {
    tab: 'today',
    group: '',
    label: '今天',
    desc: '按你的角色，把现在该做的那一件排在前面。',
    icon: Home,
  },
  {
    tab: 'standard',
    group: '',
    label: '考察标准',
    desc: '和用人经理一起，定下这个岗位到底要看什么。',
    icon: Target,
  },
  {
    tab: 'prep',
    group: '面试',
    label: '一页纸准备',
    desc: '五分钟看完候选人简历和这场面试要追问的地方。',
    icon: ClipboardList,
  },
  {
    tab: 'live',
    group: '面试',
    label: '现场记录',
    desc: '候选人同意后开始记录，面试官只需要和候选人说话。',
    icon: Mic,
  },
  {
    tab: 'draft',
    group: '面试',
    label: '面评',
    desc: '按考察标准整理原话和评价，由面试官逐条确认。',
    icon: FileText,
  },
  {
    tab: 'results',
    group: '管理',
    label: '候选人结果',
    desc: '按这个岗位定下的标准，看每个候选人各维度分别是什么结果、还缺哪几维。',
    icon: Hexagon,
  },
  {
    tab: 'board',
    group: '管理',
    label: '交付看板',
    desc: '谁的面评还没交、等了多久，一眼看到。',
    icon: BarChart3,
  },
  {
    tab: 'setup',
    group: '管理',
    label: '岗位与面试',
    desc: '录入岗位和简历，排定一场面试。考察标准定稿后才能排期。',
    icon: Briefcase,
  },
  {
    tab: 'compliance',
    group: '管理',
    label: '隐私与记录',
    desc: '候选人的同意、复核申请和数据留存，都在这里。',
    icon: ShieldCheck,
  },
  {
    tab: 'team',
    group: '管理',
    label: '团队与账号',
    desc: '成员、登录方式与密码。',
    icon: Users,
  },
];

const GROUPS = Array.from(new Set(NAV.map((n) => n.group)));

const ACTIVE_KEY = 'mianzheng.activeInterview.v1';
const LEGACY_ACTIVE_KEY = 'mianyan.activeInterview.v1';

function readActiveInterview(): string {
  try {
    const value = localStorage.getItem(ACTIVE_KEY) ?? localStorage.getItem(LEGACY_ACTIVE_KEY) ?? '';
    if (value) localStorage.setItem(ACTIVE_KEY, value);
    return value;
  } catch {
    return '';
  }
}

function Workspace() {
  const { status, org, me, interviews, logout } = useSession();
  const [tab, setTab] = useState<Tab>('today');
  const [standardJobId, setStandardJobId] = useState('');
  const [interviewId, setInterviewId] = useState<string>(readActiveInterview);
  const orgId = org?.id ?? '';

  const dir = useDirectory(orgId, interviews.data);

  const selectInterview = useCallback(
    (id: string) => {
      setInterviewId(id);
      try {
        localStorage.setItem(ACTIVE_KEY, id);
      } catch {
        // 浏览器禁用存储时，当前会话内仍然生效。
      }
      interviews.reload();
    },
    [interviews],
  );

  /** 「考察标准」打开的是岗位，不是上一场面试；从「今天」带着岗位进来时才预选。 */
  const openTab = useCallback((next: Tab) => {
    if (next === 'standard') setStandardJobId('');
    setTab(next);
  }, []);

  const active = useMemo(
    () => (interviews.data ?? []).find((x) => x.id === interviewId) ?? null,
    [interviews.data, interviewId],
  );
  const current = NAV.find((n) => n.tab === tab) ?? NAV[0]!;
  const interviewList = interviews.data ?? [];
  /** 只有这几屏看的是「某一场面试」；标准、账号、今天上摆一个面试选择器只是噪声。 */
  const pickable = tab === 'prep' || tab === 'live' || tab === 'draft' || tab === 'board';

  /**
   * 打开应用时如果手上没有一场面试，就落到最该看的那一场：先找我还没交的面评，
   * 没有再落到最近排的一场。面试官一年只面 8–11 场，不该让他自己翻。
   */
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current) return;
    const list = interviews.data ?? [];
    if (list.length === 0) return;
    if (list.some((x) => x.id === interviewId)) {
      autoPicked.current = true;
      return;
    }
    const waiting = me
      ? list
          .filter((x) => (x.status === 'audio_done' || x.status === 'eval_pending') && x.interviewerIds.includes(me.id))
          .sort((a, b) => ((a.endedAt ?? a.scheduledAt) < (b.endedAt ?? b.scheduledAt) ? -1 : 1))[0]
      : undefined;
    const latest = [...list].sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1))[0];
    const pick = waiting ?? latest;
    if (!pick) return;
    autoPicked.current = true;
    setInterviewId(pick.id);
    try {
      localStorage.setItem(ACTIVE_KEY, pick.id);
    } catch {
      // 浏览器禁用存储时，当前会话内仍然生效。
    }
  }, [interviews.data, interviewId, me]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-[100dvh] place-items-center px-5">
        <div className="flex flex-col items-center gap-4">
          <Brand />
          <div className="h-1 w-24 overflow-hidden rounded-full bg-raise">
            <div className="h-full w-1/2 rounded-full bg-brand/70 motion-safe:animate-pulse" />
          </div>
          <p className="text-[12px] text-mist-dim">正在确认登录状态…</p>
        </div>
      </div>
    );
  }

  if (status === 'anonymous' || !org || !me) {
    return <AuthScreen />;
  }

  return (
    <div className="flex min-h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-[12px] focus:font-medium focus:text-on-brand"
      >
        跳到主要内容
      </a>
      <aside className="glass-rail sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col overflow-y-auto px-3 py-4 [scrollbar-gutter:stable] lg:flex">
        <div className="px-1">
          <Brand />
          <p className="mt-3 truncate text-[12px] text-mist-dim">
            工作区 · <span className="text-mist">{org.name}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => setTab('team')}
          className={cx(
            'press mt-4 flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left',
            tab === 'team' ? 'border-brand/30 bg-brand/10' : 'border-line-soft bg-raise-soft hover:border-line-hi hover:bg-raise',
          )}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/12 text-[12px] font-semibold text-tint-brand" aria-hidden>
            {me.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-paper">{me.name}</span>
            <span className="block truncate text-[11px] text-mist-dim">{ROLE_LABEL[me.role]}</span>
          </span>
        </button>

        <nav className="mt-4 flex flex-col gap-4">
          {GROUPS.map((group) => (
            <div key={group || 'home'}>
              {group ? <p className="px-2 pb-1 text-[11px] font-medium text-mist-dim">{group}</p> : null}
              <div className="flex flex-col gap-0.5">
                {NAV.filter((n) => n.group === group).map((item) => {
                  const on = tab === item.tab;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.tab}
                      type="button"
                      onClick={() => openTab(item.tab)}
                      aria-current={on ? 'page' : undefined}
                      className={cx(
                        'press flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]',
                        on ? 'bg-brand font-semibold text-on-brand' : 'text-mist hover:bg-raise-soft hover:text-paper',
                      )}
                    >
                      <Icon className={cx('h-4 w-4 shrink-0', on ? 'text-on-brand' : 'text-mist-dim')} strokeWidth={1.9} aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 border-t border-line-soft px-1 pt-3">
          <ThemeToggle showLabel />
          <Btn
            variant="quiet"
            icon={LogOut}
            className="justify-start px-2 py-1 text-[12px]"
            onClick={() => void logout()}
          >
            退出登录
          </Btn>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-3 lg:hidden">
          <Brand />
          <ThemeToggle />
        </div>

        <header className="glass-bar sticky top-0 z-30 px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-semibold leading-snug text-paper">{current.label}</h1>
              <p className="mt-0.5 truncate text-[12px] text-mist">{current.desc}</p>
            </div>

            {pickable ? (
              <div className="flex min-w-0 items-center gap-2">
                {interviewList.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => openTab('setup')}
                    className="press rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] text-mist hover:border-line-hi hover:text-paper"
                  >
                    还没有面试 · 去安排
                  </button>
                ) : (
                  <label className="flex min-w-0 items-center gap-2">
                    <span className="hidden shrink-0 text-[12px] text-mist-dim xl:inline">当前面试</span>
                    <select
                      aria-label="当前面试"
                      value={interviewId}
                      onChange={(e) => selectInterview(e.target.value)}
                      className="field-base max-w-[260px] truncate py-1 text-[12px]"
                    >
                      <option value="">选择一场面试…</option>
                      {interviewList.map((x) => (
                        <option key={x.id} value={x.id}>
                          {dir.labelOf(x)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {active ? <InterviewPill status={active.status} /> : null}
              </div>
            ) : null}
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-line-soft px-3 py-2 lg:hidden [scrollbar-gutter:stable]">
          {NAV.map((item) => {
            const on = tab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                onClick={() => openTab(item.tab)}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'press shrink-0 rounded-lg px-2 py-1 text-[12px]',
                  on ? 'bg-brand font-semibold text-on-brand' : 'text-mist hover:bg-raise-soft',
                )}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <main id="main" tabIndex={-1} className="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 py-5 sm:px-6">
          {tab === 'today' ? (
            <TodayScreen
              onOpenInterview={(next, id) => {
                selectInterview(id);
                setTab(next);
              }}
              onOpenStandard={(jobId) => {
                setStandardJobId(jobId);
                setTab('standard');
              }}
              onOpenBoard={(id) => {
                if (id) selectInterview(id);
                setTab('board');
              }}
              onOpenSetup={() => setTab('setup')}
            />
          ) : null}
          {tab === 'setup' ? <SetupScreen onPickInterview={selectInterview} /> : null}
          {tab === 'standard' ? <StandardScreen focusJobId={standardJobId} /> : null}
          {tab === 'prep' ? <PrepScreen interviewId={interviewId} onPickInterview={selectInterview} /> : null}
          {tab === 'live' ? (
            <LiveScreen interviewId={interviewId} onPickInterview={selectInterview} onGoDraft={() => openTab('draft')} />
          ) : null}
          {tab === 'draft' ? <DraftScreen interviewId={interviewId} onPickInterview={selectInterview} /> : null}
          {tab === 'board' ? (
            <BoardScreen
              focusInterviewId={interviewId}
              onPickInterview={selectInterview}
              onGoDraft={() => openTab('draft')}
            />
          ) : null}
          {tab === 'results' ? (
            <ResultsScreen
              onOpenDraft={(id) => {
                selectInterview(id);
                setTab('draft');
              }}
            />
          ) : null}
          {tab === 'compliance' ? <ComplianceScreen /> : null}
          {tab === 'team' ? <TeamScreen /> : null}
        </main>

        <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-3 lg:hidden">
          <p className="min-w-0 truncate text-[12px] text-mist-dim">
            {me.name} · {ROLE_LABEL[me.role]}
          </p>
          <Btn variant="quiet" icon={LogOut} className="shrink-0 px-2 py-1 text-[12px]" onClick={() => void logout()}>
            退出登录
          </Btn>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}
