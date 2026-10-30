import { MockLlmProvider } from '../ai/mockLlm.js';
import { MockTranscriptionProvider } from '../ai/asr.js';
import { MianYanApp } from '../app.js';
import { FixedClock, HOUR_MS } from '../clock.js';
import { humanActor } from '../services/context.js';
import type { AgentBundle } from '../agent/service.js';
import type { FeedbackDraft, JobStandard, User } from '../types.js';

const DB_PATH = process.env.MIANYAN_DB_PATH ?? 'data/seed.db';

const ROLE_LABEL: Record<string, string> = { hr: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' };

const INTAKE = {
  jobTitle: '高级后端工程师',
  level: 'P7',
  reportsTo: '技术总监',
  teamSize: 12,
  painPoints: '交易系统扩容、跨部门推动',
  description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
};

const INTERVIEW_ANSWERS = [
  '核心问题是交易系统在高并发下不稳定，需要一个能主导架构扩容、又能推动跨部门协作落地的后端专家。',
  '只做到 60 分的话，他会讲不清扩容方案的取舍，只罗列组件名；做到 90 分的人会讲清第二方案、代价和验证数据，压力大的时候也不把原因推给同事或环境。',
  '明显的例子是去年大促：他自己牵头把订单链路的架构重构落地了，压测数据也是他先提出来要看的。',
  '直接警惕的是把线上故障归因给同事没配合、环境不行，或者全程只讲动作不讲结果。',
];

const RESUME_TEXT = [
  '张伟 / 13800000000 / zhangwei@example.com',
  '8 年经验，后端工程师。',
  '2016.07-2019.06 恒生数据 后端开发工程师',
  '2019.07-2022.05 云帆网络 高级开发工程师',
  '2023.06-至今 云链科技 技术专家',
  '主导订单系统重构，负责跨部门对齐，推动 5 个团队协作，接口耗时降低 40%。',
  '负责交易链路的架构设计与高可用扩容，主导服务拆分与缓存分层。',
  '本科，华中科技大学 计算机专业。',
].join('\n');

const RESUME_NA = [
  '李娜 / 13900000000 / lina@example.com',
  '6 年经验，后端工程师。',
  '2020.03-2023.08 星河支付 后端工程师',
  '2023.09-至今 云链科技 高级开发工程师',
  '参与订单系统重构，负责其中一个模块的接口改造。',
  '本科，浙江工业大学 软件工程专业。',
].join('\n');

const RESUME_ZHOU = [
  '周航 / 13700000000 / zhouhang@example.com',
  '7 年经验，后端工程师。',
  '2019.04-2024.02 拾光科技 后端开发工程师',
  '负责交易系统日常维护与线上问题排查。',
  '本科，南京理工大学 计算机专业。',
].join('\n');

const TRANSCRIPT_TEXT = [
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

/** 李娜那份转写：跨团队说得清，架构取舍没参与，线上问题把原因归给上游——留着当「不达标 + 红旗 + 缺口」的样本。 */
const LINA_TRANSCRIPT_TEXT = [
  '[00:00:18] 面试官：请先做个自我介绍。',
  '[00:00:50] 候选人：我做后端 6 年，之前在星河支付做支付网关，去年到云链，参与订单系统重构里的一个模块。',
  '[00:03:12] 面试官：说一次你推动跨团队的经历。',
  '[00:03:40] 候选人：那次接口改造要跟上下游对，我拉了群，把改动点和时间点发出去，每周在群里同步一次进度，最后按时上线了。',
  '[00:07:05] 面试官：系统拆分的时候你们怎么考虑取舍？',
  '[00:07:30] 候选人：这个主要是架构组定的方案，我按分工做了自己那块，具体取舍我没参与。',
  '[00:11:10] 面试官：线上出过问题吗，怎么处理的？',
  '[00:11:35] 候选人：有一次是上游变更没通知我们，环境也不稳定，我们排查了一晚上，最后是运维那边先发现的。',
  '[00:15:00] 面试官：如果流量涨十倍，你的设计先崩在哪里？',
  '[00:15:20] 候选人：这个还没细想过，应该是数据库吧。',
].join('\n');
async function runStandardAgent(app: MianYanApp, hr: User, manager: User, jobId: string): Promise<{ standard: JobStandard; runId: string }> {
  const hrActor = humanActor(hr);
  const mgrActor = humanActor(manager);
  let bundle: AgentBundle = await app.agent.startStandard(mgrActor, jobId, INTAKE);
  let index = 0;
  while (bundle.run.status === 'awaiting_human' && index < INTERVIEW_ANSWERS.length) {
    const answer = INTERVIEW_ANSWERS[index];
    if (!answer) break;
    bundle = await app.agent.answer(bundle.run.id, mgrActor, answer);
    index += 1;
  }
  let std = bundle.standard;
  if (!std) throw new Error('定标助手没有产出标准草稿');
  for (const conflict of std.conflicts) {
    std = app.goldenStandard.resolveConflict(hrActor, std.id, conflict.dimensionId, 'keep_standard');
  }
  for (const dim of std.dimensions) {
    std = app.goldenStandard.confirmDimension(mgrActor, std.id, dim.id);
  }
  std = app.goldenStandard.sign(mgrActor, std.id, 'hiring_manager');
  std = app.goldenStandard.sign(hrActor, std.id, 'hr');
  std = app.goldenStandard.finalize(hrActor, std.id);
  return { standard: std, runId: bundle.run.id };
}

/** The gap question is the agent's one human gate here; the seed answers it the way a real interviewer would. */
async function runEvaluationAgent(app: MianYanApp, interviewer: User, interviewId: string): Promise<{ runId: string; draft: FeedbackDraft }> {
  const actor = humanActor(interviewer);
  let bundle = await app.agent.startEvaluation(actor, interviewId, interviewer.id);
  while (bundle.run.status === 'awaiting_human') {
    const options = bundle.run.question?.options ?? [];
    if (!options.some((option) => option.value === 'carry_over')) break;
    bundle = await app.agent.answer(bundle.run.id, actor, 'carry_over');
  }
  if (!bundle.draft) throw new Error('面评助手没有产出草稿');
  return { runId: bundle.run.id, draft: bundle.draft };
}

/** 一场从头跑到能交面评的面试：排期、一页纸、同意、转写、结束。 */
async function runInterview(
  app: MianYanApp,
  hr: User,
  interviewer: User,
  input: { jobId: string; candidateId: string; round: number; scheduledAt: Date; transcript: string },
): Promise<{ interviewId: string; prepRunId: string }> {
  const interview = app.flow.schedule(humanActor(hr), {
    jobId: input.jobId,
    candidateId: input.candidateId,
    interviewerIds: [interviewer.id],
    scheduledAt: input.scheduledAt.toISOString(),
    channel: 'video',
    round: input.round,
  });
  const prep = await app.agent.startPrep(humanActor(interviewer), interview.id);
  if (!prep.pack) throw new Error('准备助手没有产出一页纸');
  const prompt = app.flow.presentConsent(interview.id);
  app.flow.answerConsent(humanActor(hr), interview.id, 'granted', prompt.presentedAt);
  app.flow.start(humanActor(interviewer), interview.id);
  const raw = await app.ctx.asr.transcribe({ inlineTranscript: input.transcript });
  app.flow.appendSegments(humanActor(interviewer), interview.id, raw);
  app.flow.finish(humanActor(interviewer), interview.id);
  app.reminders.queueForInterview(humanActor(hr), interview.id);
  return { interviewId: interview.id, prepRunId: prep.run.id };
}

async function main(): Promise<void> {
  const llm = new MockLlmProvider();
  /** 整库的时间锚在三天前：HR 今天打开看板时，第一轮那场面试的 24 小时窗口是真的关掉的，准时率与可用率才有数字。 */
  const clock = new FixedClock(new Date(Date.now() - 72 * HOUR_MS));
  const app = await MianYanApp.open({ dbPath: DB_PATH, clock, llm, asr: new MockTranscriptionProvider() });

  const existing = app.store.listOrgs();
  if (existing.length > 0) {
    console.log(
      `${DB_PATH} 里已有 ${existing.length} 个工作区（例如「${existing[0]?.name}」）。` +
        '为避免把演示数据叠在真实数据上，本脚本只在空库上执行；换一个 MIANYAN_DB_PATH 或删掉该文件。',
    );
    process.exitCode = 1;
    return;
  }

  const accounts: Array<[role: 'hr' | 'interviewer' | 'hiring_manager', name: string, email: string]> = [
    ['hr', '李 HR', 'hr@demo.mianzheng.local'],
    ['interviewer', '王 面试官', 'wang@demo.mianzheng.local'],
    ['hiring_manager', '赵 经理', 'zhao@demo.mianzheng.local'],
  ];
  const password = process.env.MIANYAN_DEMO_PASSWORD ?? 'mianzheng2026';

  const org = app.createOrg('杭州演示科技有限公司');
  const hr = app.addUser(org.id, 'hr', '李 HR');
  const interviewer = app.addUser(org.id, 'interviewer', '王 面试官');
  const manager = app.addUser(org.id, 'hiring_manager', '赵 经理');
  for (const [role, name, email] of accounts) {
    const user = [hr, interviewer, manager].find((u) => u.role === role && u.name === name);
    if (user) app.auth.attachAccount(user, email, password);
  }
  const job = app.createJob(org.id, INTAKE);

  const { standard, runId: standardRunId } = await runStandardAgent(app, hr, manager, job.id);

  const candidate = app.addCandidate(org.id, job.id, '张伟', RESUME_TEXT);
  const interview = app.flow.schedule(humanActor(hr), {
    jobId: job.id,
    candidateId: candidate.id,
    interviewerIds: [interviewer.id],
    scheduledAt: app.ctx.clock.now().toISOString(),
    channel: 'video',
    round: 1,
  });
  const prep = await app.agent.startPrep(humanActor(interviewer), interview.id);
  if (!prep.pack) throw new Error('准备助手没有产出一页纸');

  const prompt = app.flow.presentConsent(interview.id);
  app.flow.answerConsent(humanActor(hr), interview.id, 'granted', prompt.presentedAt);
  app.flow.start(humanActor(interviewer), interview.id);
  const raw = await app.ctx.asr.transcribe({ inlineTranscript: TRANSCRIPT_TEXT });
  const segments = app.flow.appendSegments(humanActor(interviewer), interview.id, raw).saved;
  app.flow.finish(humanActor(interviewer), interview.id);
  app.reminders.queueForInterview(humanActor(hr), interview.id);

  const evaluation = await runEvaluationAgent(app, interviewer, interview.id);
  const draft = evaluation.draft;
  const reviewer = humanActor(interviewer);
  for (const check of draft.checks) {
    if (!check.aiScore) continue;
    app.evaluation.reviseCheck(reviewer, draft.id, check.id, {
      finalScore: check.aiScore,
      finalSummary: check.aiSummary ?? '有原话支撑，按原话记录。',
      addEvidenceSegmentIds: check.aiEvidence.map((evidence) => evidence.segmentId),
    });
  }
  app.evaluation.setRecommendation(
    reviewer,
    draft.id,
    '技术判断与架构取舍有原话支撑，建议进入下一轮；下一轮先补问这一轮没有拿到原话的维度。',
  );
  const submitted = app.evaluation.submit(reviewer, draft.id, {
    fillUnscored: true,
    agreeUsedForDecision: true,
    anonymizeName: true,
  });

  // 面评是当场交掉的，窗口要真的过 24 小时，看板的准时率/可用率才不是「暂无」。
  clock.advanceHours(26);

  const secondRound = app.flow.schedule(humanActor(hr), {
    jobId: job.id,
    candidateId: candidate.id,
    interviewerIds: [interviewer.id],
    scheduledAt: new Date(app.ctx.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    channel: 'video',
    round: 2,
  });
  const secondPrep = await app.agent.startPrep(humanActor(interviewer), secondRound.id);
  if (!secondPrep.pack) throw new Error('第二轮准备助手没有产出一页纸');

  // 李娜：面评拖到第 30 小时才交，而且只看了两维、还有一维凭印象打了分却没留原话——矩阵上该出现的空圈和空格都出现在她身上。
  const na = app.addCandidate(org.id, job.id, '李娜', RESUME_NA);
  const naRun = await runInterview(app, hr, interviewer, {
    jobId: job.id,
    candidateId: na.id,
    round: 1,
    scheduledAt: app.ctx.clock.now(),
    transcript: LINA_TRANSCRIPT_TEXT,
  });
  const naEvaluation = await runEvaluationAgent(app, interviewer, naRun.interviewId);
  const naDraft = naEvaluation.draft;
  const backedChecks = naDraft.checks.filter((c) => c.aiEvidence.length > 0).slice(0, 2);
  for (const check of backedChecks) {
    app.evaluation.reviseCheck(reviewer, naDraft.id, check.id, {
      finalScore: check.aiScore ?? 'medium',
      finalSummary: '有原话，按原话记录。',
      addEvidenceSegmentIds: check.aiEvidence.map((evidence) => evidence.segmentId),
    });
  }
  const bareCheck = naDraft.checks.find((c) => !backedChecks.includes(c));
  if (bareCheck) {
    app.evaluation.reviseCheck(reviewer, naDraft.id, bareCheck.id, {
      finalScore: 'medium',
      finalSummary: '面完有印象，但这段转写里没找到能引用的话。',
    });
  }
  app.evaluation.setRecommendation(reviewer, naDraft.id, '只来得及看前两维，剩下两维还没看；缺口带到下一轮。');
  clock.advanceHours(30);
  app.evaluation.submit(reviewer, naDraft.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: true });

  // 周航：面试排在明天，还没面——结果屏上是一行全空的记录，不是不显示。
  const zhou = app.addCandidate(org.id, job.id, '周航', RESUME_ZHOU);
  const zhouInterview = app.flow.schedule(humanActor(hr), {
    jobId: job.id,
    candidateId: zhou.id,
    interviewerIds: [interviewer.id],
    scheduledAt: new Date(app.ctx.clock.now().getTime() + 24 * HOUR_MS).toISOString(),
    channel: 'video',
    round: 1,
  });

  const evidenced = submitted.checks.filter((c) => c.aiEvidence.length > 0).length;
  const gaps = submitted.checks.filter((c) => c.aiScore === null).length;
  const naSubmitted = app.store.listDraftsByInterview(naRun.interviewId).find((d) => d.status === 'submitted');
  const naGaps = naSubmitted ? naSubmitted.checks.filter((c) => c.aiScore === null).length : 0;
  const board = app.board.overview(org.id);
  const pct = (rate: number | null): string => (rate === null ? '暂无' : `${Math.round(rate * 100)}%`);
  const runCount = [standardRunId, prep.run.id, evaluation.runId, secondPrep.run.id, naRun.prepRunId, naEvaluation.runId].length;
  console.log(
    [
      `库 ${DB_PATH}`,
      `工作区 ${org.name} · ${org.id}`,
      `账号 ${accounts.map(([role, name, email]) => `${name}(${ROLE_LABEL[role] ?? role}) ${email}`).join(' / ')}`,
      `密码 ${password}（可用 MIANYAN_DEMO_PASSWORD 覆盖；这是本地演示库，不要用于真实候选人数据）`,
      `岗位 ${job.title} · ${job.id}`,
      `金标准 ${standard.version} · ${standard.status} · ${standard.dimensions.length} 个维度（助手访谈 ${standard.answers.length} 轮）`,
      `候选人 ${candidate.name} · 经历 ${candidate.resume.companies.length} 段`,
      `第一轮 ${interview.id} · 一页纸 ${prep.pack.questions.length} 条追问 · 转写 ${segments.length} 段`,
      `面评 ${draft.id} · ${submitted.status} · 有原话 ${evidenced}/${submitted.checks.length} · 缺口 ${gaps} 条（面试官选择带到下一轮）`,
      `第二轮 ${secondRound.id} · 一页纸 ${secondPrep.pack.questions.length} 条追问 · 带过来的缺口 ${secondPrep.pack.carryOver?.length ?? 0} 条`,
      `候选人 李娜 · 面评 ${naDraft.id} · ${naSubmitted?.status ?? '未提交'} · 只有 ${backedChecks.length} 维挂了原话 · 缺口 ${naGaps} 条 · 第 30 小时才交`,
      `候选人 周航 · 面试 ${zhouInterview.id} · 排在 ${zhouInterview.scheduledAt.slice(0, 16).replace('T', ' ')}，还没有面评`,
      `助手任务 ${runCount} 次，每一屏都能展开看它查了什么、哪里没查到、在哪里停下来等人`,
      `看板：24 小时内提交 ${pct(board.onTimeRate.rate)}（${board.onTimeRate.onTime}/${board.onTimeRate.due}）· 可用面评 ${pct(board.usable.rate)}（${board.usable.usable}/${board.usable.due}）`,
      '',
      '下一步：MIANYAN_DB_PATH 指向同一个库启动 dev:server，用王面试官的账号登录，依次看「准备」「面评」两屏，再用 HR 账号看「候选人结果」。',
    ].join('\n'),
  );
}

await main();
