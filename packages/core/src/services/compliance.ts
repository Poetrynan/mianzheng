import { DAY_MS } from '../clock.js';
import { DomainError } from '../errors.js';
import { runRetentionSweep, type SweepReport } from '../compliance/retention.js';
import { APPEAL_CHANNEL, AI_LABEL, CONSENT_NOTICE_TEXT, REFERENCE_ONLY_DISCLAIMER } from '../compliance/notices.js';
import {
  assertNoProtectedAttributes,
  scanForProtectedAttributes,
  type GuardResult,
} from '../compliance/protectedAttributes.js';
import type { Candidate } from '../types.js';
import { type Actor, type ServiceContext, nowIso, recordAudit } from './context.js';

export interface ComplianceNotice {
  consentText: string;
  appealChannel: typeof APPEAL_CHANNEL;
  aiLabel: typeof AI_LABEL;
  referenceOnly: string;
  retention: { audioDays: number; consentDays: number };
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

/**
 * The compliance surfaces the PRD promises as operations: deletion requests, the review
 * appeal channel, the bias pre-check the UI offers before a write, and the retention sweep.
 */
export class ComplianceService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireCandidate(id: string): Candidate {
    const c = this.ctx.store.findCandidate(id);
    if (!c) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除', { candidateId: id });
    return c;
  }

  /** PIPL: a deletion request is honoured immediately as a soft delete with an audit trail. */
  requestDeletion(actor: Actor, candidateId: string, reason: string): Candidate {
    const c = this.requireCandidate(candidateId);
    if (c.deletedAt) return c;
    const next: Candidate = { ...c, deletedAt: nowIso(this.ctx) };
    this.ctx.store.saveCandidate(next);
    recordAudit(this.ctx, actor, 'candidate.deletion_requested', 'Candidate', candidateId, c.orgId, { reason });
    return next;
  }

  /**
   * PRD 5.2 keeps a six-month look-back on deleted candidates, so hard erasure is a
   * time-driven action of the sweep rather than of the request itself.
   */
  private hardenExpiredDeletions(orgId: string): number {
    const cutoffMs = this.ctx.clock.now().getTime() - this.ctx.retention.audioDays * DAY_MS;
    let hardened = 0;
    for (const c of this.ctx.store.listCandidates(orgId)) {
      if (!c.deletedAt || Date.parse(c.deletedAt) > cutoffMs) continue;
      if (c.resume.rawText === '' && c.name === '已删除候选人') continue;
      this.ctx.store.saveCandidate({
        ...c,
        name: '已删除候选人',
        email: undefined,
        resume: { rawText: '', summary: null, companies: [], titles: [], yearsOfExperience: null, education: [], parseFailed: true },
      });
      hardened += 1;
    }
    if (hardened > 0) {
      recordAudit(this.ctx, { kind: 'system', name: 'retention-sweep' }, 'candidate.hardened', 'Org', orgId, orgId, { hardened });
    }
    return hardened;
  }

  sweep(orgId: string): SweepReport {
    const report = runRetentionSweep(this.ctx.store, this.ctx.clock.now(), this.ctx.retention);
    const hardened = this.hardenExpiredDeletions(orgId);
    const next: SweepReport = { ...report, softDeletedCandidatesHardened: hardened };
    recordAudit(this.ctx, { kind: 'system', name: 'retention-sweep' }, 'compliance.retention_sweep', 'Org', orgId, orgId, {
      ...next,
    });
    return next;
  }

  /** Pre-write check the UI can call before sending a dimension or an evaluation to storage. */
  scan(subject: string, input: Record<string, unknown>): GuardResult {
    const hits = scanForProtectedAttributes(input);
    if (hits.length === 0) return { ok: true, hits };
    return { ok: false, hits };
  }

  /** Exposed so an HR override always carries a reason long enough to audit. */
  guardedWrite(subject: string, input: Record<string, unknown>, overrideReason?: string): GuardResult {
    return assertNoProtectedAttributes(subject, input, overrideReason);
  }

  /** 候选人可申请免费人工复核，并对 AI 评分提出申诉（PRD 6.1）。 */
  requestHumanReview(actor: Actor, interviewId: string, reason: string): AppealTicket {
    const interview = this.ctx.store.findInterview(interviewId);
    if (!interview) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { interviewId });
    if (!reason || reason.trim().length < 4) {
      throw new DomainError('appeal_reason_required', '申诉需要写明具体理由，便于人工复核定位');
    }
    const ticket: AppealTicket = {
      id: `apal-${interviewId}-${Date.parse(nowIso(this.ctx))}`,
      interviewId,
      orgId: interview.orgId,
      reason: reason.trim(),
      raisedBy: actor.kind === 'human' ? actor.userId : actor.kind === 'ai' ? `ai:${actor.model}` : `system:${actor.name}`,
      at: nowIso(this.ctx),
      promisedReplyWithinDays: APPEAL_CHANNEL.responseDeadlineDays,
    };
    recordAudit(this.ctx, actor, 'evaluation.human_review_requested', 'Interview', interviewId, interview.orgId, {
      reason: ticket.reason,
      promisedReplyWithinDays: ticket.promisedReplyWithinDays,
      channel: APPEAL_CHANNEL,
    });
    return ticket;
  }

  notice(): ComplianceNotice {
    return {
      consentText: CONSENT_NOTICE_TEXT,
      appealChannel: APPEAL_CHANNEL,
      aiLabel: AI_LABEL,
      referenceOnly: REFERENCE_ONLY_DISCLAIMER,
      retention: { audioDays: this.ctx.retention.audioDays, consentDays: this.ctx.retention.consentDays },
    };
  }
}
