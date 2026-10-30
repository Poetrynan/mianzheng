/**
 * Real-service acceptance run. Unlike closedLoop.ts (deterministic fixtures), this script
 * calls the configured LongCat endpoint and the on-device SenseVoice model end to end.
 *
 * Run: npm run verify:real
 * It writes .tsbuild/real-smoke-report.txt and never prints credentials.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Org, User } from '@mianyan/core';
import { buildServerApp } from '../build.js';
import { loadConfig } from '../config.js';
import { registerRoutes } from '../routes.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const REPORT = resolve(ROOT, '.tsbuild/real-smoke-report.txt');
const WAV = resolve(ROOT, '.tsbuild/asr-test.wav');
const PASSWORD = 'Mianzheng2026';

const RESUME_TEXT = [
  '张伟 / 13800000000 / zhangwei@example.com',
  '8 年经验，后端工程师。',
  '2016.07-2019.06 恒生数据 后端开发工程师',
  '2019.03-2022.05 云帆网络 高级开发工程师',
  '2023.06-至今 云链科技 技术专家',
  '主导订单系统重构，负责跨部门对齐，推动 5 个团队协作，接口耗时降低 40%。',
  '负责交易链路的架构设计与高可用扩容，主导服务拆分与缓存分层。',
].join('\n');

const ANSWERS = [
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
  checks.push({ name, ok, detail });
}

let base = '';
let server: FastifyInstance | null = null;

async function teardown(): Promise<void> {
  try {
    await server?.close();
  } catch {
    /* already stopped */
  }
  server = null;
}

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; as?: Session | null } = {},
): Promise<{ status: number; data: T | null; code: string | null; message: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.as) headers.cookie = `mianzheng_session=${opts.as.token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
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
    message: typeof json?.message === 'string' ? json.message : text.slice(0, 200),
  };
}

interface Session {
  token: string;
  user: User;
  org: Org;
}

/** 登录只发 Cookie，所以这里必须自己把 set-cookie 里的令牌取出来。 */
async function signIn(via: 'login' | 'register', body: Record<string, string>): Promise<Session> {
  const res = await fetch(`${base}/auth/${via}`, {
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
  if (!res.ok || !json?.user) throw new Error(`${via} 失败：HTTP ${res.status} ${String(json?.message ?? text).slice(0, 160)}`);
  const token = (/mianzheng_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '').trim();
  if (!token) throw new Error(`${via} 成功但没有下发会话 Cookie`);
  return { token, user: json.user as User, org: json.org as Org };
}

function must<T>(label: string, res: { status: number; data: T | null; code: string | null; message: string }): T {
  if (!res.data || res.status >= 400) {
    throw new Error(`${label} 失败：HTTP ${res.status} ${res.code ?? ''} ${res.message}`);
  }
  return res.data;
}

async function main(): Promise<void> {
  mkdirSync(dirname(REPORT), { recursive: true });
  const config = loadConfig(ROOT);
  if (config.configErrors.length > 0) throw new Error(config.configErrors.join('\n'));
  check('语言模型使用真实服务', config.llm !== null, config.llm?.model ?? '未配置');
  check('语音识别使用本机模型', config.asr?.provider === 'local-sherpa', config.asr?.provider ?? '未配置');

  const built = await buildServerApp({
    ...config,
    dbPath: ':memory:',
    audioDir: resolve(ROOT, 'data/real-smoke-audio'),
    fixedClockStart: null,
  });
  check('运行时未注入任何假驱动', built.providers.llm.driver !== 'mock' && built.providers.asr.id !== 'mock', `${built.providers.llm.driver} / ${built.providers.asr.id}`);

  const http = Fastify({ logger: false });
  server = http;
  registerRoutes(http, built.app, built.audio, built.clock);
  const address = await http.listen({ host: '127.0.0.1', port: 0 });
  base = address.startsWith('http') ? address : `http://127.0.0.1:${(http.server.address() as { port: number }).port}`;

  const health = must('健康检查', await call<{ llmDriver: string; asrProvider: string }>('GET', '/health'));
  check('健康检查返回真实驱动', health.llmDriver !== 'mock' && health.asrProvider !== 'mock', `${health.llmDriver} / ${health.asrProvider}`);

  const hr = await signIn('register', { orgName: '杭州某科技有限公司', name: '李 HR', email: 'hr@hangzhou-tech.test', password: PASSWORD });
  must('HR 创建面试官账号', await call('POST', `/orgs/${hr.org.id}/users`, { as: hr, body: { role: 'interviewer', name: '王 面试官', email: 'wang@hangzhou-tech.test', password: PASSWORD } }));
  must('HR 创建用人经理账号', await call('POST', `/orgs/${hr.org.id}/users`, { as: hr, body: { role: 'hiring_manager', name: '赵 经理', email: 'zhao@hangzhou-tech.test', password: PASSWORD } }));
  const iv = await signIn('login', { email: 'wang@hangzhou-tech.test', password: PASSWORD });
  const mgr = await signIn('login', { email: 'zhao@hangzhou-tech.test', password: PASSWORD });
  const anonBoard = await call('GET', `/orgs/${hr.org.id}/board/rows`);
  check('未登录读不到任何数据', anonBoard.status === 401 && anonBoard.code === 'auth_required', `${anonBoard.status}/${anonBoard.code ?? '-'}`);

  const job = must<{ id: string }>(
    '建职位',
    await call('POST', '/jobs', {
      as: mgr,
      body: {
        jobTitle: '高级后端工程师',
        level: 'P7',
        reportsTo: '技术总监',
        teamSize: 12,
        painPoints: '交易系统扩容、跨部门推动',
        description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
      },
    }),
  );
  const candidate = must<{ id: string }>(
    '建候选人',
    await call('POST', '/candidates', { as: hr, body: { jobId: job.id, name: '张伟', resumeText: RESUME_TEXT } }),
  );

  const standard = must<{ id: string }>(
    '发起标准访谈',
    await call('POST', `/jobs/${job.id}/standard`, {
      as: mgr,
      body: {
        jobTitle: '高级后端工程师',
        level: 'P7',
        reportsTo: '技术总监',
        teamSize: 12,
        painPoints: '交易系统扩容、跨部门推动',
        description: '负责订单与交易系统的架构设计、扩容与稳定性。',
      },
    }),
  );

  const t0 = Date.now();
  let asked = 0;
  for (const answer of ANSWERS) {
    const q = must<{ question: string | null }>('获取下一个问题', await call('GET', `/standards/${standard.id}/next-question`, { as: mgr }));
    if (!q.question) break;
    asked += 1;
    must(
      '记录回答',
      await call('POST', `/standards/${standard.id}/answers`, {
        as: mgr,
        body: { question: q.question, answer },
      }),
    );
  }
  check('完成多轮访谈记录', asked >= 4, `提问 ${asked} 轮，用时 ${Date.now() - t0}ms`);

  const proposed = must<{ standard: { dimensions: Array<{ id: string; name: string }>; conflicts: Array<{ dimensionId: string }> } }>(
    '提取考察标准',
    await call('POST', `/standards/${standard.id}/propose`, { as: mgr }),
  );
  const dims = proposed.standard.dimensions;
  check('真实模型提取 4-7 个维度', dims.length >= 4 && dims.length <= 7, `${dims.length} 个：${dims.map((d) => d.name).join('、')}`);

  for (const conflict of proposed.standard.conflicts) {
    await call('POST', `/standards/${standard.id}/conflicts/resolve`, {
      as: hr,
      body: { dimensionId: conflict.dimensionId, side: 'keep_standard' },
    });
  }
  for (const d of dims) {
    must('确认维度', await call('POST', `/standards/${standard.id}/dimensions/${d.id}/confirm`, { as: mgr }));
  }
  must('用人经理签字', await call('POST', `/standards/${standard.id}/sign`, { as: mgr, body: { party: 'hiring_manager' } }));
  must('HR 签字', await call('POST', `/standards/${standard.id}/sign`, { as: hr, body: { party: 'hr' } }));
  const finalized = must<{ status: string; version: string }>('定稿', await call('POST', `/standards/${standard.id}/finalize`, { as: hr }));
  check('标准定稿', finalized.status === 'confirmed', `${finalized.status}/${finalized.version}`);

  const interview = must<{ id: string }>(
    '排期',
    await call('POST', '/interviews', {
      as: hr,
      body: {
        jobId: job.id,
        candidateId: candidate.id,
        interviewerIds: [iv.user.id],
        scheduledAt: new Date().toISOString(),
        channel: 'video',
        round: 1,
      },
    }),
  );

  const prep = must<{ alignment: Array<{ mark: string }>; questions: Array<{ text: string }>; redFlagChecks: string[]; aiModel: string }>(
    '生成准备包',
    await call('POST', `/interviews/${interview.id}/prep-pack`, { as: iv }),
  );
  check(
    '真实模型生成准备包',
    prep.alignment.length === dims.length && prep.questions.length >= 3 && prep.redFlagChecks.length >= 1,
    `${prep.aiModel}｜对齐 ${prep.alignment.length}｜追问 ${prep.questions.length}`,
  );

  const prompt = must<{ presentedAt: string }>('获取同意文案', await call('GET', `/interviews/${interview.id}/consent`, { as: iv }));
  must(
    '记录同意',
    await call('POST', `/interviews/${interview.id}/consent`, {
      as: hr,
      body: { decision: 'granted', presentedAt: prompt.presentedAt },
    }),
  );
  must('开始面试', await call('POST', `/interviews/${interview.id}/start`, { as: iv }));

  const audioBase64 = readFileSync(WAV).toString('base64');
  const tAsr = Date.now();
  const asr = must<{ saved: Array<{ id: string; text: string; startMs: number; speaker: string }>; transcribed: number }>(
    '本机语音转写',
    await call('POST', `/interviews/${interview.id}/audio`, {
      as: iv,
      body: { base64: audioBase64, mime: 'audio/wav', filename: 'sample.wav', speaker: 'candidate', offsetMs: 0 },
    }),
  );
  const asrText = asr.saved.map((s) => s.text).join('');
  check(
    '本机模型转写真实音频',
    asr.saved.length >= 1 && /订单|架构|重构|接口/.test(asrText) && asr.saved[0]!.startMs >= 0,
    `${asr.saved.length} 段 / ${Date.now() - tAsr}ms｜${asrText.slice(0, 60)}`,
  );

  must('结束面试', await call('POST', `/interviews/${interview.id}/finish`, { as: iv }));

  const tDraft = Date.now();
  const draft = must<{
    draft: {
      id: string;
      checks: Array<{ aiEvidence: Array<{ segmentId: string; quote: string }>; finalScore: string | null; needsHumanInput: boolean }>;
      overallMatch: unknown;
    };
    rejectedClaims: Array<{ reason: string }>;
  }>(
    '生成面评草稿',
    await call('POST', `/interviews/${interview.id}/draft`, { as: iv, body: { interviewerId: iv.user.id } }),
  );
  const cited = draft.draft.checks.filter((c) => c.aiEvidence.length > 0);
  check(
    '真实模型面评只引用真实片段',
    cited.length >= 1 && cited.every((c) => c.aiEvidence.every((e) => e.quote.length > 0)),
    `${draft.draft.checks.length} 个维度 / ${cited.length} 个带引用 / ${Date.now() - tDraft}ms`,
  );
  check('面评不生成总分', draft.draft.overallMatch === null, 'overallMatch=null');
  check('AI 起评分不写最终分', draft.draft.checks.every((c) => c.finalScore === null), 'finalScore 全空');

  const report = [
    '面证 · 真实链路验收报告',
    `时间：${new Date().toISOString()}`,
    `语言模型：${config.llm?.model ?? '未配置'}`,
    `语音识别：本机 SenseVoice（sherpa-onnx）`,
    '',
    ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` ｜ ${c.detail}` : ''}`),
    '',
    `通过 ${checks.filter((c) => c.ok).length}/${checks.length}`,
  ].join('\n');
  writeFileSync(REPORT, report, 'utf8');
  console.log(report);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main()
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const report = [
      '面证 · 真实链路验收报告',
      `时间：${new Date().toISOString()}`,
      'FAIL  验收中断',
      message,
      '',
      ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` ｜ ${c.detail}` : ''}`),
    ].join('\n');
    writeFileSync(REPORT, report, 'utf8');
    console.error(report);
    process.exitCode = 1;
  })
  .finally(() => void teardown());
