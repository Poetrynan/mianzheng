import { useEffect, useRef, useState } from 'react';
import { Calendar, Check, ChevronDown, FileText, Plus, User } from 'lucide-react';
import { api } from '../api/client';
import { ROLE_LABEL } from '../ui';
import { messageOf, useLoader, useSession } from '../session';
import {
  Badge,
  Btn,
  Chip,
  Empty,
  ErrorNote,
  Field,
  InterviewPill,
  OkNote,
  Panel,
  Segmented,
  Subhead,
  cx,
} from '../ui';

const EMPTY_INTAKE = {
  jobTitle: '',
  level: '',
  reportsTo: '',
  teamSize: '',
  painPoints: '',
  description: '',
};

const BACKEND_INTAKE = {
  jobTitle: '高级后端工程师',
  level: '高级',
  reportsTo: '技术总监',
  teamSize: '15',
  painPoints: '交易链路扩容压力大、跨团队协作推进吃力、线上故障复盘不到位',
  description: '负责订单与交易核心链路的架构设计、服务拆分与容量治理，需要能独立推动跨团队项目，并在故障后把原因讲清楚。',
};

const FRONTEND_INTAKE = {
  jobTitle: '资深前端工程师',
  level: '专家',
  reportsTo: '研发总监',
  teamSize: '8',
  painPoints: '大前端工程化、微前端迁移、跨团队设计系统建设',
  description: '负责核心前端架构设计与性能优化，需要能推动多个业务线统一组件和发布流程。',
};

const SAMPLE_RESUMES = {
  backend: [
    '张伟 / 13800000000 / zhangwei@example.com',
    '8 年经验，高级后端工程师。',
    '2016.07-2019.06 青禾数据 后端开发工程师',
    '2019.07-2022.05 云帆网络 高级开发工程师',
    '2022.06-至今 云岭科技 技术专家',
    '主导订单交易系统重构，推动 5 个团队完成接口对齐，核心接口耗时降低 40%。',
    '负责交易链路的容量设计与服务拆分，在大促期间保障核心链路零故障。',
    '本科，计算机科学与技术。',
  ].join('\n'),
  frontend: [
    '李雪 / 13900000000 / lixue@example.com',
    '6 年经验，资深前端工程师。',
    '2018.07-2021.05 星野科技 前端工程师',
    '2021.06-至今 澜图网络 高级前端工程师',
    '主导企业 SaaS 平台的微前端迁移，把页面首次加载时间压缩 60%。',
    '负责多端设计系统，统一 20 多个业务线的组件库。',
    '硕士，软件工程。',
  ].join('\n'),
};

const SAMPLE_BTN = 'press rounded-md px-1.5 py-0.5 text-[12px] text-mist hover:bg-raise hover:text-paper';

type NoteKey = 'job' | 'candidate' | 'schedule';
type View = 'job' | 'candidate' | 'schedule';

export function SetupScreen({ onPickInterview }: { onPickInterview: (id: string) => void }) {
  const { org, users, interviews } = useSession();
  const orgId = org?.id ?? '';
  const [view, setView] = useState<View>('candidate');
  const [intake, setIntake] = useState(EMPTY_INTAKE);
  const [candidateName, setCandidateName] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [jobId, setJobId] = useState('');
  const [pickedCandidateId, setPickedCandidateId] = useState('');
  const [pickedInterviewers, setPickedInterviewers] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<NoteKey, { err: string | null; ok: string | null }>>({
    job: { err: null, ok: null },
    candidate: { err: null, ok: null },
    schedule: { err: null, ok: null },
  });

  const noteOf = (key: NoteKey) => notes[key];

  const jobs = useLoader(() => api.listJobs(orgId), [orgId]);
  const candidates = useLoader(() => api.listCandidates(orgId), [orgId]);

  const jobList = jobs.data ?? [];
  const candidateList = candidates.data ?? [];
  const interviewList = interviews.data ?? [];
  const jobsReady = jobs.data !== null;
  const activeJobId = jobId || jobList[0]?.id || '';
  const selectedJob = jobList.find((j) => j.id === activeJobId) ?? null;
  const jobCandidates = candidateList.filter((c) => !c.deletedAt && c.appliedJobId === activeJobId);
  const pickedCandidate = jobCandidates.find((c) => c.id === pickedCandidateId) ?? null;

  const wantedCandidate = useRef<string | null>(null);

  useEffect(() => {
    if (jobId) return;
    const first = jobs.data?.[0];
    if (first) setJobId(first.id);
  }, [jobs.data, jobId]);

  useEffect(() => {
    if (jobs.data && jobs.data.length === 0) setView('job');
  }, [jobs.data]);

  useEffect(() => {
    const list = (candidates.data ?? []).filter((c) => !c.deletedAt && c.appliedJobId === activeJobId);
    const wanted = wantedCandidate.current;
    if (wanted && list.some((c) => c.id === wanted)) {
      wantedCandidate.current = null;
      setPickedCandidateId(wanted);
      return;
    }
    if (!list.some((c) => c.id === pickedCandidateId)) {
      setPickedCandidateId(list[0]?.id ?? '');
    }
  }, [candidates.data, activeJobId, pickedCandidateId]);

  const canSchedule = Boolean(activeJobId) && Boolean(selectedJob?.confirmedStandardId) && Boolean(pickedCandidate);
  const scheduleReady = canSchedule && pickedInterviewers.length > 0;
  const scheduleBlockedReason = !activeJobId
    ? '先新建一个岗位。'
    : !selectedJob?.confirmedStandardId
      ? '考察标准还没定稿，定稿后才能排期。'
      : jobCandidates.length === 0
        ? '这个岗位下还没有候选人。'
        : !pickedCandidate
          ? '先在候选人列表里选一位。'
          : pickedInterviewers.length === 0
            ? '至少选一位面试官。'
            : null;
  const duplicateCandidate =
    Boolean(candidateName.trim()) &&
    candidateList.some(
      (c) => !c.deletedAt && c.appliedJobId === activeJobId && c.name.trim() === candidateName.trim(),
    );

  const priorRounds = pickedCandidate
    ? interviewList.filter((it) => it.candidateId === pickedCandidate.id && it.jobId === activeJobId).map((it) => it.round)
    : [];
  const nextRound = priorRounds.length > 0 ? Math.max(...priorRounds) + 1 : 1;
  const jobMeta = selectedJob
    ? [
        selectedJob.level,
        selectedJob.reportsTo ? `汇报给${selectedJob.reportsTo}` : null,
        selectedJob.teamSize ? `${selectedJob.teamSize} 人` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const refreshAll = () => {
    jobs.reload();
    candidates.reload();
    interviews.reload();
  };

  const run = async (label: string, key: NoteKey, fn: () => Promise<unknown>, done: string) => {
    setPending(label);
    setNotes((prev) => ({ ...prev, [key]: { err: null, ok: null } }));
    try {
      await fn();
      setNotes((prev) => ({ ...prev, [key]: { err: null, ok: done } }));
      refreshAll();
    } catch (err) {
      setNotes((prev) => ({ ...prev, [key]: { err: messageOf(err), ok: null } }));
    } finally {
      setPending(null);
    }
  };

  const interviewers = users.filter((u) => u.role === 'interviewer' || u.role === 'hiring_manager');

  const openJobForm = () => {
    setView('job');
    setNotes((prev) => ({ ...prev, job: { err: null, ok: null } }));
  };

  const interviewLabel = (candidateId: string, jobId2: string): string => {
    const c = candidateList.find((x) => x.id === candidateId);
    const j = jobList.find((x) => x.id === jobId2);
    if (c && j) return `${c.name} · ${j.title}`;
    return c?.name ?? j?.title ?? '面试';
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="surface-2" aria-label="当前岗位">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
          <div className="min-w-0">
            {selectedJob ? (
              <>
                <p className="text-[12px] leading-tight text-mist-dim">当前岗位</p>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="relative flex min-w-0 max-w-[420px] items-center">
                    <select
                      aria-label="切换当前岗位"
                      value={activeJobId}
                      onChange={(e) => setJobId(e.target.value)}
                      className="h-8 w-auto max-w-full min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent py-0 pl-0 pr-6 text-[18px] font-semibold leading-snug text-paper hover:text-brand-hi"
                    >
                      {jobList.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.title}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-1 h-4 w-4 text-mist-dim" strokeWidth={2} aria-hidden />
                  </span>
                  {selectedJob.confirmedStandardId ? (
                    <Badge tone="ok">标准已定稿</Badge>
                  ) : (
                    <Badge tone="warn">待定标准</Badge>
                  )}
                </div>
                {jobMeta ? <p className="mt-1 text-[12px] text-mist">{jobMeta}</p> : null}
                {noteOf('job').ok ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-tint-ok">
                    <Check className="mt-[3px] h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden />
                    <span>{noteOf('job').ok}</span>
                  </p>
                ) : null}
              </>
            ) : jobs.loading ? (
              <>
                <p className="text-[12px] leading-tight text-mist-dim">当前岗位</p>
                <p className="mt-2 text-[15px] text-mist">正在读取岗位…</p>
              </>
            ) : (
              <>
                <h2 className="text-[16px] font-semibold leading-snug text-paper">还没有岗位</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-mist">先建一个岗位，之后的候选人和面试都挂在它下面。</p>
              </>
            )}
          </div>
          <Btn variant={selectedJob ? 'secondary' : 'primary'} icon={Plus} onClick={openJobForm}>
            新建岗位
          </Btn>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<View>
          options={[
            { id: 'job', label: '岗位', badge: jobList.length },
            { id: 'candidate', label: '候选人', badge: jobCandidates.length },
            { id: 'schedule', label: '排期', badge: interviewList.length },
          ]}
          value={view}
          onChange={setView}
          label="岗位、候选人、排期"
        />
        <span className="text-[12px] text-mist-dim">
          {view === 'job'
            ? '岗位定下来，下一步去「考察标准」把要求谈清楚。'
            : view === 'candidate'
              ? '候选人挂在上方选中的岗位下。'
              : '排好期，面试会出现在「今天」和交付看板里。'}
        </span>
      </div>

      {view === 'job' ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(0,1fr)]">
          <Panel title="新建岗位" subtitle="写清这个岗位要解决什么问题，后面的访谈会从这里开始。" icon={Plus}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] text-mist-dim">不想从零写，可以先用一份示例</span>
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-mist-dim">示例</span>
                <button
                  type="button"
                  className={SAMPLE_BTN}
                  aria-label="填入后端岗位示例"
                  onClick={() => setIntake(BACKEND_INTAKE)}
                >
                  后端
                </button>
                <button
                  type="button"
                  className={SAMPLE_BTN}
                  aria-label="填入前端岗位示例"
                  onClick={() => setIntake(FRONTEND_INTAKE)}
                >
                  前端
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-[1.5fr_0.9fr] gap-3 sm:grid-cols-2 xl:grid-cols-[1.5fr_0.9fr_1.1fr_0.7fr]">
              <Field
                label="岗位名称"
                value={intake.jobTitle}
                onChange={(v) => setIntake({ ...intake, jobTitle: v })}
                placeholder="例如：高级后端工程师"
              />
              <Field
                label="职级"
                value={intake.level}
                onChange={(v) => setIntake({ ...intake, level: v })}
                placeholder="例如：高级"
              />
              <Field
                label="汇报对象"
                value={intake.reportsTo}
                onChange={(v) => setIntake({ ...intake, reportsTo: v })}
                placeholder="例如：技术总监"
              />
              <Field
                label="团队人数"
                value={intake.teamSize}
                onChange={(v) => setIntake({ ...intake, teamSize: v })}
                placeholder="例如：15"
                inputMode="numeric"
              />
            </div>
            <div className="mt-4 grid gap-3 border-t border-line-soft pt-4 lg:grid-cols-[1fr_1.3fr]">
              <Field
                label="最需要解决的问题"
                multiline
                rows={3}
                value={intake.painPoints}
                onChange={(v) => setIntake({ ...intake, painPoints: v })}
                placeholder="例如：交易链路扩容压力大、跨团队协作推进吃力"
                hint="写得越具体，后面访谈越容易问出真实标准。"
              />
              <Field
                label="岗位描述"
                multiline
                rows={3}
                value={intake.description}
                onChange={(v) => setIntake({ ...intake, description: v })}
                placeholder="写清主要职责，以及希望这个人解决什么问题。"
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Btn
                variant="primary"
                busy={pending === '建岗位'}
                busyLabel="创建中…"
                disabled={pending !== null || !intake.jobTitle.trim()}
                disabledReason={!intake.jobTitle.trim() ? '填写岗位名称。' : undefined}
                onClick={() =>
                  void run(
                    '建岗位',
                    'job',
                    async () => {
                      const job = await api.createJob({ ...intake, teamSize: Number(intake.teamSize) || 0 });
                      setJobId(job.id);
                      setIntake(EMPTY_INTAKE);
                      return job;
                    },
                    '岗位已创建。下一步去「考察标准」把要求定下来。',
                  )
                }
                icon={Plus}
              >
                创建岗位
              </Btn>
              {!intake.jobTitle.trim() ? (
                <span className="text-[12px] text-mist-dim">填写岗位名称后即可创建。</span>
              ) : null}
            </div>
            <ErrorNote message={noteOf('job').err} />
          </Panel>

          <Panel
            title={`已有岗位（${jobList.length}）`}
            subtitle="切换岗位后，候选人和排期都会跟着它走。"
            icon={FileText}
          >
            {!jobsReady ? (
              <Empty text="正在读取岗位…" />
            ) : jobList.length === 0 ? (
              <Empty text="还没有岗位，先在左边建一个。" />
            ) : (
              <div className="flex flex-col gap-1">
                {jobList.map((j) => {
                  const on = j.id === activeJobId;
                  const count = candidateList.filter((c) => !c.deletedAt && c.appliedJobId === j.id).length;
                  return (
                    <button
                      key={j.id}
                      type="button"
                      onClick={() => setJobId(j.id)}
                      aria-pressed={on}
                      className={cx(
                        'press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left',
                        on ? 'bg-brand/[0.06]' : 'hover:bg-raise-soft',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-paper">{j.title}</span>
                        <span className="mt-0.5 block text-[11px] text-mist-dim">
                          {[j.level, j.teamSize ? `${j.teamSize} 人` : null, `${count} 位候选人`]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <Badge tone={j.confirmedStandardId ? 'ok' : 'warn'}>
                        {j.confirmedStandardId ? '标准已定稿' : '待定标准'}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {view === 'candidate' ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Panel
            title="添加候选人"
            subtitle="粘贴简历正文，系统会把经历和考察标准放在一起对照。只保存文字，不保存原件。"
            icon={FileText}
          >
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <div className="w-full max-w-[180px] sm:max-w-[240px]">
                <Field label="姓名" value={candidateName} onChange={setCandidateName} placeholder="例如：张伟" />
              </div>
              <div className="flex items-center gap-1 pb-2">
                <span className="text-[11px] text-mist-dim">示例</span>
                <button
                  type="button"
                  className={SAMPLE_BTN}
                  aria-label="填入张伟的示例简历"
                  onClick={() => {
                    setCandidateName('张伟');
                    setResumeText(SAMPLE_RESUMES.backend);
                  }}
                >
                  张伟
                </button>
                <button
                  type="button"
                  className={SAMPLE_BTN}
                  aria-label="填入李雪的示例简历"
                  onClick={() => {
                    setCandidateName('李雪');
                    setResumeText(SAMPLE_RESUMES.frontend);
                  }}
                >
                  李雪
                </button>
              </div>
            </div>
            <div className="mt-3">
              <Field
                label="简历正文"
                multiline
                rows={8}
                value={resumeText}
                onChange={setResumeText}
                placeholder="把简历正文粘贴到这里，不用整理格式。"
                hint={
                  !jobsReady
                    ? '正在读取岗位…'
                    : selectedJob
                      ? `将添加到「${selectedJob.title}」下。`
                      : '先新建一个岗位，再添加候选人。'
                }
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Btn
                variant="primary"
                busy={pending === '入库'}
                busyLabel="添加中…"
                disabled={pending !== null || !activeJobId || duplicateCandidate || !candidateName.trim() || !resumeText.trim()}
                disabledReason={
                  !activeJobId
                    ? '先新建一个岗位。'
                    : duplicateCandidate
                      ? '这个岗位下已有同名候选人。'
                      : !candidateName.trim()
                        ? '填写候选人姓名。'
                        : !resumeText.trim()
                          ? '粘贴简历正文。'
                          : undefined
                }
                onClick={() =>
                  void run(
                    '入库',
                    'candidate',
                    async () => {
                      const created = await api.addCandidate(activeJobId, candidateName, resumeText);
                      wantedCandidate.current = created.id;
                      setCandidateName('');
                      setResumeText('');
                      return created;
                    },
                    '候选人已添加。去「排期」安排这一轮面试。',
                  )
                }
                icon={User}
              >
                添加候选人
              </Btn>
              {duplicateCandidate ? (
                <span className="text-[12px] text-warn">这个岗位下已有同名候选人。</span>
              ) : null}
            </div>
            <ErrorNote message={noteOf('candidate').err} />
            <OkNote message={noteOf('candidate').ok} />
          </Panel>

          <Panel
            title={`本岗位候选人（${jobCandidates.length}）`}
            subtitle={selectedJob ? `挂在「${selectedJob.title}」下，选中的人用于排期。` : '先选一个岗位。'}
            icon={User}
          >
            <div className="flex flex-col gap-0.5">
              {jobCandidates.length === 0 ? (
                <Empty
                  icon={User}
                  text={!jobsReady ? '正在读取岗位…' : activeJobId ? '还没有候选人，粘贴简历后添加。' : '先新建一个岗位。'}
                />
              ) : null}
              {jobCandidates.map((c) => {
                const on = pickedCandidateId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPickedCandidateId(c.id)}
                    aria-pressed={on}
                    className={cx(
                      'press flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left',
                      on ? 'bg-brand/[0.06]' : 'hover:bg-raise-soft',
                    )}
                  >
                    <span
                      className={cx(
                        'grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                        on ? 'border-brand bg-brand text-on-brand' : 'border-line-field text-transparent',
                      )}
                    >
                      <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-paper">{c.name}</span>
                    <Badge tone={c.resume.parseFailed ? 'warn' : 'idle'}>
                      {c.resume.parseFailed ? '需要补充' : `${c.resume.companies.length} 段经历`}
                    </Badge>
                  </button>
                );
              })}
            </div>
            {jobCandidates.length > 0 ? (
              <p className="mt-3 border-t border-line-soft pt-3 text-[12px] leading-relaxed text-mist-dim">
                选中一位，再去「排期」选面试官。
              </p>
            ) : null}
          </Panel>
        </div>
      ) : null}

      {view === 'schedule' ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <Panel title="排期面试" subtitle="面试结束后自动进入面评交付清单。" icon={Calendar}>
            <div className="flex items-center justify-between gap-2">
              <Subhead as={4}>排期对象</Subhead>
              {pickedCandidate ? <span className="text-[11px] text-mist-dim">第 {nextRound} 轮 · 视频面</span> : null}
            </div>
            {pickedCandidate ? (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-raise-soft px-3 py-2">
                <User className="h-3.5 w-3.5 shrink-0 text-mist-dim" strokeWidth={1.9} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-paper">{pickedCandidate.name}</span>
                {pickedCandidate.email ? (
                  <span className="min-w-0 max-w-[55%] shrink-0 truncate text-[11px] text-mist-dim">{pickedCandidate.email}</span>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setView('candidate')}
                className="press mt-2 w-full rounded-lg border border-dashed border-line px-3 py-2.5 text-left text-[12px] text-mist-dim hover:border-line-hi hover:text-paper"
              >
                还没有选中候选人，去「候选人」选一位
              </button>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <Subhead as={4}>面试官</Subhead>
              <span className="text-[11px] text-mist-dim">可多选</span>
            </div>
            <div className="mt-1.5 flex flex-col gap-0.5">
              {interviewers.map((u) => {
                const on = pickedInterviewers.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() =>
                      setPickedInterviewers((prev) =>
                        prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id],
                      )
                    }
                    aria-pressed={on}
                    className={cx(
                      'press flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left',
                      on ? 'bg-brand/[0.06]' : 'hover:bg-raise-soft',
                    )}
                  >
                    <span
                      className={cx(
                        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border',
                        on ? 'border-brand bg-brand text-on-brand' : 'border-line-field text-transparent',
                      )}
                    >
                      <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                    </span>
                    <span className={cx('min-w-0 flex-1 truncate text-[13px]', on ? 'font-medium text-paper' : 'text-mist')}>
                      {u.name}
                    </span>
                    {u.role === 'hiring_manager' ? (
                      <span className="shrink-0 text-[11px] text-mist-dim">{ROLE_LABEL[u.role]}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-4">
              <Btn
                variant={scheduleReady ? 'primary' : 'secondary'}
                full
                busy={pending === '排期'}
                busyLabel="安排中…"
                disabled={pending !== null || !scheduleReady}
                disabledReason={scheduleBlockedReason ?? undefined}
                onClick={() =>
                  void run(
                    '排期',
                    'schedule',
                    () => {
                      const candidate = pickedCandidate;
                      if (!candidate) throw new Error('先在候选人列表里选一位。');
                      return api
                        .schedule({
                          jobId: activeJobId,
                          candidateId: candidate.id,
                          interviewerIds: pickedInterviewers,
                          scheduledAt: new Date().toISOString(),
                          channel: 'video',
                          round: nextRound,
                        })
                        .then((it) => {
                          onPickInterview(it.id);
                          return it;
                        });
                    },
                    '面试已排好，并设为当前面试。',
                  )
                }
                icon={Calendar}
              >
                确认排期
              </Btn>
              {scheduleBlockedReason ? (
                <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">{scheduleBlockedReason}</p>
              ) : null}
              <ErrorNote message={noteOf('schedule').err} />
              <OkNote message={noteOf('schedule').ok} />
            </div>
          </Panel>

          <Panel
            title={`已排期（${interviewList.length}）`}
            subtitle="点一场可以直接进去准备。"
            icon={Calendar}
          >
            {interviewList.length === 0 ? <Empty text="还没有面试" /> : null}
            <div className="flex flex-col gap-1.5">
              {interviewList.map((it) => (
                <Chip
                  key={it.id}
                  selected={false}
                  onClick={() => onPickInterview(it.id)}
                  right={<InterviewPill status={it.status} />}
                >
                  {interviewLabel(it.candidateId, it.jobId)} · 第 {it.round} 轮
                </Chip>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
