import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock, MockLlmProvider, MockTranscriptionProvider } from '@mianyan/core';
import { MianYanApp } from '@mianyan/core/server';
import { FileAudioStore } from '../audioStore.js';
import { registerRoutes } from '../routes.js';

const INTAKE = {
  jobTitle: '高级后端工程师',
  level: 'P7',
  reportsTo: '技术总监',
  teamSize: 12,
  painPoints: '交易系统扩容、跨部门推动',
  description: '负责订单与交易系统的架构设计、扩容与稳定性，需要跨部门推动能力与数据驱动意识。',
};

const ANSWERS = [
  '最需要解决的是交易系统在大促高并发下不稳定，业务上先出事的就是订单丢失和支付超时。',
  '做到 90 分的人能把扩容方案和取舍讲清楚，交付结果上接口耗时降低、故障恢复时间缩短。',
  '比如去年大促，他主动牵头把订单链路重构落地，压测方案也是他提出来要先看的。',
  '最警惕的是把线上故障归因给同事和环境，或者全程只讲动作不讲结果，这种人我不会要。',
];

let app: MianYanApp;
let server: FastifyInstance;
let audioDir: string;

beforeEach(async () => {
  audioDir = mkdtempSync(join(tmpdir(), 'mianyan-agent-http-'));
  app = await MianYanApp.open({
    dbPath: ':memory:',
    clock: new FixedClock('2026-03-02T01:00:00.000Z'),
    llm: new MockLlmProvider(),
    asr: new MockTranscriptionProvider(),
  });
  server = Fastify();
  registerRoutes(server, app, new FileAudioStore(audioDir), null);
  await server.ready();
});

afterEach(async () => {
  await server.close();
  app.store.close();
  rmSync(audioDir, { recursive: true, force: true });
});

interface Session {
  cookie: string;
  orgId: string;
}

async function registerOrg(orgName: string, email: string): Promise<Session> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { orgName, name: '李 HR', email, password: 'password123' },
  });
  expect(res.statusCode).toBe(201);
  const raw = res.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  if (!cookie) throw new Error('register did not set a session cookie');
  return { cookie, orgId: res.json().org.id };
}

function auth(session: Session): Record<string, string> {
  return { cookie: session.cookie };
}

async function createJob(session: Session): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/jobs', headers: auth(session), payload: INTAKE });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe('Agent 的 HTTP 边界', () => {
  it('登录后能走完定标循环，并在刷新后取回同一条任务与产出', async () => {
    const hr = await registerOrg('杭州云帆科技有限公司', 'hr@yunfan.example');
    const jobId = await createJob(hr);

    const started = await server.inject({
      method: 'POST',
      url: `/jobs/${jobId}/agent/standard`,
      headers: auth(hr),
      payload: INTAKE,
    });
    expect(started.statusCode).toBe(201);
    let bundle = started.json();
    expect(bundle.run.phase).toBe('standard');
    expect(bundle.run.status).toBe('awaiting_human');
    expect(bundle.run.goal).toContain('考察维度');
    expect(typeof bundle.run.question.question).toBe('string');

    let rounds = 0;
    while (bundle.run.status === 'awaiting_human' && rounds < ANSWERS.length) {
      const answered = await server.inject({
        method: 'POST',
        url: `/agent/runs/${bundle.run.id}/answer`,
        headers: auth(hr),
        payload: { answer: ANSWERS[rounds] },
      });
      expect(answered.statusCode).toBe(200);
      const next = answered.json();
      expect(next.run.steps.filter((s: { kind: string }) => s.kind === 'answer').length).toBe(rounds + 1);
      bundle = next;
      rounds += 1;
    }

    expect(rounds).toBe(ANSWERS.length);
    expect(bundle.run.status).toBe('completed');
    expect(bundle.run.stopReason).toBeNull();
    expect(bundle.run.result.summary).toContain('考察维度');
    expect(bundle.standard.dimensions.length).toBeGreaterThanOrEqual(4);
    expect(bundle.run.question).toBeNull();

    const reread = await server.inject({ method: 'GET', url: `/agent/runs/${bundle.run.id}`, headers: auth(hr) });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().run.id).toBe(bundle.run.id);
    expect(reread.json().standard.id).toBe(bundle.standard.id);

    const listed = await server.inject({ method: 'GET', url: `/jobs/${jobId}/agent-runs`, headers: auth(hr) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((r: { id: string }) => r.id)).toContain(bundle.run.id);
  });

  it('未登录拿不到任务；另一个工作区访问同一条任务和候选人账本都是 404', async () => {
    const owner = await registerOrg('杭州云帆科技有限公司', 'hr@yunfan.example');
    const jobId = await createJob(owner);
    const started = await server.inject({
      method: 'POST',
      url: `/jobs/${jobId}/agent/standard`,
      headers: auth(owner),
      payload: INTAKE,
    });
    const runId: string = started.json().run.id;

    const anonymous = await server.inject({ method: 'GET', url: `/agent/runs/${runId}` });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('auth_required');

    const candidate = await server.inject({
      method: 'POST',
      url: '/candidates',
      headers: auth(owner),
      payload: { jobId, name: '张伟', resumeText: '8 年后端经验，主导订单系统重构。' },
    });
    expect(candidate.statusCode).toBe(201);
    const candidateId: string = candidate.json().id;

    const outsider = await registerOrg('上海另一种可能设计有限公司', 'hr@another.example');
    const peek = await server.inject({ method: 'GET', url: `/agent/runs/${runId}`, headers: auth(outsider) });
    expect(peek.statusCode).toBe(404);
    expect(peek.json().code).toBe('record_not_found');

    const hijack = await server.inject({
      method: 'POST',
      url: `/agent/runs/${runId}/answer`,
      headers: auth(outsider),
      payload: { answer: '我替他回答。' },
    });
    expect(hijack.statusCode).toBe(404);

    const ledger = await server.inject({
      method: 'GET',
      url: `/ledger?candidateId=${candidateId}&jobId=${jobId}`,
      headers: auth(outsider),
    });
    expect(ledger.statusCode).toBe(404);
    expect(ledger.json().code).toBe('candidate_not_found');

    const ownLedger = await server.inject({
      method: 'GET',
      url: `/ledger?candidateId=${candidateId}&jobId=${jobId}`,
      headers: auth(owner),
    });
    expect(ownLedger.statusCode).toBe(200);
    expect(Array.isArray(ownLedger.json().entries)).toBe(true);

    const jobRuns = await server.inject({ method: 'GET', url: `/jobs/${jobId}/agent-runs`, headers: auth(outsider) });
    expect(jobRuns.statusCode).toBe(404);
  });

  it('受保护特征的回答在接口层被拒，待答问题保持原样', async () => {
    const hr = await registerOrg('杭州云帆科技有限公司', 'hr@yunfan.example');
    const jobId = await createJob(hr);
    const started = await server.inject({
      method: 'POST',
      url: `/jobs/${jobId}/agent/standard`,
      headers: auth(hr),
      payload: INTAKE,
    });
    const run = started.json().run;
    const pending: string = run.question.question;

    const rejected = await server.inject({
      method: 'POST',
      url: `/agent/runs/${run.id}/answer`,
      headers: auth(hr),
      payload: { answer: '最好是已婚已育的男生，稳定一点。' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('protected_attribute_detected');

    const reread = await server.inject({ method: 'GET', url: `/agent/runs/${run.id}`, headers: auth(hr) });
    expect(reread.json().run.status).toBe('awaiting_human');
    expect(reread.json().run.question.question).toBe(pending);
    expect(reread.json().run.steps.some((s: { kind: string }) => s.kind === 'answer')).toBe(false);

    const malformed = await server.inject({
      method: 'POST',
      url: `/agent/runs/${run.id}/answer`,
      headers: auth(hr),
      payload: { answer: '   ' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().message).toContain('回答');
  });
});
