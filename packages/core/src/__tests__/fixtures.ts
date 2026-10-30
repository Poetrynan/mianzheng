import { FixedClock } from '../clock.js';
import type { MianYanApp } from '../app.js';
import { MockLlmProvider } from '../ai/mockLlm.js';
import { DIMENSION_LIBRARY } from '../ai/dimensionLibrary.js';
import { humanActor } from '../services/context.js';
import type { Interview, JobStandard, TranscriptSegment, User } from '../types.js';
import { MockTranscriptionProvider } from '../ai/asr.js';

export const RESUME_TEXT = [
  '张伟 / 13800000000 / zhangwei@example.com',
  '8 年经验，后端工程师。',
  '2016.07-2019.06 恒生数据 后端开发工程师',
  '2019.03-2022.05 云帆网络 高级开发工程师',
  '2023.06-至今 云链科技 技术专家',
  '主导订单系统重构，负责跨部门对齐，推动 5 个团队协作，接口耗时降低 40%。',
  '负责交易链路的架构设计与高可用扩容，主导服务拆分与缓存分层。',
  '本科，华中科技大学 计算机专业。',
].join('\n');

/** Exercises every evidence path: grounded positive, mixed, external attribution, and no-signal. */
export const TRANSCRIPT_TEXT = [
  '[00:00:20] 面试官：请先做个自我介绍。',
  '[00:01:05] 候选人：我做后端 8 年，最近三年在云链科技做技术专家。',
  '[00:03:40] 面试官：讲一次你主导的架构决策。',
  '[00:04:10] 候选人：我主导了订单系统的架构重构，当时考虑过引入消息队列异步化，我权衡后选了分库分表加缓存，因为扩容成本更低，最后接口耗时降低了 40%。',
  '[00:07:02] 面试官：跨部门的事情你怎么推动？',
  '[00:07:35] 候选人：订单重构要改上下游接口，我主动牵头做了跨部门对齐会，推动了 5 个团队按新规范协作，我把联调排期提前了一周。',
  '[00:11:20] 面试官：压力大的时候你怎么处理？',
  '[00:11:50] 候选人：那次线上故障很紧急，其实是同事没配合好，环境问题导致我们没办法提前发现，我只是按照流程走完。',
  '[00:15:10] 面试官：如果流量涨十倍，你的设计先崩在哪里？',
  '[00:15:45] 候选人：我先看数据，当时用压测数据验证瓶颈在读库，我提出加只读副本和缓存分层，最后成本降低了三成。',
].join('\n');

export const FIXTURE_DIMENSIONS = ['系统设计能力', '跨部门推动力', '抗压稳定性', '结构化表达'];

export interface SeededTeam {
  orgId: string;
  hr: User;
  interviewer: User;
  manager: User;
  jobId: string;
}

export function defaultAppDeps(): { clock: FixedClock; llm: MockLlmProvider; asr: MockTranscriptionProvider } {
  const clock = new FixedClock('2026-03-02T01:00:00.000Z');
  return { clock, llm: new MockLlmProvider(), asr: new MockTranscriptionProvider() };
}

export function seedTeam(app: MianYanApp): SeededTeam {
  const org = app.createOrg('杭州某科技有限公司');
  const hr = app.addUser(org.id, 'hr', '李 HR', 'hr@example.com');
  const interviewer = app.addUser(org.id, 'interviewer', '王 面试官', 'iv@example.com');
  const manager = app.addUser(org.id, 'hiring_manager', '赵 经理', 'mgr@example.com');
  const job = app.createJob(org.id, {
    jobTitle: '高级后端工程师',
    level: 'P7',
    reportsTo: '技术总监',
    teamSize: 12,
    painPoints: '交易系统扩容、跨部门推动',
    description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
  });
  return { orgId: org.id, hr, interviewer, manager, jobId: job.id };
}

/** Test-only fast path: a confirmed standard without replaying the whole dialog. */
export function seedConfirmedStandard(app: MianYanApp, team: SeededTeam, names: string[] = FIXTURE_DIMENSIONS): JobStandard {
  const job = app.store.findJob(team.jobId);
  if (!job) throw new Error('job missing');
  const std: JobStandard = {
    id: 'std_fixture',
    jobId: job.id,
    orgId: team.orgId,
    version: 'v1.0',
    status: 'confirmed',
    dimensions: names.map((name, i) => {
      const entry = DIMENSION_LIBRARY.find((e) => e.name === name);
      if (!entry) throw new Error(`unknown library dimension ${name}`);
      return {
        id: `dim_fixture_${i}`,
        standardId: 'std_fixture',
        name: entry.name,
        positiveEvidence: [...entry.positiveEvidence],
        redFlags: [...entry.redFlags],
        probes: [...entry.probes],
        matchKeywords: [...entry.matchKeywords],
        createdBy: 'fixture',
        confirmedBy: team.manager.id,
      };
    }),
    createdBy: team.hr.id,
    confirmedByHiringManager: team.manager.id,
    confirmedByHr: team.hr.id,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    intake: {
      jobTitle: job.title,
      level: job.level ?? '',
      reportsTo: job.reportsTo ?? '',
      teamSize: job.teamSize ?? 0,
      painPoints: job.description,
      description: job.description,
    },
    answers: [],
    revisionCounts: {},
    conflicts: [],
  };
  app.store.saveStandard(std);
  app.store.saveJob({ ...job, confirmedStandardId: std.id });
  return std;
}

/** The real route: intake -> AI asks the script -> draft -> per-dimension confirm -> dual sign -> v1.0. */
export async function runM1ToConfirmed(app: MianYanApp, team: SeededTeam): Promise<JobStandard> {
  const hrActor = humanActor(team.hr);
  const mgrActor = humanActor(team.manager);
  const job = app.store.findJob(team.jobId);
  if (!job) throw new Error('job missing');

  let std = app.goldenStandard.startIntake(hrActor, job.id, {
    jobTitle: job.title,
    level: job.level ?? 'P7',
    reportsTo: job.reportsTo ?? '',
    teamSize: job.teamSize ?? 0,
    painPoints: job.description,
    description: job.description,
  });

  const answers = [
    '核心问题是交易系统在高并发下不稳定，需要一个能主导架构扩容、又能推动跨部门协作落地的后端专家。',
    '上一任技术深度够，但跨部门推动力不足，遇到协作阻力就等上级拍板；结构化表达也偏弱，汇报时听不出重点。',
    '只做到 60 分的话，他会讲不清扩容方案的取舍，只罗列组件名，压力大的时候习惯把原因归给同事或环境。',
    '明显的例子是去年大促：他自己牵头把订单链路的架构重构落地了，压测数据也是他先提出来要看的。',
    '直接警惕的是把线上故障归因给同事没配合、环境不行，或者全程只讲动作不讲结果。',
    '最需要跟上下游业务团队和基础架构团队打交道，最容易卡在联调排期和接口规范对齐上。',
    '我会让他具体讲一次跨部门推动的架构重构，问当时的第二方案、为什么放弃、以及涨十倍先崩在哪里。',
    '未来一年交易规模翻倍，额外要求他能用数据定义问题、有合规与风险意识。',
  ];

  for (const text of answers) {
    const question = app.goldenStandard.nextQuestion(std.id);
    if (question === null) break;
    std = app.goldenStandard.recordAnswer(mgrActor, std.id, question, text).standard;
  }

  const proposed = await app.goldenStandard.proposeDraft(mgrActor, std.id);
  std = proposed.standard;
  if (std.conflicts.length > 0) {
    for (const conflict of std.conflicts) {
      std = app.goldenStandard.resolveConflict(hrActor, std.id, conflict.dimensionId, 'keep_standard');
    }
  }
  for (const dim of std.dimensions) {
    std = app.goldenStandard.confirmDimension(mgrActor, std.id, dim.id);
  }
  std = app.goldenStandard.sign(mgrActor, std.id, 'hiring_manager');
  std = app.goldenStandard.sign(hrActor, std.id, 'hr');
  return app.goldenStandard.finalize(hrActor, std.id);
}

export interface OpenedInterview {
  candidateId: string;
  interview: Interview;
  segments: TranscriptSegment[];
  consentId: string;
}

/** Consent -> start -> (transcribe). Does not finish, so tests can drive the tail. */
export async function openInterview(
  app: MianYanApp,
  team: SeededTeam,
  opts: { consent?: 'granted' | 'refused'; scheduledAt?: string; resumeText?: string } = {},
): Promise<OpenedInterview> {
  const decision = opts.consent ?? 'granted';
  const candidate = app.addCandidate(team.orgId, team.jobId, '张伟', opts.resumeText ?? RESUME_TEXT);
  const interview = app.flow.schedule(humanActor(team.hr), {
    jobId: team.jobId,
    candidateId: candidate.id,
    interviewerIds: [team.interviewer.id],
    scheduledAt: opts.scheduledAt ?? '2026-03-02T01:00:00.000Z',
    channel: 'video',
    round: 1,
  });

  const prompt = app.flow.presentConsent(interview.id);
  const consent = app.flow.answerConsent(humanActor(team.hr), interview.id, decision, prompt.presentedAt);
  const started = app.flow.start(humanActor(team.interviewer), interview.id);

  const raw = await app.ctx.asr.transcribe({ inlineTranscript: TRANSCRIPT_TEXT });
  const segments = decision === 'granted' ? app.flow.appendSegments(humanActor(team.interviewer), interview.id, raw).saved : [];
  return { candidateId: candidate.id, interview: started, segments, consentId: consent.id };
}

/** finish -> eval_pending -> reminders queued. */
export function closeInterview(app: MianYanApp, team: SeededTeam, interviewId: string): Interview {
  const finished = app.flow.finish(humanActor(team.interviewer), interviewId);
  const pending = app.store.findInterview(interviewId) as Interview;
  app.reminders.queueForInterview(humanActor(team.hr), pending.id);
  return finished;
}
