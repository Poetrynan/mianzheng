import type {
  AgentBundle,
  AgentRun,
  AppNotification,
  AppealTicket,
  AuditEntry,
  BoardOverview,
  BoardRow,
  Candidate,
  CandidateResults,
  ComplianceNotice,
  ConsentDecision,
  ConsentPrompt,
  ConsentRecord,
  Coverage,
  DraftDetail,
  EvidenceLedgerEntry,
  FeedbackDraft,
  FunnelStage,
  Interview,
  Job,
  JobIntake,
  JobStandard,
  Org,
  PrepPack,
  PrepPackQuestion,
  ProposeResult,
  RejectedClaim,
  ReminderEvent,
  RetentionReport,
  Role,
  ScoreLevel,
  SessionSnapshot,
  TranscriptImportPreview,
  TranscriptSegment,
  TranscriptSource,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api';

interface CallOptions {
  body?: unknown;
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const rec = (json ?? {}) as Record<string, unknown>;
    const code = typeof rec.code === 'string' ? rec.code : 'http_error';
    const message = typeof rec.message === 'string' ? rec.message : text.slice(0, 160) || res.statusText;
    /** An expired session anywhere should drop the whole app back to the login screen. */
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('mianzheng:unauthorized'));
    }
    throw new ApiError(res.status, code, message, rec.details ?? null);
  }
  return json as T;
}

const q = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/**
 * One function per documented endpoint. Identity lives in an HttpOnly session cookie; no
 * request carries a user id, so a stale tab cannot act as a different person.
 */
export const api = {
  auth: {
    me: () => request<SessionSnapshot>('GET', '/auth/me'),
    login: (email: string, password: string) =>
      request<SessionSnapshot>('POST', '/auth/login', { body: { email, password } }),
    register: (input: { orgName: string; name: string; email: string; password: string }) =>
      request<SessionSnapshot>('POST', '/auth/register', { body: input }),
    logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
    addMember: (orgId: string, input: { role: Role; name: string; email: string; password: string }) =>
      request<User>('POST', `/orgs/${orgId}/users`, { body: input }),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<SessionSnapshot>('POST', '/auth/password', { body: { currentPassword, newPassword } }),
  },

  health: () =>
    request<{ ok: boolean; llmDriver: string; asrProvider: string; retention: { audioDays: number; consentDays: number } }>(
      'GET',
      '/health',
    ),

  listUsers: (orgId: string) => request<User[]>('GET', `/orgs/${orgId}/users`),

  createJob: (intake: JobIntake) => request<Job>('POST', '/jobs', { body: intake }),
  listJobs: (orgId: string) => request<Job[]>('GET', `/orgs/${orgId}/jobs`),

  addCandidate: (jobId: string, name: string, resumeText: string) =>
    request<Candidate>('POST', '/candidates', { body: { jobId, name, resumeText } }),
  listCandidates: (orgId: string) => request<Candidate[]>('GET', `/orgs/${orgId}/candidates`),
  deleteCandidate: (candidateId: string, reason: string) =>
    request<Candidate>('DELETE', `/candidates/${candidateId}`, { body: { reason } }),

  /** ---- 金标准 ---- */
  startStandard: (jobId: string, intake: JobIntake) => request<JobStandard>('POST', `/jobs/${jobId}/standard`, { body: intake }),
  listStandards: (jobId: string) => request<JobStandard[]>('GET', `/jobs/${jobId}/standards`),
  getStandard: (standardId: string) => request<JobStandard>('GET', `/standards/${standardId}`),
  nextQuestion: (standardId: string) => request<{ question: string | null }>('GET', `/standards/${standardId}/next-question`),
  recordAnswer: (standardId: string, question: string, answer: string) =>
    request<JobStandard>('POST', `/standards/${standardId}/answers`, { body: { question, answer } }),
  propose: (standardId: string) => request<ProposeResult>('POST', `/standards/${standardId}/propose`),
  resolveConflict: (standardId: string, dimensionId: string, side: 'keep_standard' | 'keep_job_description') =>
    request<JobStandard>('POST', `/standards/${standardId}/conflicts/resolve`, { body: { dimensionId, side } }),
  reviseDimension: (
    standardId: string,
    dimensionId: string,
    patch: Partial<Pick<JobStandard['dimensions'][number], 'name' | 'positiveEvidence' | 'redFlags' | 'probes' | 'matchKeywords'>> & {
      overrideReason?: string;
    },
  ) => request<JobStandard>('PATCH', `/standards/${standardId}/dimensions/${dimensionId}`, { body: patch }),
  confirmDimension: (standardId: string, dimensionId: string) =>
    request<JobStandard>('POST', `/standards/${standardId}/dimensions/${dimensionId}/confirm`),
  sign: (standardId: string, party: 'hiring_manager' | 'hr') =>
    request<JobStandard>('POST', `/standards/${standardId}/sign`, { body: { party } }),
  finalize: (standardId: string) => request<JobStandard>('POST', `/standards/${standardId}/finalize`),

  /** ---- 准备包 ---- */
  submitResume: (candidateId: string, resumeText: string) =>
    request<Candidate>('POST', `/candidates/${candidateId}/resume`, { body: { resumeText } }),
  buildPrepPack: (interviewId: string) => request<PrepPack>('POST', `/interviews/${interviewId}/prep-pack`),
  getPrepPack: (interviewId: string) => request<PrepPack>('GET', `/interviews/${interviewId}/prep-pack`),
  addQuestion: (interviewId: string, text: string, dimensionId: string | null) =>
    request<PrepPackQuestion>('POST', `/interviews/${interviewId}/prep-pack/questions`, { body: { text, dimensionId } }),
  vetoQuestion: (interviewId: string, questionId: string, reason: string) =>
    request<PrepPack>('POST', `/interviews/${interviewId}/prep-pack/questions/${questionId}/veto`, { body: { reason } }),

  /** ---- 面试证据 Agent ---- */
  agent: {
    startStandard: (jobId: string, intake: JobIntake) =>
      request<AgentBundle>('POST', `/jobs/${jobId}/agent/standard`, { body: intake }),
    runsForJob: (jobId: string) => request<AgentRun[]>('GET', `/jobs/${jobId}/agent-runs`),
    prep: (interviewId: string) => request<AgentBundle>('POST', `/interviews/${interviewId}/agent/prep`),
    evaluate: (interviewId: string, interviewerId?: string) =>
      request<AgentBundle>('POST', `/interviews/${interviewId}/agent/evaluation`, {
        body: interviewerId ? { interviewerId } : {},
      }),
    runsForInterview: (interviewId: string) => request<AgentRun[]>('GET', `/interviews/${interviewId}/agent-runs`),
    run: (runId: string) => request<AgentBundle>('GET', `/agent/runs/${runId}`),
    answer: (runId: string, answer: string) =>
      request<AgentBundle>('POST', `/agent/runs/${runId}/answer`, { body: { answer } }),
  },
  ledger: (candidateId: string, jobId: string) =>
    request<{ entries: EvidenceLedgerEntry[] }>('GET', `/ledger?${q({ candidateId, jobId })}`),

  /** ---- 排期 / 同意 / 转写 ---- */
  schedule: (input: {
    jobId: string;
    candidateId: string;
    interviewerIds: string[];
    scheduledAt: string;
    channel: 'video' | 'phone' | 'onsite';
    round: number;
  }) => request<Interview>('POST', '/interviews', { body: input }),
  getInterview: (interviewId: string) => request<Interview>('GET', `/interviews/${interviewId}`),
  listInterviews: (orgId: string) => request<Interview[]>('GET', `/orgs/${orgId}/interviews`),
  presentConsent: (interviewId: string) => request<ConsentPrompt>('GET', `/interviews/${interviewId}/consent`),
  answerConsent: (interviewId: string, decision: ConsentDecision, presentedAt: string) =>
    request<ConsentRecord>('POST', `/interviews/${interviewId}/consent`, { body: { decision, presentedAt } }),
  start: (interviewId: string) => request<Interview>('POST', `/interviews/${interviewId}/start`),
  setPaused: (interviewId: string, paused: boolean) =>
    request<Interview>('POST', `/interviews/${interviewId}/pause`, { body: { paused } }),
  ingestTranscript: (interviewId: string, inlineTranscript: string) =>
    request<{ transcribed: number; saved: TranscriptSegment[]; skippedLowConfidence: string[] }>(
      'POST',
      `/interviews/${interviewId}/transcript`,
      { body: { inlineTranscript } },
    ),
  previewTranscriptImport: (interviewId: string, inlineTranscript: string) =>
    request<TranscriptImportPreview>('POST', `/interviews/${interviewId}/transcript/preview`, { body: { inlineTranscript } }),
  importTranscript: (
    interviewId: string,
    input: { inlineTranscript: string; source: TranscriptSource; speakerMap: Record<string, 'candidate' | 'interviewer' | 'unknown'> },
  ) =>
    request<{ transcribed: number; saved: TranscriptSegment[]; skippedLowConfidence: string[] }>(
      'POST',
      `/interviews/${interviewId}/transcript/import`,
      { body: input },
    ),
  appendSegments: (interviewId: string, segments: unknown[]) =>
    request<{ saved: TranscriptSegment[]; skippedLowConfidence: string[] }>('POST', `/interviews/${interviewId}/segments`, {
      body: { segments },
    }),
  uploadAudio: (
    interviewId: string,
    input: { base64: string; mime: string; filename?: string; speaker: 'candidate' | 'interviewer' | 'unknown'; offsetMs: number },
  ) =>
    request<{ audioId: string; bytes: number; transcribed: number; saved: TranscriptSegment[]; skippedLowConfidence: string[] }>(
      'POST',
      `/interviews/${interviewId}/audio`,
      { body: input },
    ),
  correctSegment: (segmentId: string, text: string) =>
    request<TranscriptSegment>('PATCH', `/segments/${segmentId}`, { body: { text } }),
  getTranscript: (interviewId: string) => request<{ segments: TranscriptSegment[] }>('GET', `/interviews/${interviewId}/transcript`),
  coverage: (interviewId: string) => request<Coverage>('GET', `/interviews/${interviewId}/coverage`),
  offTopic: (interviewId: string) =>
    request<{ hint: string | null; offTopicSinceMs: number | null }>('GET', `/interviews/${interviewId}/off-topic`),
  finish: (interviewId: string) => request<Interview>('POST', `/interviews/${interviewId}/finish`),
  expire: (interviewId: string) => request<Interview>('POST', `/interviews/${interviewId}/expire`),
  restart: (interviewId: string) => request<Interview>('POST', `/interviews/${interviewId}/restart`),

  /** ---- 面评 ---- */
  generateDraft: (interviewId: string, interviewerId?: string) =>
    request<{ draft: FeedbackDraft; rejectedClaims: RejectedClaim[] }>('POST', `/interviews/${interviewId}/draft`, {
      body: interviewerId ? { interviewerId } : {},
    }),
  listDrafts: (interviewId: string) =>
    request<{ drafts: FeedbackDraft[]; note: string | null }>('GET', `/interviews/${interviewId}/drafts`),
  draftDetail: (draftId: string) => request<DraftDetail>('GET', `/drafts/${draftId}`),
  reviseCheck: (
    draftId: string,
    checkId: string,
    patch: { finalScore?: ScoreLevel | null; finalSummary?: string; addEvidenceSegmentIds?: string[] },
  ) => request<FeedbackDraft>('PATCH', `/drafts/${draftId}/checks/${checkId}`, { body: patch }),
  setRecommendation: (draftId: string, recommendation: string) =>
    request<FeedbackDraft>('POST', `/drafts/${draftId}/recommendation`, { body: { recommendation } }),
  submitDraft: (draftId: string, confirm: { fillUnscored: boolean; agreeUsedForDecision: boolean; anonymizeName: boolean }) =>
    request<FeedbackDraft>('POST', `/drafts/${draftId}/submit`, { body: confirm }),

  /** ---- 催办 ---- */
  queueReminders: (interviewId: string) => request<ReminderEvent[]>('POST', `/interviews/${interviewId}/reminders/queue`),
  listReminders: (interviewId: string) =>
    request<{ events: ReminderEvent[]; suggestedActions: string[] }>('GET', `/interviews/${interviewId}/reminders`),
  tickReminders: () => request<{ fired: ReminderEvent[] }>('POST', '/reminders/tick'),
  suspendReminders: (interviewId: string, reason: string) =>
    request<ReminderEvent[]>('POST', `/interviews/${interviewId}/reminders/suspend`, { body: { reason } }),
  resumeReminders: (interviewId: string) => request<ReminderEvent[]>('POST', `/interviews/${interviewId}/reminders/resume`),
  setCadence: (interviewerId: string, extraHours: number) =>
    request<{ ok: boolean; cadenceDelayHours: Record<string, number> }>('POST', `/users/${interviewerId}/cadence`, {
      body: { extraHours },
    }),

  /** ---- 看板 ---- */
  overview: (orgId: string) => request<BoardOverview>('GET', `/orgs/${orgId}/board/overview`),
  rows: (orgId: string) => request<BoardRow[]>('GET', `/orgs/${orgId}/board/rows`),
  funnel: (orgId: string) => request<FunnelStage[]>('GET', `/orgs/${orgId}/board/funnel`),
  weeklyReport: (orgId: string) => request<{ report: string }>('GET', `/orgs/${orgId}/board/weekly-report`),
  candidateResults: (orgId: string, jobId: string) =>
    request<CandidateResults>('GET', `/orgs/${orgId}/candidates/results?${q({ jobId })}`),

  /** ---- 合规 ---- */
  notice: () => request<ComplianceNotice>('GET', '/compliance/notice'),
  scan: (subject: string, input: Record<string, unknown>) =>
    request<{ subject: string; ok: boolean; hits: unknown[] }>('POST', '/compliance/scan', { body: { subject, input } }),
  appeal: (interviewId: string, reason: string) =>
    request<AppealTicket>('POST', `/interviews/${interviewId}/appeal`, { body: { reason } }),
  audit: (orgId: string, limit = 200) => request<AuditEntry[]>('GET', `/orgs/${orgId}/audit?${q({ limit })}`),
  retentionSweep: () => request<RetentionReport>('POST', '/compliance/retention/sweep'),

  /** ---- 固定时钟（仅当服务端设置 MIANYAN_FIXED_CLOCK_START 时可用） ---- */
  clock: () => request<{ now: string }>('GET', '/dev/clock'),
  advanceClock: (hours?: number, days?: number) => request<{ now: string }>('POST', '/dev/clock/advance', { body: { hours, days } }),

  notifications: (userId: string) => request<{ notifications: AppNotification[] }>('GET', `/users/${userId}/notifications`),
};
