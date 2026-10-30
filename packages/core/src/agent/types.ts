import type { EvidenceRef } from '../types.js';

export type AgentPhase = 'standard' | 'prep' | 'evaluation';

export type AgentRunStatus = 'running' | 'awaiting_human' | 'completed' | 'stopped' | 'failed';

export type AgentStepKind = 'plan' | 'read' | 'search' | 'draft' | 'verify' | 'ask' | 'remember' | 'answer' | 'stop';

/** One observable move of the agent. The UI renders these; the loop reads them back as its own memory. */
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
  /** Dimensions with no score that a human must still decide about. */
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
  /** The interviewer whose draft an evaluation run is assembling. */
  interviewerId: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export type LedgerStatus = 'covered' | 'missing' | 'unscored' | 'contradicted';

/**
 * The agent's long-term memory: one row per candidate + job + dimension, updated when a
 * review is submitted. Next round reads this instead of re-parsing old drafts.
 */
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
  /** Why a dimension stayed open; null when it is covered. */
  reason: string | null;
  evidence: EvidenceRef[];
  /** false when a human chose to leave the gap in this round only. */
  carryOver: boolean;
  source: 'submitted' | 'agent';
  updatedAt: string;
}
