import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applySpeakerMap,
  DAY_MS,
  detectSpeakers,
  DomainError,
  isDomainError,
  humanActor,
  LlmProviderError,
  parseMeetingExport,
  scanForProtectedAttributes,
  type Actor,
  type AsrSegment,
  type FixedClock,
  type Org,
  type User,
} from '@mianyan/core';
import type { MianYanApp } from '@mianyan/core/server';
import type { FileAudioStore } from './audioStore.js';
import { clearSessionCookie, readBearerToken, readSessionToken, sessionCookie } from './sessionCookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { user: User; org: Org; token: string };
  }
}

const memberRoleSchema = z.enum(['hr', 'interviewer', 'hiring_manager']);

function actorOf(req: FastifyRequest): Actor {
  if (!req.auth) throw new DomainError('auth_required', '请先登录，再继续操作');
  return humanActor(req.auth.user);
}

function sessionTokenOf(req: FastifyRequest): string | null {
  return readSessionToken(req.headers.cookie) ?? readBearerToken(req.headers.authorization);
}

const PUBLIC_ROUTES = new Set(['/health', '/auth/login', '/auth/register', '/auth/logout']);
const OPTIONAL_AUTH_ROUTES = new Set(['/auth/me']);

/** Field names are how a schema fails; a person only needs to know which input to look at. */
const FIELD_LABEL: Record<string, string> = {
  orgId: '企业',
  orgName: '企业名称',
  email: '邮箱',
  password: '密码',
  currentPassword: '当前密码',
  newPassword: '新密码',
  jobId: '岗位',
  jobTitle: '岗位名称',
  candidateId: '候选人',
  standardId: '金标准',
  interviewId: '面试',
  runId: '这次助手任务',
  dimensionId: '考察维度',
  interviewerId: '面试官',
  interviewerIds: '面试官',
  questionId: '追问',
  draftId: '面评草稿',
  checkId: '维度检查项',
  audioId: '音频',
  segmentId: '转写片段',
  userId: '用户',
  party: '签署方',
  side: '裁定方向',
  decision: '知情同意选择',
  channel: '面试形式',
  round: '轮次',
  scheduledAt: '面试时间',
  presentedAt: '同意文案展示时间',
  startMs: '开始时间',
  endMs: '结束时间',
  confidence: '识别置信度',
  speaker: '说话人',
  speakerLabel: '说话人标签',
  segments: '转写片段',
  text: '内容',
  question: '问题',
  answer: '回答',
  reason: '理由',
  name: '名称',
  level: '职级',
  reportsTo: '汇报对象',
  teamSize: '团队规模',
  painPoints: '当前最痛的点',
  description: '职位描述',
  resumeText: '简历正文',
  positiveEvidence: '应该看到的信号',
  redFlags: '需要警惕的信号',
  probes: '校准追问',
  matchKeywords: '匹配关键词',
  overrideReason: '改写理由',
  finalScore: '评分',
  finalSummary: '评价摘要',
  recommendation: '推荐意见',
  fillUnscored: '未评分项的处理方式',
  agreeUsedForDecision: '决策依据确认',
  anonymizeName: '匿名化选择',
  extraHours: '宽限小时数',
  inlineTranscript: '粘贴的对话文本',
  source: '转写来源',
  speakerMap: '发言人对应关系',
  base64: '音频内容',
  mime: '音频格式',
  filename: '文件名',
  subject: '检查对象',
  input: '检查内容',
  hours: '推进小时数',
  days: '推进天数',
};

function issueText(issue: z.ZodIssue): string {
  const leaf = [...issue.path].reverse().find((p) => typeof p === 'string');
  const name = (typeof leaf === 'string' && FIELD_LABEL[leaf]) || '这一项';
  const numeric = 'type' in issue && issue.type === 'number';
  switch (issue.code) {
    case 'too_small':
      return numeric ? `${name}不在允许的范围内` : `${name}不能留空`;
    case 'too_big':
      return numeric ? `${name}超出了允许的范围` : `${name}太长了，可以再精简`;
    case 'invalid_type':
      return issue.expected === 'number' ? `${name}要填数字` : `${name}填写格式不对`;
    case 'invalid_enum_value':
      return `${name}不在可选项里`;
    case 'unrecognized_keys':
      return '提交内容里有多余项';
    default:
      return `${name}填写不正确`;
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const res = schema.safeParse(body ?? {});
  if (!res.success) {
    throw new DomainError('bad_request', res.error.issues.map(issueText).join('；'));
  }
  return res.data;
}

const str = (min = 1) => z.string().trim().min(min);
const id = z.string().trim().min(1);
const idList = z.array(id).min(1);
const strList = z.array(z.string().trim().min(1));

const intakeSchema = z.object({
  jobTitle: str(),
  level: str(),
  reportsTo: str(),
  teamSize: z.coerce.number().int().min(0).max(2000),
  painPoints: str(),
  description: str(),
});

const registerSchema = z.object({
  orgName: z.string().trim().min(2).max(60),
  name: z.string().trim().min(1).max(40),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });
const memberSchema = z.object({
  role: memberRoleSchema,
  name: z.string().trim().min(1).max(40),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
const candidateSchema = z.object({ jobId: id, name: str(), resumeText: z.string().min(1) });
const answerSchema = z.object({ question: str(1), answer: str(1) });
const dimensionPatchSchema = z
  .object({
    name: str(),
    positiveEvidence: strList,
    redFlags: strList,
    probes: strList,
    matchKeywords: strList,
    overrideReason: str(4).optional(),
  })
  .partial();
const conflictSchema = z.object({ dimensionId: id, side: z.enum(['keep_standard', 'keep_job_description']) });
const signSchema = z.object({ party: z.enum(['hiring_manager', 'hr']) });
const scheduleSchema = z.object({
  jobId: id,
  candidateId: id,
  interviewerIds: idList,
  scheduledAt: str(),
  channel: z.enum(['video', 'phone', 'onsite']),
  round: z.coerce.number().int().min(1).max(12),
});
const consentSchema = z.object({ decision: z.enum(['granted', 'refused']), presentedAt: str() });
const segmentsSchema = z.object({
  segments: z
    .array(
      z.object({
        speaker: z.enum(['candidate', 'interviewer', 'unknown']),
        speakerLabel: z.string().trim().max(40).nullish(),
        startMs: z.coerce.number().int().min(0),
        endMs: z.coerce.number().int().min(0),
        text: z.string().min(1).max(4000),
        confidence: z.coerce.number().min(0).max(1),
      }),
    )
    .min(1),
});
const inlineSchema = z.object({ inlineTranscript: z.string().min(1).max(200_000) });
const transcriptSourceSchema = z.enum(['dingtalk', 'feishu', 'tencent', 'other']);
const importPreviewSchema = z.object({ inlineTranscript: z.string().min(1).max(200_000) });
const importSchema = z.object({
  inlineTranscript: z.string().min(1).max(200_000),
  source: transcriptSourceSchema,
  speakerMap: z.record(z.string().max(40), z.enum(['candidate', 'interviewer', 'unknown'])),
});
const audioSchema = z.object({
  base64: z.string().min(16).max(24_000_000),
  mime: str(),
  filename: z.string().trim().max(120).optional(),
  speaker: z.enum(['candidate', 'interviewer', 'unknown']).default('candidate'),
  offsetMs: z.coerce.number().int().min(0).max(6 * 60 * 60 * 1000).default(0),
});
const questionSchema = z.object({ text: z.string().trim().min(2).max(500), dimensionId: z.union([id, z.null()]) });
const reasonSchema = z.object({ reason: str(4) });
const checkPatchSchema = z.object({
  finalScore: z.enum(['high', 'medium', 'low']).nullable().optional(),
  finalSummary: z.string().trim().max(2000).optional(),
  addEvidenceSegmentIds: z.array(id).optional(),
  dropEvidenceSegmentIds: z.array(id).optional(),
});
const recommendationSchema = z.object({ recommendation: str(2) });
const submitSchema = z.object({
  fillUnscored: z.coerce.boolean(),
  agreeUsedForDecision: z.coerce.boolean(),
  anonymizeName: z.coerce.boolean(),
});
const cadenceSchema = z.object({ extraHours: z.coerce.number().min(0).max(168) });
const draftActorSchema = z.object({ interviewerId: id.optional() });
const agentEvaluationSchema = z.object({ interviewerId: id.optional() });
const agentAnswerSchema = z.object({ answer: z.string().trim().min(1).max(2000) });
const ledgerQuerySchema = z.object({ candidateId: id, jobId: id });

export function registerRoutes(
  server: FastifyInstance,
  app: MianYanApp,
  audio: FileAudioStore,
  clock: FixedClock | null,
  options: { cookieSecure?: boolean } = {},
): void {
  const secureCookie = options.cookieSecure ?? false;
  const sendSession = (reply: FastifyReply, token: string) => {
    reply.header('set-cookie', sessionCookie(token, secureCookie));
  };
  const snapshotOf = (user: User, org: Org) => ({ user, org, members: app.store.listUsers(org.id) });

  /**
   * Default deny: every route except health and the three auth entry points needs a live
   * server-side session. Identity is never read from a request header, so a browser cannot
   * pick who it wants to be.
   */
  server.addHook('onRequest', async (req, reply) => {
    const path = req.routeOptions.url ?? '';
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // SameSite=Lax already blocks cross-site POSTs; this stops the request even in browsers
      // that ignore it, without needing an origin allow-list for every deployment.
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return reply.status(403).send({ code: 'cross_site_blocked', message: '请从面证页面内完成这个操作', details: null });
      }
    }

    const token = sessionTokenOf(req);
    if (token) {
      const resolved = app.auth.resolve(token);
      if (resolved) req.auth = { user: resolved.user, org: resolved.org, token };
      else if (path !== '/auth/login') reply.header('set-cookie', clearSessionCookie(secureCookie));
    }

    if (PUBLIC_ROUTES.has(path) || OPTIONAL_AUTH_ROUTES.has(path)) return;
    if (!req.auth) {
      return reply.status(401).send({ code: 'auth_required', message: '请先登录，再继续操作', details: null });
    }
  });

  /** Cross-org reads and writes answer 404, so an id from another workspace cannot be probed. */
  server.addHook('preHandler', async (req) => {
    const auth = req.auth;
    if (!auth) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const mismatch = () => new DomainError('record_not_found', '这条记录不属于当前工作区');
    if (params.orgId && params.orgId !== auth.org.id) throw mismatch();

    const orgOf: Record<string, string | undefined> = {};
    if (params.jobId) orgOf.jobId = app.store.findJob(params.jobId)?.orgId;
    if (params.candidateId) orgOf.candidateId = app.store.findCandidate(params.candidateId)?.orgId;
    if (params.interviewId) orgOf.interviewId = app.store.findInterview(params.interviewId)?.orgId;
    if (params.standardId) orgOf.standardId = app.store.findStandard(params.standardId)?.orgId;
    if (params.draftId) orgOf.draftId = app.store.findDraft(params.draftId)?.orgId;
    if (params.reminderId) orgOf.reminderId = app.store.findReminder(params.reminderId)?.orgId;
    if (params.userId) orgOf.userId = app.store.findUser(params.userId)?.orgId;
    if (params.runId) orgOf.runId = app.store.findAgentRun(params.runId)?.orgId;
    if (params.segmentId) {
      const segment = app.store.findSegment(params.segmentId);
      if (segment) orgOf.segmentId = app.store.findInterview(segment.interviewId)?.orgId;
    }
    for (const orgId of Object.values(orgOf)) {
      if (orgId !== undefined && orgId !== auth.org.id) throw mismatch();
    }
  });

  /**
   * 结束面试、触发草稿、催办 tick 这类动作没有任何表单字段，只带会话 Cookie。
   * Fastify 默认的 JSON 解析器会把空 body 判成 500，所以在此覆盖它。
   */
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, rawBody, done) => {
    const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    if (text.length === 0) {
      done(null, {});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      done(new DomainError('bad_request', '提交的内容没能解析，请刷新后重试'), undefined);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      done(new DomainError('bad_request', '这次提交的内容格式不对，请重试'), undefined);
      return;
    }
    done(null, parsed);
  });

  server.setErrorHandler((err, req, reply) => {
    if (isDomainError(err)) {
      const unauthorized = ['auth_required', 'invalid_credentials'];
      const forbidden = [
        'human_only',
        'hr_only',
        'consent_required',
        'restart_requires_hr',
        'actor_required',
        'actor_unknown',
        'org_suspended',
        'cross_site_blocked',
        'forbidden',
      ];
      const conflict = [
        'illegal_state_transition',
        'wrong_state',
        'already_submitted',
        'draft_locked',
        'standard_locked',
        'consent_wrong_state',
        'email_taken',
      ];
      const status = unauthorized.includes(err.code)
        ? 401
        : forbidden.includes(err.code)
          ? 403
          : conflict.includes(err.code)
            ? 409
            : err.code === 'too_many_attempts'
              ? 429
              : err.code === 'standard_not_found' || err.code.endsWith('_not_found')
                ? 404
                : 400;
      return reply.status(status).send({ code: err.code, message: err.message, details: err.details ?? null });
    }
    if (err instanceof LlmProviderError) {
      req.log.error({ err }, 'llm provider unavailable');
      return reply.status(502).send({
        code: 'llm_unavailable',
        message: '助手暂时没能完成这次处理，请稍后重试；如果一直失败，请联系管理员。',
        details: null,
      });
    }
    const anyErr = err as { message?: string; issues?: unknown[] };
    if (Array.isArray(anyErr.issues)) {
      return reply.status(400).send({ code: 'bad_request', message: '请求体不符合约定', details: anyErr.issues });
    }
    req.log.error(err);
    return reply.status(500).send({ code: 'internal_error', message: anyErr.message ?? 'unknown error' });
  });

  server.get('/health', async () => ({
    ok: true,
    llmDriver: app.ctx.llm.driver,
    llmModel: app.ctx.llm.model,
    asrProvider: app.ctx.asr.id,
    retention: app.ctx.retention,
  }));

  // ---- 登录、注册与会话 ----
  server.post('/auth/register', async (req, reply) => {
    const b = parse(registerSchema, req.body);
    const result = app.auth.registerOrg(b);
    sendSession(reply, result.token);
    reply.status(201).send(snapshotOf(result.user, result.org));
  });

  server.post('/auth/login', async (req, reply) => {
    const b = parse(loginSchema, req.body);
    const result = app.auth.login(b.email, b.password);
    sendSession(reply, result.token);
    reply.send(snapshotOf(result.user, result.org));
  });

  server.post('/auth/logout', async (req, reply) => {
    const token = sessionTokenOf(req);
    if (token) app.auth.logout(token);
    reply.header('set-cookie', clearSessionCookie(secureCookie));
    return { ok: true };
  });

  server.get('/auth/me', async (req, reply) => {
    if (!req.auth) {
      return reply.status(401).send({ code: 'auth_required', message: '请先登录，再继续操作', details: null });
    }
    return snapshotOf(req.auth.user, req.auth.org);
  });

  server.post('/auth/password', async (req, reply) => {
    const b = parse(passwordChangeSchema, req.body);
    const auth = req.auth;
    if (!auth) throw new DomainError('auth_required', '请先登录，再继续操作');
    app.auth.changePassword(auth.user.id, b.currentPassword, b.newPassword);
    // Every other device is signed out by the change; this tab gets a fresh session.
    if (!auth.user.email) {
      reply.header('set-cookie', clearSessionCookie(secureCookie));
      return { ok: true };
    }
    const fresh = app.auth.login(auth.user.email, b.newPassword);
    sendSession(reply, fresh.token);
    return snapshotOf(fresh.user, fresh.org);
  });

  // ---- 成员（仅招聘负责人可添加；密码由管理员当面设置，不通过邮件发送） ----
  server.post('/orgs/:orgId/users', async (req, reply) => {
    const b = parse(memberSchema, req.body);
    const orgId = (req.params as { orgId: string }).orgId;
    const user = app.auth.createMember(actorOf(req), orgId, b);
    reply.status(201).send(user);
  });

  server.get('/orgs/:orgId/users', async (req) => app.store.listUsers((req.params as { orgId: string }).orgId));

  server.post('/jobs', async (req, reply) => {
    const b = parse(intakeSchema, req.body);
    const job = app.createJob(req.auth!.org.id, b);
    reply.status(201).send(job);
  });
  server.get('/jobs/:jobId', async (req) => {
    const job = app.store.findJob((req.params as { jobId: string }).jobId);
    if (!job) throw new DomainError('job_not_found', '职位不存在');
    return job;
  });
  server.get('/orgs/:orgId/jobs', async (req) => app.store.listJobs((req.params as { orgId: string }).orgId));

  server.post('/candidates', async (req, reply) => {
    const b = parse(candidateSchema, req.body);
    const job = app.store.findJob(b.jobId);
    if (!job || job.orgId !== req.auth!.org.id) throw new DomainError('job_not_found', '岗位不存在');
    const candidate = app.addCandidate(req.auth!.org.id, b.jobId, b.name, b.resumeText);
    reply.status(201).send(candidate);
  });
  server.get('/candidates/:candidateId', async (req) => {
    const c = app.store.findCandidate((req.params as { candidateId: string }).candidateId);
    if (!c) throw new DomainError('candidate_not_found', '候选人不存在');
    return c;
  });
  server.get('/orgs/:orgId/candidates', async (req) => app.store.listCandidates((req.params as { orgId: string }).orgId));

  server.delete('/candidates/:candidateId', async (req) => {
    const b = parse(reasonSchema, req.body);
    return app.compliance.requestDeletion(actorOf(req), (req.params as { candidateId: string }).candidateId, b.reason);
  });

  // ---- 岗位金标准访谈提取 ----
  server.post('/jobs/:jobId/standard', async (req, reply) => {
    const b = parse(intakeSchema, req.body);
    const std = app.goldenStandard.startIntake(actorOf(req), (req.params as { jobId: string }).jobId, b);
    reply.status(201).send(std);
  });

  server.post('/jobs/:jobId/standard/from-template', async (req, reply) => {
    const b = parse(z.object({ freeText: str(4) }), req.body);
    const std = app.goldenStandard.createFromTemplateLibrary(actorOf(req), (req.params as { jobId: string }).jobId, b.freeText);
    reply.status(201).send(std);
  });

  server.get('/standards/:standardId', async (req) => {
    const std = app.store.findStandard((req.params as { standardId: string }).standardId);
    if (!std) throw new DomainError('standard_not_found', '金标准不存在');
    return std;
  });
  server.get('/jobs/:jobId/standards', async (req) => app.store.listStandardsForJob((req.params as { jobId: string }).jobId));

  server.get('/standards/:standardId/next-question', async (req) => ({
    question: app.goldenStandard.nextQuestion((req.params as { standardId: string }).standardId),
  }));

  server.post('/standards/:standardId/answers', async (req) => {
    const b = parse(answerSchema, req.body);
    return app.goldenStandard.recordAnswer(actorOf(req), (req.params as { standardId: string }).standardId, b.question, b.answer);
  });

  server.post('/standards/:standardId/propose', async (req) =>
    app.goldenStandard.proposeDraft(actorOf(req), (req.params as { standardId: string }).standardId),
  );

  server.post('/standards/:standardId/conflicts/resolve', async (req) => {
    const b = parse(conflictSchema, req.body);
    return app.goldenStandard.resolveConflict(actorOf(req), (req.params as { standardId: string }).standardId, b.dimensionId, b.side);
  });

  server.patch('/standards/:standardId/dimensions/:dimensionId', async (req) => {
    const b = parse(dimensionPatchSchema, req.body);
    const { overrideReason, ...patch } = b;
    return app.goldenStandard.reviseDimension(
      actorOf(req),
      (req.params as { standardId: string; dimensionId: string }).standardId,
      (req.params as { standardId: string; dimensionId: string }).dimensionId,
      patch,
      overrideReason,
    );
  });

  server.post('/standards/:standardId/dimensions/:dimensionId/confirm', async (req) => {
    const p = req.params as { standardId: string; dimensionId: string };
    return app.goldenStandard.confirmDimension(actorOf(req), p.standardId, p.dimensionId);
  });

  server.post('/standards/:standardId/sign', async (req) => {
    const b = parse(signSchema, req.body);
    return app.goldenStandard.sign(actorOf(req), (req.params as { standardId: string }).standardId, b.party);
  });

  server.post('/standards/:standardId/finalize', async (req) =>
    app.goldenStandard.finalize(actorOf(req), (req.params as { standardId: string }).standardId),
  );

  // ---- 面试准备包 ----
  server.post('/candidates/:candidateId/resume', async (req) => {
    const b = parse(z.object({ resumeText: z.string().min(1) }), req.body);
    return app.prepPack.submitResume(actorOf(req), (req.params as { candidateId: string }).candidateId, b.resumeText);
  });

  server.post('/interviews/:interviewId/prep-pack', async (req) =>
    app.prepPack.build(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );

  server.get('/interviews/:interviewId/prep-pack', async (req) => {
    const interviewId = (req.params as { interviewId: string }).interviewId;
    const pack = app.store.latestPrepPack(interviewId);
    if (!pack) throw new DomainError('prep_pack_missing', '这场面试还没有准备包，点上面的「生成准备包」就能出一页纸');
    return pack;
  });

  server.post('/interviews/:interviewId/prep-pack/questions', async (req) => {
    const b = parse(questionSchema, req.body);
    return app.prepPack.addInterviewerQuestion(
      actorOf(req),
      (req.params as { interviewId: string }).interviewId,
      b.text,
      b.dimensionId,
    );
  });

  server.post('/interviews/:interviewId/prep-pack/questions/:questionId/veto', async (req) => {
    const b = parse(reasonSchema, req.body);
    const p = req.params as { interviewId: string; questionId: string };
    return app.prepPack.vetoQuestion(actorOf(req), p.interviewId, p.questionId, b.reason);
  });

  server.get('/interviews/:interviewId/prep-pack/panel', async (req) => ({
    ...app.prepPack.mergePanelPacks((req.params as { interviewId: string }).interviewId),
    packs: app.store.listPrepPacks((req.params as { interviewId: string }).interviewId),
  }));

  // ---- 面试证据 Agent：一个目标、一条循环、一本账 ----
  server.post('/jobs/:jobId/agent/standard', async (req, reply) => {
    const b = parse(intakeSchema, req.body);
    const bundle = await app.agent.startStandard(actorOf(req), (req.params as { jobId: string }).jobId, b);
    reply.status(201).send(bundle);
  });

  server.get('/jobs/:jobId/agent-runs', async (req) =>
    app.agent.listRunsForJob((req.params as { jobId: string }).jobId),
  );

  server.post('/interviews/:interviewId/agent/prep', async (req, reply) => {
    parse(z.object({}), req.body);
    const bundle = await app.agent.startPrep(actorOf(req), (req.params as { interviewId: string }).interviewId);
    reply.status(201).send(bundle);
  });

  server.post('/interviews/:interviewId/agent/evaluation', async (req, reply) => {
    const b = parse(agentEvaluationSchema, req.body);
    if (b.interviewerId && app.store.findUser(b.interviewerId)?.orgId !== req.auth!.org.id) {
      throw new DomainError('interviewer_not_found', '面试官不属于当前工作区');
    }
    const bundle = await app.agent.startEvaluation(
      actorOf(req),
      (req.params as { interviewId: string }).interviewId,
      b.interviewerId,
    );
    reply.status(201).send(bundle);
  });

  server.get('/interviews/:interviewId/agent-runs', async (req) =>
    app.agent.listRunsForInterview((req.params as { interviewId: string }).interviewId),
  );

  server.get('/agent/runs/:runId', async (req) =>
    app.agent.getBundle((req.params as { runId: string }).runId),
  );

  server.post('/agent/runs/:runId/answer', async (req) => {
    const b = parse(agentAnswerSchema, req.body);
    return app.agent.answer((req.params as { runId: string }).runId, actorOf(req), b.answer);
  });

  /** The candidate's evidence memory: what was backed, what is still open, what carries forward. */
  server.get('/ledger', async (req) => {
    const q = parse(ledgerQuerySchema, req.query);
    const orgId = req.auth!.org.id;
    if (app.store.findCandidate(q.candidateId)?.orgId !== orgId) {
      throw new DomainError('candidate_not_found', '候选人不存在');
    }
    if (app.store.findJob(q.jobId)?.orgId !== orgId) throw new DomainError('job_not_found', '岗位不存在');
    return { entries: app.agent.ledgerFor(q.candidateId, q.jobId) };
  });

  // ---- 排期、知情同意、静默转写 ----
  server.post('/interviews', async (req, reply) => {
    const b = parse(scheduleSchema, req.body);
    const orgId = req.auth!.org.id;
    if (app.store.findJob(b.jobId)?.orgId !== orgId) throw new DomainError('job_not_found', '岗位不存在');
    if (app.store.findCandidate(b.candidateId)?.orgId !== orgId) {
      throw new DomainError('candidate_not_found', '候选人不存在');
    }
    for (const interviewerId of b.interviewerIds) {
      if (app.store.findUser(interviewerId)?.orgId !== orgId) {
        throw new DomainError('interviewer_not_found', '面试官不属于当前工作区');
      }
    }
    reply.status(201).send(app.flow.schedule(actorOf(req), b));
  });
  server.get('/interviews/:interviewId', async (req) => {
    const i = app.store.findInterview((req.params as { interviewId: string }).interviewId);
    if (!i) throw new DomainError('interview_not_found', '面试不存在');
    return i;
  });
  server.get('/orgs/:orgId/interviews', async (req) => app.store.listInterviews((req.params as { orgId: string }).orgId));

  server.get('/interviews/:interviewId/consent', async (req) =>
    app.flow.presentConsent((req.params as { interviewId: string }).interviewId),
  );

  server.post('/interviews/:interviewId/consent', async (req) => {
    const b = parse(consentSchema, req.body);
    return app.flow.answerConsent(actorOf(req), (req.params as { interviewId: string }).interviewId, b.decision, b.presentedAt);
  });

  server.post('/interviews/:interviewId/start', async (req) =>
    app.flow.start(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );

  server.post('/interviews/:interviewId/pause', async (req) => {
    const b = parse(z.object({ paused: z.coerce.boolean() }), req.body);
    return app.flow.setPaused(actorOf(req), (req.params as { interviewId: string }).interviewId, b.paused);
  });

  server.post('/interviews/:interviewId/segments', async (req) => {
    const b = parse(segmentsSchema, req.body);
    return app.flow.appendSegments(actorOf(req), (req.params as { interviewId: string }).interviewId, b.segments as AsrSegment[]);
  });

  /** v1's realistic ingest: HR or the meeting tool hands over the text of the session. */
  server.post('/interviews/:interviewId/transcript', async (req) => {
    const b = parse(inlineSchema, req.body);
    const interviewId = (req.params as { interviewId: string }).interviewId;
    const segments = await app.ctx.asr.transcribe({ inlineTranscript: b.inlineTranscript });
    return { transcribed: segments.length, ...app.flow.appendSegments(actorOf(req), interviewId, segments) };
  });

  server.post('/interviews/:interviewId/transcript/preview', async (req) => {
    const b = parse(importPreviewSchema, req.body);
    const segments = parseMeetingExport(b.inlineTranscript);
    return {
      segments: segments.length,
      durationMs: segments.length > 0 ? Math.max(...segments.map((s) => s.endMs)) : 0,
      speakers: detectSpeakers(segments),
    };
  });

  server.post('/interviews/:interviewId/transcript/import', async (req) => {
    const b = parse(importSchema, req.body);
    const interviewId = (req.params as { interviewId: string }).interviewId;
    const segments = applySpeakerMap(parseMeetingExport(b.inlineTranscript), b.speakerMap);
    return { transcribed: segments.length, ...app.flow.importTranscript(actorOf(req), interviewId, segments, b.source) };
  });

  server.post('/interviews/:interviewId/audio', async (req, reply) => {
    const b = parse(audioSchema, req.body);
    const interviewId = (req.params as { interviewId: string }).interviewId;
    const interview = app.store.findInterview(interviewId);
    if (!interview) throw new DomainError('interview_not_found', '面试不存在');
    if (!interview.aiRecordingActive) throw new DomainError('not_recording', '候选人未同意或 AI 已暂停，不接收音频');
    const audioId = `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const meta = audio.put(interviewId, audioId, b.base64, b.mime, b.filename, app.ctx.clock.now().getTime());
    app.store.saveAudioBlob(meta);
    let segments: AsrSegment[];
    try {
      segments = await app.ctx.asr.transcribe({ audioId, mime: b.mime, speaker: b.speaker, offsetMs: b.offsetMs });
    } catch (err) {
      /** The recording stays under the retention clock, but the caller must see the failure. */
      req.log.error({ err, audioId, interviewId }, 'transcription failed');
      reply.status(502).send({
        code: 'asr_failed',
        message: '这段录音暂时没能转成文字，录音已保留，可以重试',
        details: err instanceof Error ? err.message : String(err),
        audioId,
        bytes: meta.bytes,
      });
      return;
    }
    reply
      .status(201)
      .send({
        audioId,
        bytes: meta.bytes,
        transcribed: segments.length,
        ...app.flow.appendSegments(actorOf(req), interviewId, segments),
      });
  });

  server.patch('/segments/:segmentId', async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(4000) }), req.body);
    return app.flow.correctSegment(actorOf(req), (req.params as { segmentId: string }).segmentId, b.text);
  });

  server.get('/interviews/:interviewId/transcript', async (req) => ({
    segments: app.store.listSegments((req.params as { interviewId: string }).interviewId),
  }));

  server.get('/interviews/:interviewId/coverage', async (req) => app.flow.coverage((req.params as { interviewId: string }).interviewId));

  server.get('/interviews/:interviewId/off-topic', async (req) =>
    app.flow.offTopicHint((req.params as { interviewId: string }).interviewId),
  );

  server.get('/interviews/:interviewId/start-overdue', async (req) => ({
    overdue: app.flow.startPromptOverdue((req.params as { interviewId: string }).interviewId),
  }));

  server.post('/interviews/:interviewId/finish', async (req) =>
    app.flow.finish(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );
  server.post('/interviews/:interviewId/restart', async (req) =>
    app.flow.restart(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );
  server.post('/interviews/:interviewId/expire', async (req) =>
    app.flow.markExpired(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );

  // ---- 面评草稿与结构化评分卡 ----
  server.post('/interviews/:interviewId/draft', async (req, reply) => {
    const b = parse(draftActorSchema, req.body);
    const actor = actorOf(req);
    if (b.interviewerId && app.store.findUser(b.interviewerId)?.orgId !== req.auth!.org.id) {
      throw new DomainError('interviewer_not_found', '面试官不属于当前工作区');
    }
    const interviewerId = b.interviewerId ?? (actor.kind === 'human' ? actor.userId : '');
    const result = await app.evaluation.generateDraft(actor, (req.params as { interviewId: string }).interviewId, interviewerId);
    reply.status(201).send(result);
  });

  server.get('/drafts/:draftId', async (req) => {
    const draftId = (req.params as { draftId: string }).draftId;
    const draft = app.store.findDraft(draftId);
    if (!draft) throw new DomainError('draft_not_found', '草稿不存在');
    const segments = app.store.listSegments(draft.interviewId);
    const byId = new Map(segments.map((s) => [s.id, s]));
    return {
      draft,
      requirements: app.evaluation.requirementsForSubmit(draftId),
      stale: app.evaluation.isStale(draftId),
      pastHardDeadline: app.evaluation.pastHardDeadline(draftId),
      lowConfidenceSegments: app.evaluation.lowConfidenceSegments(draft.interviewId),
      /** Side-by-side rendering data: every cited id carries the stored verbatim text. */
      transcript: segments.map((s) => ({
        segmentId: s.id,
        startMs: s.startMs,
        speaker: s.speaker,
        text: s.text,
        confidence: s.confidence,
      })),
      evidence: draft.checks.map((c) => ({
        checkId: c.id,
        dimensionName: c.dimensionName,
        refs: c.finalEvidence.length > 0 ? c.finalEvidence : c.aiEvidence,
        resolvedText: (c.finalEvidence.length > 0 ? c.finalEvidence : c.aiEvidence).map((r) => ({
          segmentId: r.segmentId,
          text: byId.get(r.segmentId)?.text ?? null,
        })),
      })),
    };
  });

  server.get('/interviews/:interviewId/drafts', async (req) => {
    const interviewId = (req.params as { interviewId: string }).interviewId;
    const drafts = app.store.listDraftsByInterview(interviewId);
    return {
      drafts,
      note: drafts.length > 1 ? '同一候选人多位面试官各自独立草稿：并列对比，勿以单一面试官一票否决' : null,
    };
  });

  server.patch('/drafts/:draftId/checks/:checkId', async (req) => {
    const b = parse(checkPatchSchema, req.body);
    const p = req.params as { draftId: string; checkId: string };
    return app.evaluation.reviseCheck(actorOf(req), p.draftId, p.checkId, b);
  });

  server.post('/drafts/:draftId/recommendation', async (req) => {
    const b = parse(recommendationSchema, req.body);
    return app.evaluation.setRecommendation(actorOf(req), (req.params as { draftId: string }).draftId, b.recommendation);
  });

  server.get('/drafts/:draftId/requirements', async (req) =>
    app.evaluation.requirementsForSubmit((req.params as { draftId: string }).draftId),
  );

  server.post('/drafts/:draftId/submit', async (req) => {
    const b = parse(submitSchema, req.body);
    return app.evaluation.submit(actorOf(req), (req.params as { draftId: string }).draftId, b);
  });

  // ---- 催办与逾期升级 ----
  server.post('/interviews/:interviewId/reminders/queue', async (req) =>
    app.reminders.queueForInterview(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );

  /** Drive the ladder explicitly; a deployment runs this on an interval or via cron. */
  server.post('/reminders/tick', async () => ({ fired: app.reminders.tick() }));

  server.get('/interviews/:interviewId/reminders', async (req) => ({
    events: app.store.listReminders((req.params as { interviewId: string }).interviewId),
    suggestedActions: app.reminders.suggestedActions((req.params as { interviewId: string }).interviewId),
  }));

  server.post('/reminders/:reminderId/acknowledge', async (req) =>
    app.reminders.acknowledge(actorOf(req), (req.params as { reminderId: string }).reminderId),
  );

  server.post('/interviews/:interviewId/reminders/suspend', async (req) => {
    const b = parse(reasonSchema, req.body);
    return app.reminders.suspend(actorOf(req), (req.params as { interviewId: string }).interviewId, b.reason);
  });
  server.post('/interviews/:interviewId/reminders/resume', async (req) =>
    app.reminders.resume(actorOf(req), (req.params as { interviewId: string }).interviewId),
  );
  server.post('/interviews/:interviewId/reminders/disable', async (req) => {
    const b = parse(reasonSchema, req.body);
    return app.reminders.disable(actorOf(req), (req.params as { interviewId: string }).interviewId, b.reason);
  });
  server.post('/users/:userId/cadence', async (req) => {
    const b = parse(cadenceSchema, req.body);
    app.reminders.delayCadence(actorOf(req), (req.params as { userId: string }).userId, b.extraHours);
    return { ok: true, cadenceDelayHours: app.reminders.cadenceDelayHours };
  });

  server.get('/interviews/:interviewId/on-time-rate', async (req) => {
    const interview = app.store.findInterview((req.params as { interviewId: string }).interviewId);
    if (!interview) throw new DomainError('interview_not_found', '面试不存在');
    return app.reminders.onTimeRateFor(interview);
  });

  // ---- 看板与漏斗 ----
  server.get('/orgs/:orgId/board/overview', async (req) => app.board.overview((req.params as { orgId: string }).orgId));
  server.get('/orgs/:orgId/board/rows', async (req) => app.board.rows((req.params as { orgId: string }).orgId));
  server.get('/orgs/:orgId/board/funnel', async (req) => app.board.funnel((req.params as { orgId: string }).orgId));
  server.get('/orgs/:orgId/board/weekly-report', async (req) => ({
    report: app.board.weeklyReport((req.params as { orgId: string }).orgId),
  }));

  /** 岗位标准下的候选人结果矩阵，按 jobId 查询。 */
  server.get('/orgs/:orgId/candidates/results', async (req) => {
    const jobId = String((req.query as { jobId?: string }).jobId ?? '').trim();
    if (!jobId) throw new DomainError('job_required', '先选一个岗位，才能看这个岗位下的候选人结果');
    return app.board.candidateResults((req.params as { orgId: string }).orgId, jobId);
  });

  // ---- 合规底座 ----
  server.get('/compliance/notice', async () => app.compliance.notice());

  server.post('/compliance/scan', async (req) => {
    const b = parse(z.object({ subject: str(), input: z.record(z.unknown()) }), req.body);
    const hits = scanForProtectedAttributes(b.input);
    return { subject: b.subject, ok: hits.length === 0, hits };
  });

  server.post('/compliance/retention/sweep', async (req) => {
    const orgId = req.auth!.org.id;
    const report = app.compliance.sweep(orgId);
    const filesPurged = audio.purgeOlderThan(app.ctx.clock.now().getTime() - app.ctx.retention.audioDays * DAY_MS);
    return { ...report, audioFilesPurged: filesPurged };
  });

  server.post('/interviews/:interviewId/appeal', async (req) => {
    const b = parse(reasonSchema, req.body);
    return app.compliance.requestHumanReview(actorOf(req), (req.params as { interviewId: string }).interviewId, b.reason);
  });

  server.get('/orgs/:orgId/audit', async (req) => {
    const query = req.query as { limit?: string };
    return app.store.listAuditByOrg((req.params as { orgId: string }).orgId, Math.min(500, Number(query.limit ?? 200) || 200));
  });

  /**
   * Deterministic time, only when MIANYAN_FIXED_CLOCK_START is set. It exists so the 0/24/48/72h
   * ladder and the six-month purge can be verified over HTTP instead of asserted in a unit test.
   */
  server.get('/dev/clock', async () => {
    if (!clock) throw new DomainError('dev_clock_disabled', '这套环境的时间由系统时钟驱动，页面里的时间推进已关闭');
    return { now: clock.now().toISOString() };
  });

  server.post('/dev/clock/advance', async (req) => {
    if (!clock) throw new DomainError('dev_clock_disabled', '这套环境的时间由系统时钟驱动，页面里的时间推进已关闭');
    const b = parse(
      z.object({ hours: z.coerce.number().min(0).max(2400).optional(), days: z.coerce.number().min(0).max(400).optional() }),
      req.body,
    );
    if (b.days) clock.advanceMs(b.days * DAY_MS);
    else clock.advanceHours(b.hours ?? 0);
    return { now: clock.now().toISOString() };
  });

  // ---- 通知（当前只做站内消息；外部渠道用同一个接口的适配器接进来） ----
  server.get('/users/:userId/notifications', async (req) => {
    const userId = (req.params as { userId: string }).userId;
    if (userId !== req.auth!.user.id && req.auth!.user.role !== 'hr') {
      throw new DomainError('forbidden', '只能查看自己的消息');
    }
    const notifier = app.ctx.notifier as { forUser?: (id: string) => unknown[] };
    if (typeof notifier.forUser !== 'function') {
      throw new DomainError('notifications_unsupported', '这个提醒渠道只能往外发，暂时不能在页面里查看');
    }
    return { notifications: notifier.forUser(userId) };
  });
}
