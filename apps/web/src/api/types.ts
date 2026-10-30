/**
 * Hand-declared mirrors of the server's response shapes.
 *
 * The browser must not import @mianyan/core: that package is written for Node and pulls
 * node:sqlite and node:crypto, which a bundler cannot resolve. The HTTP contract in
 * apps/server/src/routes.ts is the single source of truth; these types describe it.
 */

export type Role = 'hr' | 'interviewer' | 'hiring_manager' | 'candidate';

export interface Org {
  id: string;
  name: string;
  atsType: string | null;
  complianceTemplateId: string;
  status: 'active' | 'suspended';
}

export interface User {
  id: string;
  orgId: string;
  role: Role;
  name: string;
  email?: string;
}

/** What the server returns after login, registration and password change. */
export interface SessionSnapshot {
  user: User;
  org: Org;
  members: User[];
}

export interface JobIntake {
  jobTitle: string;
  level: string;
  reportsTo: string;
  teamSize: number;
  painPoints: string;
  description: string;
}

export interface Job {
  id: string;
  orgId: string;
  title: string;
  level?: string;
  reportsTo?: string;
  teamSize?: number;
  description: string;
  status: 'draft' | 'open' | 'closed';
  confirmedStandardId: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface ResumeParsed {
  rawText: string;
  summary: string | null;
  companies: string[];
  titles: string[];
  yearsOfExperience: number | null;
  education: string[];
  parseFailed: boolean;
}

export type CandidateStatus = 'new' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected';

export interface Candidate {
  id: string;
  orgId: string;
  name: string;
  email?: string;
  appliedJobId: string;
  status: CandidateStatus;
  resume: ResumeParsed;
  deletedAt: string | null;
  createdAt: string;
}

export type InterviewStatus = 'scheduled' | 'in_progress' | 'audio_done' | 'eval_pending' | 'expired' | 'eval_submitted';

export interface Interview {
  id: string;
  orgId: string;
  jobId: string;
  candidateId: string;
  standardId: string;
  interviewerIds: string[];
  channel: 'video' | 'phone' | 'onsite';
  round: number;
  scheduledAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: InterviewStatus;
  consentId: string | null;
  aiRecordingActive: boolean;
  pausedAt: string | null;
}

export interface StandardDimension {
  id: string;
  standardId: string;
  name: string;
  positiveEvidence: string[];
  redFlags: string[];
  probes: string[];
  matchKeywords: string[];
  createdBy: string;
  confirmedBy: string | null;
}

export interface InterviewAnswer {
  question: string;
  answer: string;
  by: string;
}

export interface JobStandard {
  id: string;
  jobId: string;
  orgId: string;
  version: string;
  status: 'draft' | 'confirmed' | 'archived';
  dimensions: StandardDimension[];
  createdBy: string;
  confirmedByHiringManager: string | null;
  confirmedByHr: string | null;
  createdAt: string;
  updatedAt: string;
  intake: JobIntake | null;
  answers: InterviewAnswer[];
  revisionCounts: Record<string, number>;
  conflicts: StandardConflict[];
}

export interface StandardConflict {
  dimensionId: string;
  note: string;
  resolved: 'keep_standard' | 'keep_job_description' | null;
}

export interface ProposeResult {
  standard: JobStandard;
  escalationHints: string[];
  conflicts: StandardConflict[];
}

export type AlignmentMark = 'matched' | 'needs_probe' | 'weak';

export interface PrepPackRow {
  dimensionId: string;
  dimensionName: string;
  mark: AlignmentMark;
  rationale: string;
}

export interface PrepPackQuestion {
  id: string;
  text: string;
  dimensionId: string | null;
  why: string;
  source: 'standard' | 'interviewer' | 'ai';
  addedBy: string | null;
}

export interface PrepPackCarryOver {
  dimensionId: string;
  dimensionName: string;
  fromRound: number;
  reason: string;
}

export interface PrepPack {
  id: string;
  interviewId: string;
  candidateId: string;
  standardId: string;
  generatedAt: string;
  aiModel: string;
  crux: string[];
  alignment: PrepPackRow[];
  carryOver?: PrepPackCarryOver[];
  questions: PrepPackQuestion[];
  redFlagChecks: string[];
  degraded: boolean;
  degradedReason: string | null;
}

export interface ConsentPrompt {
  interviewId: string;
  noticeText: string;
  presentedAt: string;
  buttons: Array<{ decision: 'granted' | 'refused'; label: string }>;
}

export type ConsentDecision = 'granted' | 'refused';

export interface ConsentRecord {
  id: string;
  orgId: string;
  candidateId: string;
  interviewId: string;
  decision: ConsentDecision;
  noticeText: string;
  presentedAt: string;
  respondedAt: string;
  noticeKind: 'standalone_modal';
  retentionUntil: string;
}

export interface TranscriptSegment {
  id: string;
  interviewId: string;
  speaker: 'candidate' | 'interviewer' | 'unknown';
  /** Actor id when known, so panel interviews keep per-interviewer attribution. */
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  correctedBy: string | null;
}

export type TranscriptSource = 'dingtalk' | 'feishu' | 'tencent' | 'other';

export interface DetectedSpeaker {
  label: string;
  guess: 'candidate' | 'interviewer' | 'unknown';
  segments: number;
  chars: number;
  sample: string;
}

export interface TranscriptImportPreview {
  segments: number;
  durationMs: number;
  speakers: DetectedSpeaker[];
}

export interface Coverage {
  covered: string[];
  uncovered: string[];
  lowConfidenceSegments: string[];
}

export type ScoreLevel = 'high' | 'medium' | 'low';

/** A pointer into real transcript text; the server backfills `quote` from the database. */
export interface EvidenceRef {
  segmentId: string;
  startMs: number;
  quote: string;
}

export type DimensionCheckStatus = 'auto_filled' | 'human_revised' | 'resubmitted';

export interface StandardDimensionCheck {
  id: string;
  interviewId: string;
  dimensionId: string;
  dimensionName: string;
  aiScore: ScoreLevel | null;
  aiSummary: string | null;
  aiEvidence: EvidenceRef[];
  aiRedFlagHits: string[];
  needsHumanInput: boolean;
  finalScore: ScoreLevel | null;
  finalSummary: string | null;
  finalEvidence: EvidenceRef[];
  revisedBy: string[];
  status: DimensionCheckStatus;
}

export interface EvidenceBacked {
  text: string;
  evidence: EvidenceRef[];
}

export interface RejectedClaim {
  dimensionId: string | null;
  claim: string;
  reason: 'no_evidence' | 'quote_not_in_transcript' | 'unknown_segment';
}

export type DraftStatus = 'ai_draft' | 'human_revising' | 'submitted' | 'archived';

export type GapDisposition = 'carry_over' | 'not_carry';

export interface FeedbackDraft {
  id: string;
  interviewId: string;
  orgId: string;
  interviewerId: string;
  aiVersion: string | null;
  latestHumanVersion: string | null;
  submittedVersion: string | null;
  status: DraftStatus;
  checks: StandardDimensionCheck[];
  highlights: EvidenceBacked[];
  redFlags: EvidenceBacked[];
  overallMatch: { percent: number; reading: string } | null;
  humanRecommendation: string | null;
  rejectedClaims: RejectedClaim[];
  acknowledgedGaps: string[];
  gapDimensionIds?: string[];
  gapDisposition?: GapDisposition | null;
  agentRunId?: string | null;
  createdById: string | null;
  submittedById: string | null;
  createdAt: string;
  submittedAt: string | null;
}

export type AgentPhase = 'standard' | 'prep' | 'evaluation';
export type AgentRunStatus = 'running' | 'awaiting_human' | 'completed' | 'stopped' | 'failed';
export type AgentStepKind = 'plan' | 'read' | 'search' | 'draft' | 'verify' | 'ask' | 'remember' | 'answer' | 'stop';

/** One visible move of the agent: what it did, whether it worked, and why. */
export interface AgentStep {
  index: number;
  at: string;
  kind: AgentStepKind;
  label: string;
  detail: string | null;
  ok: boolean;
  tool: string | null;
  data: Record<string, unknown> | null;
}

export interface AgentQuestionOption {
  value: string;
  label: string;
  description: string | null;
}

export interface AgentQuestion {
  id: string;
  question: string;
  detail: string | null;
  freeText: boolean;
  options: AgentQuestionOption[];
  askedAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  answer: string | null;
}

export interface AgentSubject {
  jobId: string | null;
  candidateId: string | null;
  interviewId: string | null;
  standardId: string | null;
}

export interface AgentResult {
  summary: string;
  standardId?: string;
  prepPackId?: string;
  draftId?: string;
  gapDimensionIds?: string[];
  carryOverDimensionNames?: string[];
}

export interface AgentRun {
  id: string;
  orgId: string;
  phase: AgentPhase;
  goal: string;
  subject: AgentSubject;
  status: AgentRunStatus;
  steps: AgentStep[];
  budget: { maxSteps: number };
  question: AgentQuestion | null;
  result: AgentResult | null;
  stopReason: string | null;
  llm: { driver: string; model: string };
  interviewerId: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface AgentBundle {
  run: AgentRun;
  standard?: JobStandard;
  pack?: PrepPack;
  draft?: FeedbackDraft;
}

export type LedgerStatus = 'covered' | 'missing' | 'unscored' | 'contradicted';

/** The candidate's evidence memory, one row per dimension, rebuilt from submitted reviews. */
export interface EvidenceLedgerEntry {
  id: string;
  orgId: string;
  candidateId: string;
  jobId: string;
  dimensionId: string;
  dimensionName: string;
  status: LedgerStatus;
  fromRound: number;
  interviewId: string;
  draftId: string;
  reason: string | null;
  evidence: EvidenceRef[];
  carryOver: boolean;
  source: 'submitted' | 'agent';
  updatedAt: string;
}

export interface SubmitRequirement {
  ok: boolean;
  missing: string[];
}

export interface DraftDetail {
  draft: FeedbackDraft;
  requirements: SubmitRequirement;
  stale: boolean;
  pastHardDeadline: boolean;
  lowConfidenceSegments: string[];
  transcript: Array<{ segmentId: string; startMs: number; speaker: string; text: string; confidence: number }>;
  evidence: Array<{ checkId: string; dimensionName: string; refs: EvidenceRef[]; resolvedText: Array<{ segmentId: string; text: string | null }> }>;
}

export type ReminderLevel = 24;

export interface ReminderEvent {
  id: string;
  interviewId: string;
  orgId: string;
  level: ReminderLevel;
  dueAt: string;
  deliveredTo: string[];
  status: 'queued' | 'sent' | 'acknowledged';
  acknowledgedBy: string | null;
  suspended: boolean;
  suspendReason: string | null;
  sentAt: string | null;
  note: string | null;
}

export type BoardLight = 'idle' | 'waiting' | 'attention' | 'overdue' | 'done';

export interface BoardRow {
  interviewId: string;
  candidateId: string;
  candidateLabel: string;
  jobTitle: string;
  round: number;
  interviewStatus: InterviewStatus;
  light: BoardLight;
  waitingHours: number | null;
  interviewers: string[];
  submittedOnTime: boolean | null;
  latestDraftStatus: DraftStatus | null;
}

export interface BoardOverview {
  scheduled: number;
  inProgress: number;
  awaitingEval: number;
  evaluated: number;
  overdue: number;
  onTimeRate: { due: number; onTime: number; rate: number | null };
  usable: { due: number; usable: number; rate: number | null };
}

export interface FunnelStage {
  stage: 'new' | 'screening' | 'interview' | 'offer' | 'hired';
  count: number;
  avgDwellHours: number | null;
}

export interface CandidateResultCell {
  dimensionId: string;
  dimensionName: string;
  level: ScoreLevel | null;
  evidenceCount: number;
  evidence: Array<{ quote: string; startMs: number }>;
  redFlagHits: string[];
  summary: string | null;
  round: number;
  interviewId: string;
  interviewerName: string;
  submittedAt: string | null;
}

export interface CandidateResultRow {
  candidateId: string;
  name: string;
  status: CandidateStatus;
  rounds: number;
  submittedRounds: number;
  scored: number;
  gaps: number;
  cells: CandidateResultCell[];
  recommendation: string | null;
  lastSubmittedAt: string | null;
  upcomingAt: string | null;
}

export interface CandidateResults {
  jobId: string;
  jobTitle: string;
  standard: { id: string; version: string; dimensions: Array<{ id: string; name: string }> } | null;
  candidates: CandidateResultRow[];
}

export interface AppealTicket {
  id: string;
  interviewId: string;
  orgId: string;
  reason: string;
  raisedBy: string;
  at: string;
  promisedReplyWithinDays: number;
}

export interface AuditEntry {
  id: string;
  orgId: string;
  actorType: 'human' | 'ai' | 'system';
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface ComplianceNotice {
  consentText: string;
  appealChannel: { label: string; contact: string; responseDeadlineDays: number };
  aiLabel: { cardBadge: string; exportFooter: string };
  referenceOnly: string;
  retention: { audioDays: number; consentDays: number };
}

export interface AppNotification {
  id: string;
  orgId: string;
  interviewId: string | null;
  to: string[];
  channel: string;
  kind: 'prep_pack' | 'interview_starting' | 'draft_ready' | 'reminder' | 'escalation' | 'submitted';
  title: string;
  body: string;
  link: string;
  at: string;
}

export interface ProtectedHit {
  category: string;
  term: string;
  field: string;
  excerpt: string;
}

export interface RetentionReport {
  at: string;
  transcriptsPurged: number;
  audioPurged: number;
  consentLogsPurged: number;
  softDeletedCandidatesHardened: number;
  audioFilesPurged: number;
}
