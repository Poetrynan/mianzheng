import type { Clock } from './clock.js';

export type Role = 'hr' | 'interviewer' | 'hiring_manager';

export type ActorType = 'human' | 'ai' | 'system';

export interface User {
  id: string;
  orgId: string;
  role: Role;
  name: string;
  email?: string;
}

export interface Org {
  id: string;
  name: string;
  /** PRD 5.1 — ATS type is a v1.1 field; kept nullable so v1.0 never depends on an ATS. */
  atsType: string | null;
  complianceTemplateId: string;
  status: 'active' | 'suspended';
}

export type JobStatus = 'draft' | 'open' | 'closed';

export interface Job {
  id: string;
  orgId: string;
  title: string;
  level?: string;
  reportsTo?: string;
  teamSize?: number;
  description: string;
  status: JobStatus;
  /** Points at the JobStandard version used for interviews; null until produces a confirmed one. */
  confirmedStandardId: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface JobIntake {
  jobTitle: string;
  level: string;
  reportsTo: string;
  teamSize: number;
  painPoints: string;
  description: string;
}

export interface InterviewAnswer {
  question: string;
  answer: string;
  by: string;
}

export type StandardStatus = 'draft' | 'confirmed' | 'archived';

export interface StandardDimension {
  id: string;
  standardId: string;
  name: string;
  /** "你应该看到 ___" */
  positiveEvidence: string[];
  /** "应该警惕 ___" */
  redFlags: string[];
  /** Calibration follow-up questions owned by this dimension. */
  probes: string[];
  /** Keywords used by the alignment matcher to link resume/transcript text to this dimension. */
  matchKeywords: string[];
  createdBy: string;
  confirmedBy: string | null;
}

export interface JobStandard {
  id: string;
  jobId: string;
  orgId: string;
  /** Semantic-ish version string: "v0.1", "v0.2", "v1.0". */
  version: string;
  status: StandardStatus;
  dimensions: StandardDimension[];
  createdBy: string;
  /** Both signatures are required before a standard can drive prep packs or evaluations (PRD 3.1). */
  confirmedByHiringManager: string | null;
  confirmedByHr: string | null;
  createdAt: string;
  updatedAt: string;
  /** intake form (5 minutes) filled by HR before the AI interviewer starts. */
  intake: JobIntake | null;
  /** Every Q/A round collected from the hiring manager. */
  answers: InterviewAnswer[];
  /** dimensionId -> revision count; three revisions triggers the expert-escalation hint. */
  revisionCounts: Record<string, number>;
  /** Keyword collisions against the job description that HR must resolve before confirming. */
  conflicts: StandardConflict[];
}

export interface StandardConflict {
  dimensionId: string;
  note: string;
  resolved: 'keep_standard' | 'keep_job_description' | null;
}

export type CandidateStatus = 'new' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected';

export interface ResumeParsed {
  rawText: string;
  summary: string | null;
  companies: string[];
  titles: string[];
  yearsOfExperience: number | null;
  education: string[];
  parseFailed: boolean;
}

export interface Candidate {
  id: string;
  orgId: string;
  name: string;
  email?: string;
  appliedJobId: string;
  status: CandidateStatus;
  resume: ResumeParsed;
  /** Soft delete only; PRD 5.2 forbids hard deletion inside the look-back window. */
  deletedAt: string | null;
  createdAt: string;
}

export type InterviewStatus = 'scheduled' | 'in_progress' | 'audio_done' | 'eval_pending' | 'eval_submitted' | 'expired';

export type InterviewChannel = 'video' | 'phone' | 'onsite';

export interface Interview {
  id: string;
  orgId: string;
  jobId: string;
  candidateId: string;
  standardId: string;
  interviewerIds: string[];
  channel: InterviewChannel;
  round: number;
  scheduledAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: InterviewStatus;
  /** Set when the candidate answered the standalone consent modal. */
  consentId: string | null;
  /** true while AI transcription is live; false in manual-notes fallback. */
  aiRecordingActive: boolean;
  pausedAt: string | null;
  /** Push dedupe stamps for the 赛前 24h / 赛前 5 分钟 reminders (PRD 3.2). */
  prepPush24hSentAt: string | null;
  prepPushLastMinuteSentAt: string | null;
}

export type SpeakerKind = 'candidate' | 'interviewer' | 'unknown';

export interface TranscriptSegment {
  id: string;
  interviewId: string;
  speaker: SpeakerKind;
  /** Actor id when known, so panel interviews keep per-interviewer attribution (PRD 3.3). */
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  correctedBy: string | null;
}

/** A pointer into real transcript text. Every AI claim must carry one of these (PRD 9 risk #1). */
export interface EvidenceRef {
  segmentId: string;
  startMs: number;
  quote: string;
}

export type ScoreLevel = 'high' | 'medium' | 'low';

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

export type DraftStatus = 'ai_draft' | 'human_revising' | 'submitted' | 'archived';

export interface FeedbackDraft {
  id: string;
  interviewId: string;
  orgId: string;
  /** Panel interviews keep one draft per interviewer; HR sees the side-by-side roll-up (PRD 3.4). */
  interviewerId: string;
  aiVersion: string | null;
  latestHumanVersion: string | null;
  submittedVersion: string | null;
  status: DraftStatus;
  checks: StandardDimensionCheck[];
  highlights: EvidenceBacked[];
  redFlags: EvidenceBacked[];
  overallMatch: { percent: number; reading: string } | null;
  /** Only place where free-form subjective judgement is encouraged (PRD 3.4). */
  humanRecommendation: string | null;
  /** Unsupported AI claims stripped by the evidence verifier; kept for audit. */
  rejectedClaims: RejectedClaim[];
  /** Gaps the interviewer ticked through on the final confirm page. */
  acknowledgedGaps: string[];
  /** Dimensions the drafting agent could not back with evidence; carried to the next round. */
  gapDimensionIds?: string[];
  /** Set when a human decided what to do with the gaps at the end of the agent run. */
  gapDisposition?: 'carry_over' | 'not_carry' | null;
  /** The agent run that assembled this draft, when it was not the one-shot generator. */
  agentRunId?: string | null;
  createdById: string | null;
  submittedById: string | null;
  createdAt: string;
  submittedAt: string | null;
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

/** One nudge, 24 hours after the interview. The pilot deliberately has no ladder. */
export type ReminderLevel = 24;

export type ReminderStatus = 'queued' | 'sent' | 'acknowledged';

export interface ReminderEvent {
  id: string;
  interviewId: string;
  orgId: string;
  level: ReminderLevel;
  dueAt: string;
  deliveredTo: string[];
  status: ReminderStatus;
  acknowledgedBy: string | null;
  /** HR-initiated hold (travel / leave) — timer pauses, not resets (PRD 3.5). */
  suspended: boolean;
  suspendReason: string | null;
  sentAt: string | null;
  /** Objective lateness data shown on the board. */
  note: string | null;
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
  /** PIPL notice must stand on its own, not be buried in a general privacy policy. */
  noticeKind: 'standalone_modal';
  retentionUntil: string;
}

export interface AuditEntry {
  id: string;
  orgId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface PrepPackQuestion {
  id: string;
  text: string;
  dimensionId: string | null;
  why: string;
  source: 'standard' | 'interviewer' | 'ai';
  addedBy: string | null;
}

export type AlignmentMark = 'matched' | 'needs_probe' | 'weak';

export interface PrepPackRow {
  dimensionId: string;
  dimensionName: string;
  mark: AlignmentMark;
  rationale: string;
}

/** A dimension an earlier round could not back with a quote; this round asks about it first. */
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
  questions: PrepPackQuestion[];
  redFlagChecks: string[];
  /** Absent on packs generated before cross-round carry-over existed. */
  carryOver?: PrepPackCarryOver[];
  /** Set when resume parsing failed: half-automatic mode, HR fills the gaps (PRD 3.2). */
  degraded: boolean;
  degradedReason: string | null;
}

export interface InterviewSessionState {
  interviewId: string;
  coveredDimensionIds: string[];
  uncoveredDimensionIds: string[];
  offTopicSinceMs: number | null;
}

export interface StoreContext {
  clock: Clock;
}
