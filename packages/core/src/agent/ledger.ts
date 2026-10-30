import type { EvidenceRef, FeedbackDraft, Interview, PrepPackCarryOver, StandardDimensionCheck } from '../types.js';
import { type ServiceContext, nowIso } from '../services/context.js';
import type { EvidenceLedgerEntry, LedgerStatus } from './types.js';

/** Deterministic id: one row per candidate + job + dimension, so updates overwrite instead of piling up. */
export function ledgerId(candidateId: string, jobId: string, dimensionId: string): string {
  return `led_${candidateId}_${jobId}_${dimensionId}`;
}

/** 人改过就以人的为准；照抄 AI 起评时，可回放的引用还挂在 aiEvidence 上。 */
export function checkEvidence(check: StandardDimensionCheck): EvidenceRef[] {
  return check.finalEvidence.length > 0 ? check.finalEvidence : check.aiEvidence;
}

function statusOf(check: StandardDimensionCheck, evidence: EvidenceRef[]): LedgerStatus {
  if (evidence.length === 0) return 'missing';
  if (check.finalScore === null) return 'unscored';
  if (check.finalScore === 'low') return 'contradicted';
  return 'covered';
}

export function entryFromCheck(
  ctx: ServiceContext,
  draft: FeedbackDraft,
  interview: Interview,
  check: StandardDimensionCheck,
): EvidenceLedgerEntry {
  const evidence = checkEvidence(check);
  const status = statusOf(check, evidence);
  const reason =
    status === 'missing' ? '没有找到候选人的原话' : status === 'unscored' ? '没有给出评分' : null;
  const open = status === 'missing' || status === 'unscored';
  return {
    id: ledgerId(interview.candidateId, interview.jobId, check.dimensionId),
    orgId: draft.orgId,
    candidateId: interview.candidateId,
    jobId: interview.jobId,
    dimensionId: check.dimensionId,
    dimensionName: check.dimensionName,
    status,
    fromRound: interview.round,
    interviewId: interview.id,
    draftId: draft.id,
    reason,
    evidence,
    carryOver: open && draft.gapDisposition !== 'not_carry',
    source: 'submitted',
    updatedAt: nowIso(ctx),
  };
}

/** Writes the memory row when a review is actually submitted — drafts nobody confirmed never count. */
export function syncLedgerFromDraft(ctx: ServiceContext, draft: FeedbackDraft, interview: Interview): EvidenceLedgerEntry[] {
  const entries = draft.checks.map((check) => entryFromCheck(ctx, draft, interview, check));
  for (const entry of entries) ctx.store.saveLedgerEntry(entry);
  return entries;
}

/**
 * Rebuilds the memory from submitted reviews before reading it. Drafts submitted before the
 * ledger existed (and test fixtures that rewrite a submitted draft) still land in the same place.
 */
export function syncLedgerFromHistory(ctx: ServiceContext, candidateId: string, jobId: string): EvidenceLedgerEntry[] {
  const candidate = ctx.store.findCandidate(candidateId);
  if (!candidate) return [];
  const interviews = ctx.store
    .listInterviews(candidate.orgId)
    .filter((i) => i.candidateId === candidateId && i.jobId === jobId)
    .sort((a, b) => a.round - b.round || Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  for (const interview of interviews) {
    for (const draft of ctx.store.listDraftsByInterview(interview.id)) {
      if (draft.status !== 'submitted') continue;
      for (const check of draft.checks) {
        ctx.store.saveLedgerEntry(entryFromCheck(ctx, draft, interview, check));
      }
    }
  }
  return readLedger(ctx, candidateId, jobId);
}

export function readLedger(ctx: ServiceContext, candidateId: string, jobId: string): EvidenceLedgerEntry[] {
  return ctx.store.listLedger(candidateId).filter((e) => e.jobId === jobId);
}

/** Only earlier rounds, only open gaps, and only ones a human did not explicitly leave behind. */
export function carryOverFromLedger(
  entries: EvidenceLedgerEntry[],
  currentRound: number,
  nameById: Map<string, string>,
): PrepPackCarryOver[] {
  return entries
    .filter(
      (e) =>
        e.fromRound < currentRound &&
        e.carryOver &&
        (e.status === 'missing' || e.status === 'unscored') &&
        nameById.has(e.dimensionId),
    )
    .sort((a, b) => b.fromRound - a.fromRound || a.dimensionId.localeCompare(b.dimensionId))
    .map((e) => ({
      dimensionId: e.dimensionId,
      dimensionName: nameById.get(e.dimensionId) ?? e.dimensionName,
      fromRound: e.fromRound,
      reason: e.reason ?? (e.status === 'missing' ? '没有找到候选人的原话' : '没有给出评分'),
    }));
}

export function openGaps(entries: EvidenceLedgerEntry[]): EvidenceLedgerEntry[] {
  return entries.filter((e) => e.status === 'missing' || e.status === 'unscored');
}
