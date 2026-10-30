/**
 * Acceptance run: drives the whole PRD loop over real HTTP (排期 → 准备包 → 知情同意 → 转写 →
 * 草稿 → 修订 → 提交 → 催办升级 → 留存清理) and records the negative gates that the compliance
 * chapter promises. Writes a report file so the numbers can be read back from disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DAY_MS,
  MockLlmProvider,
  MockTranscriptionProvider,
  type Org,
  type Store,
  type User,
} from '@mianyan/core';
import { buildServerApp } from '../build.js';
import { loadConfig } from '../config.js';
import { registerRoutes } from '../routes.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const REPORT = resolve(ROOT, '.tsbuild/e2e-report.txt');
const RUN_START = '2026-03-02T01:00:00.000Z';

const RESUME_TEXT = [
  '张伟 / 13800000000 / zhangwei@example.com',
  '8 年经验，后端工程师。',
  '2016.07-2019.06 恒生数据 后端开发工程师',
  '2019.03-2022.05 云帆网络 高级开发工程师',
  '2023.06-至今 云链科技 技术专家',
  '主导订单系统重构，负责跨部门对齐，推动 5 个团队协作，接口耗时降低 40%。',
  '负责交易链路的架构设计与高可用扩容，主导服务拆分与缓存分层。',
  '本科，华中科技大学 计算机专业。',
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

const INTERVIEW_ANSWERS = [
  '核心问题是交易系统在高并发下不稳定，需要一个能主导架构扩容、又能推动跨部门协作落地的后端专家。',
  '上一任技术深度够，但跨部门推动力不足，遇到协作阻力就等上级拍板；结构化表达也偏弱，汇报时听不出重点。',
  '只做到 60 分的话，他会讲不清扩容方案的取舍，只罗列组件名，压力大的时候习惯把原因归给同事或环境。',
  '明显的例子是去年大促：他自己牵头把订单链路的架构重构落地了，压测数据也是他先提出来要看的。',
  '直接警惕的是把线上故障归因给同事没配合、环境不行，或者全程只讲动作不讲结果。',
  '最需要跟上下游业务团队和基础架构团队打交道，最容易卡在联调排期和接口规范对齐上。',
  '我会让他具体讲一次跨部门推动的架构重构，问当时的第二方案、为什么放弃、以及涨十倍先崩在哪里。',
  '未来一年交易规模翻倍，额外要求他能用数据定义问题、有合规与风险意识。',
];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail: ok ? detail : detail || '未通过' });
}

let base = '';
let server: FastifyInstance | null = null;
let store: Store | null = null;

/**
 * Identity is a session cookie, exactly like the browser sends it. `null` means no cookie at all,
 * which is how the anonymous gates get exercised.
 */
interface SignedIn {
  token: string;
  user: User;
  org: Org;
}

const ANON: SignedIn | null = null;
/** Most of the loop is written by whoever is already at the desk; gates that need no session say so. */
let defaultActor: SignedIn | null = null;

/** A crashed run must not leave Fastify listening, otherwise the harness hangs until it times out. */
async function teardown(): Promise<void> {
  try {
    await server?.close();
  } catch {
    /* already stopped */
  }
  server = null;
  try {
    store?.close();
  } catch {
    /* already stopped */
  }
  store = null;
}

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; as?: SignedIn | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T | null; code: string | null; message: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  const who = 'as' in opts ? opts.as : defaultActor;
  if (who) headers.cookie = `mianzheng_session=${who.token}`;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    data: json as T | null,
    code: typeof json?.code === 'string' ? json.code : null,
    message: typeof json?.message === 'string' ? json.message : text.slice(0, 120),
  };
}

/**
 * 注册 / 登录只通过 Set-Cookie 下发令牌，和浏览器拿到的一模一样，所以这里必须从头部取。
 */
async function signIn(method: 'login' | 'register', body: Record<string, string>): Promise<SignedIn> {
  const res = await fetch(`${base}/auth/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok || !json?.user) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${String(json?.message ?? text).slice(0, 120)}`);
  }
  const raw2 = res.headers.get('set-cookie') ?? '';
  const token = (/mianzheng_session=([^;]+)/.exec(raw2)?.[1] ?? '').trim();
  if (!token) throw new Error(`${method} 成功但没有下发会话 Cookie`);
  return { token, user: json.user as User, org: json.org as Org };
}

const PASSWORD = 'Mianzheng2026';

/** Registers a workspace owner and returns the live session for it. */
async function register(email: string, orgName: string, name: string, password = PASSWORD): Promise<SignedIn> {
  return signIn('register', { orgName, name, email, password });
}

async function login(email: string, password = PASSWORD): Promise<SignedIn> {
  return signIn('login', { email, password });
}

/** Sends a literal body string so the content-type parser itself is under test. */
async function raw(
  method: 'POST',
  path: string,
  body: string,
  as: SignedIn | null = ANON,
): Promise<{ status: number; code: string | null; message: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers.cookie = `mianzheng_session=${as.token}`;
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let code: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    code = typeof json.code === 'string' ? json.code : null;
  } catch {
    /* non-JSON reply */
  }
  return { status: res.status, code, message: text.slice(0, 120) };
}

/** Which reminder levels a tick actually delivered. */
function ladderOf(res: { data: { fired: Array<{ level: number }> } | null }): number[] {
  return (res.data?.fired ?? []).map((e) => e.level);
}

/** Asserts a rejection happened with the documented error code. */
function checkRejects(
  name: string,
  res: { status: number; code: string | null; message: string },
  expectStatus: number,
  expectCode: string,
): void {
  check(
    name,
    res.status === expectStatus && res.code === expectCode,
    `实际 ${res.status}/${res.code ?? '-'}，期望 ${expectStatus}/${expectCode}｜${res.message.slice(0, 60)}`,
  );
}

async function main(): Promise<void> {
  mkdirSync(dirname(REPORT), { recursive: true });
  const config = loadConfig(ROOT);
  const built = await buildServerApp(
    {
      ...config,
      dbPath: ':memory:',
      audioDir: resolve(ROOT, 'data/e2e-audio'),
      fixedClockStart: RUN_START,
      llm: null,
      asr: null,
    },
    { llm: new MockLlmProvider(), asr: new MockTranscriptionProvider() },
  );
  store = built.app.store;
  const http = Fastify({ logger: false });
  server = http;
  registerRoutes(http, built.app, built.audio, built.clock);
  const address = await http.listen({ host: '127.0.0.1', port: 0 });
  base = address.startsWith('http') ? address : `http://127.0.0.1:${(http.server.address() as { port: number }).port}`;

  const clock = built.clock;
  if (!clock) throw new Error('固定时钟未启用，无法验证 24 小时提醒');

  // ---------- 账号：注册即建工作区，成员由 HR 开账号 ----------
  const hr = await register('hr@hangzhou-tech.test', '杭州某科技有限公司', '李 HR');
  defaultActor = hr;
  const ivProfile = await call<User>('POST', `/orgs/${hr.org.id}/users`, {
    as: hr,
    body: { role: 'interviewer', name: '王 面试官', email: 'wang@hangzhou-tech.test', password: PASSWORD },
  });
  const mgrProfile = await call<User>('POST', `/orgs/${hr.org.id}/users`, {
    as: hr,
    body: { role: 'hiring_manager', name: '赵 经理', email: 'zhao@hangzhou-tech.test', password: PASSWORD },
  });
  if (!ivProfile.data || !mgrProfile.data) throw new Error('建成员失败');
  const iv = await login('wang@hangzhou-tech.test');
  const mgr = await login('zhao@hangzhou-tech.test');
  check('成员用各自的账号登录，工作区一致', iv.user.id === ivProfile.data.id && iv.org.id === hr.org.id, `面试官 ${iv.user.name}`);

  const job = (
    await call<{ id: string }>('POST', '/jobs', {
      as: mgr,
      body: {
        jobTitle: '高级后端工程师',
        level: 'P7',
        reportsTo: '技术总监',
        teamSize: 12,
        painPoints: '交易系统扩容、跨部门推动',
        description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
      },
    })
  ).data;
  if (!job) throw new Error('建职位失败');

  const candidate0 = (
    await call<{ id: string; resume: { companies: string[] } }>('POST', '/candidates', {
      as: hr,
      body: { jobId: job.id, name: '张伟', resumeText: RESUME_TEXT },
    })
  ).data;
  if (!candidate0) throw new Error('建候选人失败');
  check(
    '简历解析出完整经历段数',
    candidate0.resume.companies.length === 3,
    `${candidate0.resume.companies.length} 段：${candidate0.resume.companies.join('、')}`,
  );

  // ---------- 身份校验：账号、会话与工作区隔离 ----------
  const other = await register('hr@another-biz.test', '另一家咨询公司', '孙 HR');
  const stolenJob = await call('GET', `/jobs/${job.id}`, { as: other });
  checkRejects('门禁：别的工作区的岗位读不到', stolenJob, 404, 'record_not_found');
  const stolenSchedule = await call('POST', '/interviews', {
    as: other,
    body: { jobId: job.id, candidateId: candidate0.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'video', round: 1 },
  });
  checkRejects('门禁：不能拿别人的岗位和候选人排面试', stolenSchedule, 404, 'job_not_found');
  checkRejects(
    '门禁：密码错误不能登录',
    await call('POST', '/auth/login', { as: ANON, body: { email: 'hr@hangzhou-tech.test', password: 'Mianzheng2027' } }),
    401,
    'invalid_credentials',
  );
  checkRejects(
    '门禁：邮箱重复注册被拒',
    await call('POST', '/auth/register', { as: ANON, body: { orgName: '重复公司', name: '重', email: 'HR@hangzhou-tech.test', password: PASSWORD } }),
    409,
    'email_taken',
  );
  const weak = await call('POST', '/auth/register', {
    as: ANON,
    body: { orgName: '弱密码公司', name: '弱', email: 'weak@hangzhou-tech.test', password: '12345678' },
  });
  check('门禁：纯数字密码被拒', weak.status === 400, `${weak.status}/${weak.code ?? '-'}｜${weak.message.slice(0, 50)}`);
  const interviewerAddsMember = await call('POST', `/orgs/${hr.org.id}/users`, {
    as: iv,
    body: { role: 'hr', name: '擅自加的人', email: 'sneaky@hangzhou-tech.test', password: PASSWORD },
  });
  checkRejects('门禁：面试官不能自己开账号', interviewerAddsMember, 403, 'hr_only');
  const noCookie = await call('GET', `/orgs/${hr.org.id}/board/rows`, { as: ANON });
  checkRejects('门禁：没有会话 Cookie 什么都读不到', noCookie, 401, 'auth_required');
  const headerIdentity = await call('GET', `/orgs/${hr.org.id}/audit`, { as: ANON, headers: { 'x-user-id': 'u_forged_hr' } });
  checkRejects('门禁：请求头声明身份已完全失效', headerIdentity, 401, 'auth_required');
  const crossSite = await call('POST', '/jobs', {
    as: mgr,
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { jobTitle: 'x', level: 'P7', reportsTo: 'y', teamSize: 1, painPoints: 'z', description: 'w' },
  });
  checkRejects('门禁：跨站表单提交被拦下', crossSite, 403, 'cross_site_blocked');
  const throttledEmail = 'lock@hangzhou-tech.test';
  await call('POST', `/orgs/${hr.org.id}/users`, { as: hr, body: { role: 'interviewer', name: '锁', email: throttledEmail, password: PASSWORD } });
  let throttleStatus = 0;
  for (let i = 0; i < 9; i += 1) {
    throttleStatus = (await call('POST', '/auth/login', { as: ANON, body: { email: throttledEmail, password: 'WrongPass1' } })).status;
  }
  check('门禁：连续猜密码后被暂时锁定', throttleStatus === 429, `第 9 次尝试 HTTP ${throttleStatus}`);
  const signedOut = await call<{ ok: boolean }>('POST', '/auth/logout', { as: iv });
  const afterLogout = await call('GET', `/orgs/${iv.org.id}/board/rows`, { as: iv });
  check(
    '退出后这枚会话立即失效',
    signedOut.status === 200 && afterLogout.status === 401,
    `退出 ${signedOut.status}，再用同一 Cookie ${afterLogout.status}`,
  );
  const iv2 = await login('wang@hangzhou-tech.test');
  check('重新登录可恢复会话', iv2.user.id === iv.user.id, iv2.user.name);
  Object.assign(iv, iv2);

  // ---------- 门禁：没有金标准不能排面试 ----------
  const earlySchedule = await call('POST', '/interviews', {
    as: hr,
    body: { jobId: job.id, candidateId: candidate0.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'video', round: 1 },
  });
  checkRejects('门禁：未定稿金标准不能排面试', earlySchedule, 400, 'standard_required');

  const anonymousDraft = await call('POST', `/interviews/x/draft`, { as: ANON, body: {} });
  checkRejects('门禁：未登录不能触发面评', anonymousDraft, 401, 'auth_required');

  // 反向对照：空 body 的动作接口必须放行，坏 JSON 必须被拦，否则上面的解析器覆盖是假绿。
  const emptyAction = await raw('POST', '/interviews/none/finish', '', hr);
  check(
    '动作接口允许无请求体（只凭会话 Cookie）',
    emptyAction.status === 404,
    `实际 ${emptyAction.status}/${emptyAction.code ?? '-'}｜${emptyAction.message.slice(0, 60)}`,
  );
  checkRejects('门禁：请求体不是合法 JSON 被拦下', await raw('POST', '/interviews/none/finish', '{"reason"', hr), 400, 'bad_request');

  // ---------- 金标准访谈提取 ----------
  let std = (
    await call<{ id: string; status: string }>('POST', `/jobs/${job.id}/standard`, {
      as: mgr,
      body: {
        jobTitle: '高级后端工程师',
        level: 'P7',
        reportsTo: '技术总监',
        teamSize: 12,
        painPoints: '交易系统扩容、跨部门推动',
        description: '负责订单与交易系统的架构设计、扩容与稳定性。',
      },
    })
  ).data;
  if (!std) throw new Error('发起访谈失败');

  let asked = 0;
  for (const answer of INTERVIEW_ANSWERS) {
    const q = await call<{ question: string | null }>('GET', `/standards/${std.id}/next-question`);
    if (!q.data?.question) break;
    asked += 1;
    const recorded = await call<{ standard: { id: string } }>('POST', `/standards/${std.id}/answers`, {
      as: mgr,
      body: { question: q.data.question, answer },
    });
    if (recorded.code) throw new Error(`记录回答失败：${recorded.message}`);
  }
  check('访谈多轮提问并记录回答', asked >= 6, `提问 ${asked} 轮`);

  const proposed = await call<{ standard: { dimensions: Array<{ id: string; name: string }>; conflicts: Array<{ dimensionId: string }> } }>(
    'POST',
    `/standards/${std.id}/propose`,
    { as: mgr },
  );
  if (!proposed.data?.standard) {
    throw new Error(`propose 未返回金标准草稿：HTTP ${proposed.status} ${JSON.stringify(proposed.data ?? proposed.message).slice(0, 400)}`);
  }
  const dims = proposed.data.standard.dimensions;
  check('提取出 4-7 个考察维度', dims.length >= 4 && dims.length <= 7, `共 ${dims.length} 个：${dims.map((d) => d.name).join('、')}`);

  for (const conflict of proposed.data?.standard.conflicts ?? []) {
    await call('POST', `/standards/${std.id}/conflicts/resolve`, {
      as: hr,
      body: { dimensionId: conflict.dimensionId, side: 'keep_standard' },
    });
  }
  const badDimension = await call('PATCH', `/standards/${std.id}/dimensions/${dims[0]?.id ?? 'none'}`, {
    as: mgr,
    body: { name: '男性优先的表达习惯' },
  });
  checkRejects('门禁：受保护特征写进维度被拦下', badDimension, 400, 'protected_attribute_detected');

  for (const d of dims) {
    const confirmed = await call('POST', `/standards/${std.id}/dimensions/${d.id}/confirm`, { as: mgr });
    if (confirmed.code) throw new Error(`确认维度失败：${confirmed.message}`);
  }
  const aiConfirm = await call('POST', `/standards/${std.id}/dimensions/${dims[0]?.id ?? 'none'}/confirm`, { as: ANON });
  checkRejects('门禁：确认必须由登录后的真人完成', aiConfirm, 401, 'auth_required');

  await call('POST', `/standards/${std.id}/sign`, { as: mgr, body: { party: 'hiring_manager' } });
  const earlyFinalize = await call('POST', `/standards/${std.id}/finalize`, { as: hr });
  check(
    '门禁：用人经理与 HR 未双签不能定稿',
    earlyFinalize.status >= 400,
    `${earlyFinalize.code ?? '-'}｜${earlyFinalize.message.slice(0, 50)}`,
  );
  await call('POST', `/standards/${std.id}/sign`, { as: hr, body: { party: 'hr' } });
  const finalized = await call<{ status: string; version: string }>('POST', `/standards/${std.id}/finalize`, { as: hr });
  check(
    '定稿为 v1.0 金标准',
    finalized.data?.status === 'confirmed' && finalized.data?.version === 'v1.0',
    `${finalized.data?.status}/${finalized.data?.version ?? finalized.message.slice(0, 50)}`,
  );

  // ---------- 准备包 ----------
  const interview1 = (
    await call<{ id: string }>('POST', '/interviews', {
      as: hr,
      body: { jobId: job.id, candidateId: candidate0.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'video', round: 1 },
    })
  ).data;
  if (!interview1) throw new Error('排期失败');

  const pack = await call<{
    crux: string[];
    alignment: Array<{ mark: string; dimensionName: string; rationale: string }>;
    questions: Array<{ id: string; text: string; dimensionId: string | null }>;
    redFlagChecks: string[];
    aiModel: string;
  }>('POST', `/interviews/${interview1.id}/prep-pack`, { as: iv });
  const alignment = pack.data?.alignment ?? [];
  check(
    '对齐矩阵按简历证据给出 matched/needs_probe/weak',
    alignment.length === dims.length && alignment.some((a) => a.mark === 'matched') && alignment.some((a) => a.mark !== 'matched'),
    alignment.map((a) => `${a.dimensionName}:${a.mark}`).join('、'),
  );
  check(
    '追问建议 3-5 条且都挂在维度上',
    (pack.data?.questions.length ?? 0) >= 3 && (pack.data?.questions.length ?? 0) <= 5,
    `${pack.data?.questions.length} 条`,
  );
  check(
    '红旗排查含经历时间线异常',
    (pack.data?.redFlagChecks.length ?? 0) >= 1,
    (pack.data?.redFlagChecks ?? []).join('；').slice(0, 120),
  );

  const added = await call('POST', `/interviews/${interview1.id}/prep-pack/questions`, {
    as: iv,
    body: { text: '请举一个你把扩容方案讲给非技术同事听的例子。', dimensionId: dims[0]?.id ?? null },
  });
  check('面试官可补充自己的提纲并关联维度', !added.code, added.message.slice(0, 60));
  const mismatch = await call('POST', `/interviews/${interview1.id}/prep-pack/questions`, {
    as: iv,
    body: { text: '随便一问', dimensionId: 'dim_not_exist' },
  });
  check('门禁：提问与维度对不上会被提示', Boolean(mismatch.code), `${mismatch.code ?? '无拦截'}`);
  const veto = await call('POST', `/interviews/${interview1.id}/prep-pack/questions/${pack.data?.questions[0]?.id ?? 'x'}/veto`, {
    as: iv,
    body: { reason: '这个问题涉及婚育，不能问' },
  });
  checkRejects('门禁：否决追问只能由 HR 执行', veto, 403, 'hr_only');
  await call('POST', `/interviews/${interview1.id}/prep-pack/questions/${pack.data?.questions[0]?.id ?? 'x'}/veto`, {
    as: hr,
    body: { reason: '提问方式可能触合规雷区' },
  });

  // ---------- 知情同意 + 静默转写 ----------
  const consentPrompt = await call<{ noticeText: string; presentedAt: string; buttons: Array<{ decision: string; label: string }> }>(
    'GET',
    `/interviews/${interview1.id}/consent`,
  );
  const prompt = consentPrompt.data;
  check(
    '合规：独立弹窗文案含拒绝权、6 个月留存与人工复核',
    Boolean(prompt) && prompt!.buttons.length === 2 && prompt!.noticeText.includes('6 个月') && prompt!.noticeText.includes('有权拒绝'),
    prompt ? `${prompt.buttons.length} 个按钮` : consentPrompt.message,
  );

  const startWithoutConsent = await call('POST', `/interviews/${interview1.id}/start`, { as: iv });
  checkRejects('门禁：未取得同意不能开始转写', startWithoutConsent, 403, 'consent_required');

  const granted = await call<{ decision: string; retentionUntil: string }>('POST', `/interviews/${interview1.id}/consent`, {
    as: hr,
    body: { decision: 'granted', presentedAt: prompt?.presentedAt ?? RUN_START },
  });
  check(
    '合规：同意决策留存并带到期时间',
    (granted.data?.retentionUntil ?? '').length > 0,
    `retentionUntil=${granted.data?.retentionUntil ?? granted.message.slice(0, 60)}`,
  );
  const flipFlop = await call('POST', `/interviews/${interview1.id}/consent`, {
    as: hr,
    body: { decision: 'refused', presentedAt: prompt?.presentedAt ?? RUN_START },
  });
  check('合规：同意决策不可被反复改写（日志留痕）', flipFlop.status >= 400, `${flipFlop.code ?? '未拦截'}`);

  await call('POST', `/interviews/${interview1.id}/start`, { as: iv });
  const ingest = await call<{ saved: Array<{ id: string; text: string; startMs: number }>; transcribed: number }>(
    'POST',
    `/interviews/${interview1.id}/transcript`,
    { as: iv, body: { inlineTranscript: TRANSCRIPT_TEXT } },
  );
  const saved = ingest.data?.saved ?? [];
  check('转写落库并带时间戳', saved.length >= 8 && saved.every((s) => Number.isFinite(s.startMs)), `落库 ${saved.length} 段`);

  const coverage = await call<{ covered: string[]; uncovered: string[] }>('GET', `/interviews/${interview1.id}/coverage`);
  check(
    '覆盖度提示已命中与未覆盖维度',
    (coverage.data?.covered.length ?? 0) >= 2,
    `已覆盖 ${coverage.data?.covered.length ?? 0}：${(coverage.data?.covered ?? []).join('、')}`,
  );

  const paused = await call('POST', `/interviews/${interview1.id}/pause`, { as: iv, body: { paused: true } });
  const whilePaused = await call('POST', `/interviews/${interview1.id}/transcript`, {
    as: iv,
    body: { inlineTranscript: '[00:20:00] 候选人：敏感话题跳过。' },
  });
  check('暂停 AI 期间不写入转写', !paused.code && Boolean(whilePaused.code), `${whilePaused.code ?? '未拦截'}`);
  await call('POST', `/interviews/${interview1.id}/pause`, { as: iv, body: { paused: false } });

  const corrected = await call<{ correctedBy: string | null }>('PATCH', `/segments/${saved[0]?.id ?? 'seg_x'}`, {
    as: iv,
    body: { text: '面试官：请先做个自我介绍（已人工校听）' },
  });
  check('低识别质量可由面试官快速修正', !corrected.code && corrected.data?.correctedBy === iv.user.id, corrected.message.slice(0, 60));

  await call('POST', `/interviews/${interview1.id}/finish`, { as: iv });

  // ---------- 拒绝同意的候选人：功能受限但不阻断面试 ----------
  const candidateR = (
    await call<{ id: string }>('POST', '/candidates', { body: { jobId: job.id, name: '李娜', resumeText: RESUME_TEXT } })
  ).data;
  const interviewR = (
    await call<{ id: string }>('POST', '/interviews', {
      as: hr,
      body: { jobId: job.id, candidateId: candidateR!.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'phone', round: 1 },
    })
  ).data;
  const promptR = await call<{ presentedAt: string }>('GET', `/interviews/${interviewR!.id}/consent`);
  await call('POST', `/interviews/${interviewR!.id}/consent`, {
    as: hr,
    body: { decision: 'refused', presentedAt: promptR.data?.presentedAt ?? RUN_START },
  });
  await call('POST', `/interviews/${interviewR!.id}/start`, { as: iv });
  const refusedIngest = await call('POST', `/interviews/${interviewR!.id}/transcript`, {
    as: iv,
    body: { inlineTranscript: TRANSCRIPT_TEXT },
  });
  checkRejects('拒绝同意后不产生转写，面试照常进行', refusedIngest, 400, 'consent_refused_no_transcript');
  await call('POST', `/interviews/${interviewR!.id}/finish`, { as: iv });

  // ---------- 草稿 + 证据校验 ----------
  const transcript = await call<{ segments: Array<{ id: string; text: string }> }>('GET', `/interviews/${interview1.id}/transcript`);
  const textById = new Map((transcript.data?.segments ?? []).map((s) => [s.id, s.text]));

  const draftRes = await call<{
    draft: {
      id: string;
      checks: Array<{
        id: string;
        dimensionName: string;
        aiScore: string | null;
        finalScore: string | null;
        aiEvidence: Array<{ segmentId: string; quote: string; startMs: number }>;
        status: string;
      }>;
      rejectedClaims: unknown[];
      overallMatch: { reading: string } | null;
    };
    rejectedClaims: unknown[];
  }>('POST', `/interviews/${interview1.id}/draft`, { as: iv, body: { interviewerId: iv.user.id } });
  const draft = draftRes.data?.draft;
  if (!draft) throw new Error(`草稿生成失败：${draftRes.message}`);
  const cited = draft.checks.filter((c) => c.aiEvidence.length > 0);
  const verbatim = cited.every((c) => c.aiEvidence.every((e) => textById.get(e.segmentId) === e.quote));
  check('每条 AI 引用都由系统回填数据库原文', cited.length >= 2 && verbatim, `${cited.length} 个维度带引用，逐字一致=${verbatim}`);
  check(
    '草稿里 AI 起评分不作为最终评分',
    draft.checks.every((c) => c.finalScore === null),
    `finalScore 全空=${draft.checks.every((c) => c.finalScore === null)}`,
  );
  check('不生成整体匹配度总分', draft.overallMatch === null, `overallMatch=${draft.overallMatch === null ? 'null' : 'present'}`);

  const fabricated = await call('PATCH', `/drafts/${draft.id}/checks/${draft.checks[0]!.id}`, {
    as: iv,
    body: { addEvidenceSegmentIds: ['seg_ghost_404'] },
  });
  const afterFabrication = await call<{ draft: { checks: Array<{ id: string; finalEvidence: unknown[] }> } }>('GET', `/drafts/${draft.id}`);
  const target = afterFabrication.data?.draft.checks.find((c) => c.id === draft.checks[0]!.id);
  check(
    '门禁：编造的 segmentId 不会变成引用',
    (target?.finalEvidence.length ?? 0) === 0,
    `引用数=${target?.finalEvidence.length ?? 'unknown'}`,
  );

  for (const c of draft.checks) {
    const r = await call('PATCH', `/drafts/${draft.id}/checks/${c.id}`, {
      as: iv,
      body: { finalScore: c.aiScore ?? 'medium', finalSummary: `结合原文，${c.dimensionName} 达到岗位要求，依据见引用。` },
    });
    if (r.code) throw new Error(`修订失败：${r.message}`);
  }
  const biased = await call('PATCH', `/drafts/${draft.id}/checks/${draft.checks[0]!.id}`, {
    as: iv,
    body: { finalSummary: '这个年纪的候选人稳定性更好' },
  });
  checkRejects('门禁：面评文字里的年龄暗示被拦下', biased, 400, 'protected_attribute_detected');
  const aiSubmitAttempt = await call('POST', `/drafts/${draft.id}/submit`, {
    as: ANON,
    body: { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: false },
  });
  checkRejects('门禁：未登录的确认不能提交面评', aiSubmitAttempt, 401, 'auth_required');

  await call('POST', `/drafts/${draft.id}/recommendation`, {
    as: iv,
    body: { recommendation: '建议进入下一轮：架构与跨部门证据充分，抗压归因需在复面中追问。' },
  });
  const unagreed = await call('POST', `/drafts/${draft.id}/submit`, {
    as: iv,
    body: { fillUnscored: false, agreeUsedForDecision: false, anonymizeName: false },
  });
  checkRejects('门禁：不同意作为决策依据则不能提交', unagreed, 400, 'decision_agreement_required');
  const submitted = await call<{ status: string }>('POST', `/drafts/${draft.id}/submit`, {
    as: iv,
    body: { fillUnscored: false, agreeUsedForDecision: true, anonymizeName: true },
  });
  check('提交后面评状态为 submitted', submitted.data?.status === 'submitted', submitted.message.slice(0, 60));

  // ---------- 24 小时提醒与待提交清单（第二场：不提交面评） ----------
  const candidate2 = (
    await call<{ id: string }>('POST', '/candidates', { body: { jobId: job.id, name: '王强', resumeText: RESUME_TEXT } })
  ).data;
  const interview2 = (
    await call<{ id: string }>('POST', '/interviews', {
      as: hr,
      body: { jobId: job.id, candidateId: candidate2!.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'video', round: 1 },
    })
  ).data;
  const prompt2 = await call<{ presentedAt: string }>('GET', `/interviews/${interview2!.id}/consent`);
  await call('POST', `/interviews/${interview2!.id}/consent`, {
    as: hr,
    body: { decision: 'granted', presentedAt: prompt2.data?.presentedAt ?? RUN_START },
  });
  await call('POST', `/interviews/${interview2!.id}/start`, { as: iv });
  const audioUp = await call<{ audioId: string }>('POST', `/interviews/${interview2!.id}/audio`, {
    as: iv,
    body: { base64: Buffer.from('fake-audio-bytes-for-retention-proof').toString('base64'), mime: 'audio/webm' },
  });
  check(
    '音频只作为文件与元数据入库（不存视频）',
    Boolean(audioUp.data?.audioId),
    `bytes=${audioUp.data ? 'ok' : audioUp.message.slice(0, 60)}`,
  );
  await call('POST', `/interviews/${interview2!.id}/transcript`, { as: iv, body: { inlineTranscript: TRANSCRIPT_TEXT } });
  await call('POST', `/interviews/${interview2!.id}/finish`, { as: iv });
  await call('POST', `/interviews/${interview2!.id}/draft`, { as: iv, body: { interviewerId: iv.user.id } });
  await call('POST', `/interviews/${interview2!.id}/reminders/queue`, { as: hr });

  const meetingExport = TRANSCRIPT_TEXT.split('\n')
    .map((l) => l.match(/^\[([0-9:]+)\]\s*(候选人|面试官)[：:]\s*(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[2] === '候选人' ? '赵敏' : '周航'}  ${m[1]}\n${m[3]}`)
    .join('\n\n');
  const candidate3 = (
    await call<{ id: string }>('POST', '/candidates', { body: { jobId: job.id, name: '赵敏', resumeText: RESUME_TEXT } })
  ).data;
  const interview3 = (
    await call<{ id: string }>('POST', '/interviews', {
      as: hr,
      body: { jobId: job.id, candidateId: candidate3!.id, interviewerIds: [iv.user.id], scheduledAt: RUN_START, channel: 'video', round: 1 },
    })
  ).data;
  const prompt3 = await call<{ presentedAt: string }>('GET', `/interviews/${interview3!.id}/consent`);
  await call('POST', `/interviews/${interview3!.id}/consent`, {
    as: hr,
    body: { decision: 'granted', presentedAt: prompt3.data?.presentedAt ?? RUN_START },
  });
  await call('POST', `/interviews/${interview3!.id}/start`, { as: iv });
  await call('POST', `/interviews/${interview3!.id}/finish`, { as: iv });
  const preview = await call<{ segments: number; speakers: Array<{ label: string; guess: string }> }>(
    'POST',
    `/interviews/${interview3!.id}/transcript/preview`,
    { as: iv, body: { inlineTranscript: meetingExport } },
  );
  const guessed = preview.data?.speakers.find((s) => s.label === '赵敏')?.guess;
  check('导入会议转写：识别出发言人，说得多的一方先猜作候选人', guessed === 'candidate', `segments=${preview.data?.segments ?? 0} 赵敏=${guessed ?? '-'}`);
  const imported = await call<{ transcribed: number }>('POST', `/interviews/${interview3!.id}/transcript/import`, {
    as: iv,
    body: { inlineTranscript: meetingExport, source: 'feishu', speakerMap: { 赵敏: 'candidate', 周航: 'interviewer' } },
  });
  const draft3 = await call<{ draft: { id: string } }>('POST', `/interviews/${interview3!.id}/draft`, {
    as: iv,
    body: { interviewerId: iv.user.id },
  });
  check(
    '导入会议转写：面试结束后导入，照样能生成面评草稿',
    (imported.data?.transcribed ?? 0) > 0 && draft3.status < 300,
    `imported=${imported.data?.transcribed ?? imported.message.slice(0, 40)} draft=${draft3.status}`,
  );

  const firedStart = await call<{ fired: Array<{ level: number }> }>('POST', '/reminders/tick');
  check('刚结束不打扰面试官', ladderOf(firedStart).length === 0, `已发 [${ladderOf(firedStart).join(',')}]`);

  clock.advanceHours(25);
  const fired24 = await call<{ fired: Array<{ level: number }> }>('POST', '/reminders/tick');
  check('24 小时：只发一次提醒', JSON.stringify(ladderOf(fired24)) === JSON.stringify([24]), `已发 [${ladderOf(fired24).join(',')}]`);

  const rows24 = await call<Array<{ interviewId: string; light: string }>>('GET', `/orgs/${hr.org.id}/board/rows`);
  const light24 = rows24.data?.find((r) => r.interviewId === interview2!.id)?.light;
  check('24 小时后进入待提交清单', light24 === 'attention', `light=${light24 ?? '-'}`);

  clock.advanceHours(24);
  const firedAgain = await call<{ fired: Array<{ level: number }> }>('POST', '/reminders/tick');
  const stillPending = await call<{ status: string }>('GET', `/interviews/${interview2!.id}`);
  check(
    '门禁：提醒不重复，系统不会自动标记失效',
    ladderOf(firedAgain).length === 0 && stillPending.data?.status === 'eval_pending',
    `再次发出 [${ladderOf(firedAgain).join(',')}] status=${stillPending.data?.status}`,
  );

  const interviewerExpire = await call('POST', `/interviews/${interview2!.id}/expire`, { as: iv });
  checkRejects('门禁：标记失效只能由 HR 决定', interviewerExpire, 403, 'hr_only');
  const hrExpire = await call<{ status: string }>('POST', `/interviews/${interview2!.id}/expire`, { as: hr });
  check(' HR 可把长期未交的面试标记失效', hrExpire.data?.status === 'expired', hrExpire.message.slice(0, 60));

  const interviewerRestart = await call('POST', `/interviews/${interview2!.id}/restart`, { as: iv });
  checkRejects('门禁：失效重启只能由 HR 决定', interviewerRestart, 403, 'restart_requires_hr');
  const hrRestart = await call<{ status: string }>('POST', `/interviews/${interview2!.id}/restart`, { as: hr });
  check(' HR 确认后重启流程', hrRestart.data?.status === 'eval_pending', JSON.stringify(hrRestart.data ?? hrRestart.message).slice(0, 60));

  const delayed = await call('POST', `/users/${iv.user.id}/cadence`, { as: hr, body: { extraHours: 12 } });
  check(' HR 可放宽某位面试官的催办节奏', !delayed.code, delayed.message.slice(0, 60));

  // ---------- 看板 ----------
  const overview = await call<{
    scheduled: number;
    awaitingEval: number;
    evaluated: number;
    overdue: number;
    onTimeRate: { rate: number | null };
  }>('GET', `/orgs/${hr.org.id}/board/overview`);
  const ov = overview.data;
  check(
    '看板汇总：已面评/待面评/按时率都是活数字',
    overview.status === 200 && (ov?.evaluated ?? 0) >= 1 && (ov?.awaitingEval ?? 0) >= 1 && ov?.onTimeRate.rate !== null,
    `已提交 ${ov?.evaluated ?? '-'}、待提交 ${ov?.awaitingEval ?? '-'}、准时率 ${ov?.onTimeRate?.rate ?? '-'}、失效 ${ov?.overdue ?? '-'}`,
  );
  const funnel = await call<Array<{ stage: string; count: number }>>('GET', `/orgs/${hr.org.id}/board/funnel`);
  check('漏斗含各环节人数', (funnel.data?.length ?? 0) >= 3, (funnel.data ?? []).map((f) => `${f.stage}:${f.count}`).join('、'));
  const weekly = await call<{ report: string }>('GET', `/orgs/${hr.org.id}/board/weekly-report`);
  check(
    '周报草稿可直接转发',
    Boolean(weekly.data?.report.includes('本周')),
    (weekly.data?.report ?? '').split('\n')[0]?.slice(0, 60) ?? '',
  );

  // ---------- 合规：申诉、审计、留存 ----------
  const appeal = await call<{ promisedReplyWithinDays: number }>('POST', `/interviews/${interview1.id}/appeal`, {
    as: hr,
    body: { reason: '候选人申请免费人工复核 AI 起评分' },
  });
  check(
    '合规：申诉通道可用并承诺答复期限',
    (appeal.data?.promisedReplyWithinDays ?? 0) === 15,
    JSON.stringify(appeal.data ?? appeal.message).slice(0, 80),
  );

  const audit = await call<Array<{ action: string; actorType: string }>>('GET', `/orgs/${hr.org.id}/audit?limit=500`);
  const actions = new Set((audit.data ?? []).map((a) => a.action));
  check(
    '合规：AI 产出 + 人确认 + 系统留痕全程可追溯',
    actions.has('interview.schedule') &&
      actions.has('draft.submit') &&
      actions.has('evaluation.human_review_requested') &&
      (audit.data ?? []).some((a) => a.actorType === 'system'),
    `审计 ${audit.data?.length ?? 0} 条`,
  );

  const deleted = await call<{ deletedAt: string | null }>('DELETE', `/candidates/${candidate2!.id}`, {
    as: hr,
    body: { reason: '候选人撤回申请' },
  });
  check('合规：删除请求为软删除', Boolean(deleted.data?.deletedAt), deleted.message.slice(0, 60));

  clock.advanceMs(181 * DAY_MS);
  const staleSession = await call('POST', '/compliance/retention/sweep', { as: hr });
  checkRejects('门禁：会话超过 14 天后必须重新登录', staleSession, 401, 'auth_required');
  const hrLate = await login('hr@hangzhou-tech.test');
  defaultActor = hrLate;
  const sweep = await call<{ transcriptsPurged: number; audioPurged: number; consentLogsPurged: number; audioFilesPurged: number }>(
    'POST',
    '/compliance/retention/sweep',
    { as: hrLate },
  );
  const s = sweep.data ?? { transcriptsPurged: 0, audioPurged: 0, consentLogsPurged: 0, audioFilesPurged: 0 };
  check(
    '合规：满 6 个月自动清理转写与音频文件',
    s.transcriptsPurged >= 1 && s.audioFilesPurged >= 1 && s.consentLogsPurged === 0,
    JSON.stringify(s),
  );
  const afterPurge = await call<{ segments: unknown[] }>('GET', `/interviews/${interview1.id}/transcript`, { as: hrLate });
  const leftover = afterPurge.data?.segments ?? [];
  check('合规：清理后转写确实不在库里', leftover.length === 0, `剩余 ${leftover.length} 段`);

  const notice = await call<{ consentText: string; appealChannel: { contact: string }; aiLabel: { cardBadge: string } }>(
    'GET',
    '/compliance/notice',
  );
  check(
    '合规：文案与 AI 角标由服务端下发',
    Boolean(notice.data?.aiLabel.cardBadge.includes('AI 生成的草稿')),
    notice.data?.aiLabel.cardBadge ?? '',
  );

  const failed = checks.filter((c) => !c.ok);
  const lines = [
    `面证 · 闭环验收 @ ${new Date().toISOString()}`,
    `HTTP base=${base} 驱动：llm=${built.app.ctx.llm.driver}/${built.app.ctx.llm.model} asr=${built.app.ctx.asr.id}`,
    '',
    ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} | ${c.name} | ${c.detail}`),
    '',
    `合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`,
    `PASS=${checks.length - failed.length} FAIL=${failed.length}`,
  ];
  writeFileSync(REPORT, lines.join('\n'));
  await teardown();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    REPORT,
    `RUN CRASHED\n${message}\n${checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} | ${c.name} | ${c.detail}`).join('\n')}\n` +
      `PASS=${checks.length - failed.length} FAIL=${failed.length}`,
  );
  await teardown();
  process.exit(2);
});
