import { DAY_MS } from '../clock.js';
import type { Store } from '../db/store.js';

export interface RetentionPolicy {
  /** Audio + transcript lifetime (PRD 6.1). */
  audioDays: number;
  /** Consent decision log retention, minimum two years. */
  consentDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { audioDays: 180, consentDays: 730 };

export interface SweepReport {
  transcriptsPurged: number;
  audioPurged: number;
  consentLogsPurged: number;
  softDeletedCandidatesHardened: number;
  at: string;
}

/**
 * Time-based deletion only. Submitted evaluations are business records and stay; the
 * candidate's raw voice and transcript do not.
 */
export function runRetentionSweep(store: Store, now: Date, policy: RetentionPolicy = DEFAULT_RETENTION): SweepReport {
  const audioCutoff = now.getTime() - policy.audioDays * DAY_MS;
  const consentCutoff = now.getTime() - policy.consentDays * DAY_MS;

  const expiredInterviews = store.interviewsOlderThan(audioCutoff);
  let transcriptsPurged = 0;
  for (const interview of expiredInterviews) {
    transcriptsPurged += store.purgeTranscript(interview.id);
  }
  const audioPurged = store.purgeAudioBlobs(audioCutoff);
  const consentLogsPurged = store.purgeConsentLogs(consentCutoff);
  return {
    transcriptsPurged,
    audioPurged,
    consentLogsPurged,
    softDeletedCandidatesHardened: 0,
    at: now.toISOString(),
  };
}
