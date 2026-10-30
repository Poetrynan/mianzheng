import { DomainError } from './errors.js';
import type { CandidateStatus, DimensionCheckStatus, DraftStatus, InterviewStatus, ReminderStatus, StandardStatus } from './types.js';

export const INTERVIEW_TRANSITIONS: Record<InterviewStatus, InterviewStatus[]> = {
  scheduled: ['in_progress'],
  in_progress: ['audio_done'],
  audio_done: ['eval_pending'],
  eval_pending: ['eval_submitted', 'expired'],
  /** Late submissions are still recorded; the board has already flagged the breach. */
  expired: ['eval_submitted', 'eval_pending'],
  eval_submitted: [],
};

export const CANDIDATE_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  new: ['screening', 'rejected'],
  screening: ['interview', 'rejected'],
  interview: ['offer', 'rejected'],
  offer: ['hired', 'rejected', 'interview'],
  hired: [],
  rejected: ['interview'],
};

export const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  ai_draft: ['human_revising', 'submitted', 'archived'],
  human_revising: ['submitted', 'archived'],
  submitted: ['archived'],
  archived: [],
};

export const CHECK_TRANSITIONS: Record<DimensionCheckStatus, DimensionCheckStatus[]> = {
  auto_filled: ['human_revised'],
  human_revised: ['resubmitted'],
  resubmitted: ['human_revised'],
};

export const REMINDER_TRANSITIONS: Record<ReminderStatus, ReminderStatus[]> = {
  queued: ['sent'],
  sent: ['acknowledged'],
  acknowledged: [],
};

export const STANDARD_TRANSITIONS: Record<StandardStatus, StandardStatus[]> = {
  draft: ['confirmed', 'archived'],
  confirmed: ['archived'],
  archived: [],
};

export function assertTransition<K extends string>(
  table: Record<K, K[]>,
  from: K,
  to: K,
  entity: string,
): void {
  if (from === to) return;
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError(
      'illegal_state_transition',
      `${entity} 不能从 ${from} 直接变为 ${to}`,
      { entity, from, to, allowed },
    );
  }
}

/**
 * `expired` is never automatic: only HR may restart a lapsed interview (PRD 5.2).
 */
export function assertMayMoveToInterview(from: InterviewStatus, to: InterviewStatus, actorType: 'human' | 'ai' | 'system', actorRole?: string): void {
  assertTransition(INTERVIEW_TRANSITIONS, from, to, 'Interview');
  const restart = from === 'expired' && (to === 'eval_pending' || to === 'eval_submitted');
  if (restart && (actorType !== 'human' || actorRole !== 'hr')) {
    throw new DomainError('restart_requires_hr', '超期未评的面试只能由 HR 决定重启，系统不会自动重置', {
      from,
      to,
      actorType,
      actorRole: actorRole ?? null,
    });
  }
}
