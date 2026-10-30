import type { AlignmentMark, InterviewAnswer, JobIntake, ScoreLevel } from '../types.js';

export type { InterviewAnswer, JobIntake };

export interface LlmInfo {
  driver: string;
  model: string;
}

export interface DimensionDraft {
  name: string;
  positiveEvidence: string[];
  redFlags: string[];
  probes: string[];
  matchKeywords: string[];
}

export interface StandardExtractionRequest {
  intake: JobIntake;
  answers: InterviewAnswer[];
  /** When absent the provider proposes the next question instead of a draft. */
  requestDraft: boolean;
}

export interface StandardExtractionResult extends LlmInfo {
  nextQuestion: string | null;
  dimensions: DimensionDraft[];
  rationale: string;
  coverageNotes: string[];
}

export interface PrepPackRequest {
  candidateName: string;
  resumeText: string;
  parseFailed: boolean;
  round: number;
  intake: JobIntake;
  dimensions: Array<{ id: string; name: string; positiveEvidence: string[]; redFlags: string[]; probes: string[]; matchKeywords: string[] }>;
}

export interface PrepPackAlignment {
  dimensionId: string;
  mark: AlignmentMark;
  rationale: string;
}

export interface PrepPackQuestionDraft {
  text: string;
  dimensionId: string | null;
  why: string;
}

export interface PrepPackResult extends LlmInfo {
  crux: string[];
  alignment: PrepPackAlignment[];
  questions: PrepPackQuestionDraft[];
  redFlagChecks: string[];
}

export interface EvaluationRequest {
  interviewId: string;
  dimensions: Array<{ id: string; name: string; positiveEvidence: string[]; redFlags: string[]; matchKeywords: string[] }>;
  /** Real transcript segments; the provider must reference these ids, never retype the text. */
  segments: Array<{ id: string; startMs: number; speaker: string; text: string; confidence: number }>;
  interviewerNotes: string[];
}

export interface EvaluationDimensionDraft {
  dimensionId: string;
  score: ScoreLevel | null;
  summary: string;
  /** Transcript segment ids whose text supports the summary. */
  segmentIds: string[];
  redFlagHits: string[];
  needsHumanInput: boolean;
}

export interface EvaluationResult extends LlmInfo {
  dimensions: EvaluationDimensionDraft[];
  highlights: Array<{ text: string; segmentIds: string[] }>;
  redFlags: Array<{ text: string; segmentIds: string[] }>;
  /** Legacy fixture field; the product does not show a total score. */
  overall?: { percent: number; reading: string } | null;
}

/**
 * The model plans the investigation before any search happens: which dimension to look at
 * first and which angles to try. Code validates the plan against the real dimensions and
 * keywords; it may not invent a dimension or an empty query.
 */
export interface EvaluationPlanRequest {
  round: number;
  dimensions: Array<{
    id: string;
    name: string;
    positiveEvidence: string[];
    redFlags: string[];
    matchKeywords: string[];
    /** Set when a human carried this gap over from an earlier round. */
    priorGapReason: string | null;
  }>;
}

export interface EvaluationPlan {
  /** Dimension ids in investigation order; unknown ids are ignored by the caller. */
  order: string[];
  /** Dimension id (or name) -> 1-2 search phrases the model expects in the candidate's own words. */
  queries: Record<string, string[]>;
  rationale: string;
}

export interface LlmProvider extends LlmInfo {
  extractStandard(req: StandardExtractionRequest): Promise<StandardExtractionResult>;
  buildPrepPack(req: PrepPackRequest): Promise<PrepPackResult>;
  draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult>;
  /** Optional: when missing or failing, the agent falls back to the standard keyword plan. */
  planEvaluation?(req: EvaluationPlanRequest): Promise<EvaluationPlan>;
}
