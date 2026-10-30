import { HOUR_MS } from '../clock.js';
import { DomainError } from '../errors.js';
import { assertTransition, REMINDER_TRANSITIONS } from '../states.js';
import { checkEvidence } from '../agent/ledger.js';
import type { FeedbackDraft, Interview, ReminderEvent, ReminderLevel } from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from './context.js';

export const REMINDER_LEVELS: ReminderLevel[] = [24];
export const ON_TIME_HOURS = 24;

export interface OnTimeStats {
  due: number;
  onTime: number;
  rate: number | null;
}

export interface UsableStats {
  due: number;
  usable: number;
  rate: number | null;
}

/**
 * 「可用」比「按时」严一档：按时只回答交没交，可用回答 HR 拿到之后还要不要挨个问。
 * 三个条件缺一不可——人写了推荐意见；每个维度都有落点（有人评的分，或者确实是 Agent 换了三组词
 * 也没找到原话、被记进账本的证据缺口）；至少一个维度打了分，且那句结论挂得回转写原文。
 * 只给一个维度打分、其余空着提交的面评因此不算可用，主指标刷不上去。
 */
export function isUsableReview(draft: FeedbackDraft): boolean {
  if (draft.status !== 'submitted' || !draft.humanRecommendation) return false;
  const gaps = new Set(draft.gapDimensionIds ?? []);
  if (draft.checks.some((c) => c.finalScore === null && !gaps.has(c.dimensionId))) return false;
  const scored = draft.checks.filter((c) => c.finalScore !== null);
  return scored.length > 0 && scored.every((c) => checkEvidence(c).length > 0);
}

/** 分母与 onTimeRate 同一个口径：窗口已关闭的面试，一场都不能躲掉。 */
export function usableWithin24h(interviews: Interview[], drafts: FeedbackDraft[], now: Date): UsableStats {
  const byInterview = new Map<string, FeedbackDraft[]>();
  for (const d of drafts) {
    const list = byInterview.get(d.interviewId) ?? [];
    list.push(d);
    byInterview.set(d.interviewId, list);
  }
  let due = 0;
  let usable = 0;
  for (const i of interviews) {
    if (!i.endedAt) continue;
    const ended = Date.parse(i.endedAt);
    if (now.getTime() - ended < ON_TIME_HOURS * HOUR_MS) continue;
    due += 1;
    const filed = submittedDrafts(byInterview.get(i.id) ?? []);
    if (filed.some((d) => Date.parse(d.submittedAt ?? '') - ended <= ON_TIME_HOURS * HOUR_MS && isUsableReview(d))) usable += 1;
  }
  return { due, usable, rate: due === 0 ? null : usable / due };
}

/**
 * Regenerating a draft leaves the earlier one behind unsubmitted, so "this interview's review is in"
 * has to mean *some* draft was submitted; the earliest submission is what the 24h window is measured on.
 */
export function submittedDrafts(drafts: FeedbackDraft[]): FeedbackDraft[] {
  return drafts
    .filter((d) => d.status === 'submitted' && d.submittedAt !== null)
    .sort((a, b) => Date.parse(a.submittedAt ?? '') - Date.parse(b.submittedAt ?? ''));
}

function formatRate(stats: OnTimeStats): string {
  return stats.rate === null ? '暂无已到期的面评' : `${Math.round(stats.rate * 100)}%（${stats.onTime}/${stats.due} 份按时）`;
}

/**
 * A single reminder 24 hours after the interview. The pilot deliberately has no escalation
 * ladder: HR sees the overdue row on the board and decides whether to nudge, reassign or restart.
 */
export class ReminderService {
  constructor(private readonly ctx: ServiceContext) {}

  /** HR may widen one interviewer's cadence (a key candidate needing more time). */
  readonly cadenceDelayHours: Record<string, number> = {};

  private requireInterview(interviewId: string): Interview {
    const i = this.ctx.store.findInterview(interviewId);
    if (!i) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { interviewId });
    return i;
  }

  private totalDelayFor(interviewerIds: string[]): number {
    return interviewerIds.reduce((max, id) => Math.max(max, this.cadenceDelayHours[id] ?? 0), 0);
  }

  queueForInterview(actor: Actor, interviewId: string): ReminderEvent[] {
    const i = this.requireInterview(interviewId);
    if (i.status !== 'eval_pending') throw new DomainError('wrong_state', '只有刚结束、等着写面评的面试才会排催办');
    const base = Date.parse(i.endedAt ?? nowIso(this.ctx));
    const created: ReminderEvent[] = [];

    for (const level of REMINDER_LEVELS) {
      if (this.ctx.store.findReminderByLevel(interviewId, level)) continue;
      const delay = level + this.totalDelayFor(i.interviewerIds);
      const ev: ReminderEvent = {
        id: makeId(this.ctx, 'rem'),
        interviewId,
        orgId: i.orgId,
        level,
        dueAt: new Date(base + delay * HOUR_MS).toISOString(),
        deliveredTo: [...i.interviewerIds],
        status: 'queued',
        acknowledgedBy: null,
        suspended: false,
        suspendReason: null,
        sentAt: null,
        note: null,
      };
      this.ctx.store.saveReminder(ev);
      created.push(ev);
    }
    recordAudit(this.ctx, actor, 'reminder.queue', 'Interview', interviewId, i.orgId, { levels: REMINDER_LEVELS });
    return created;
  }

  /**
   * Fires everything due and returns the events it touched, so a test can assert on the
   * ladder instead of relying on wall-clock luck.
   */
  tick(): ReminderEvent[] {
    const due = this.ctx.store.dueReminders(this.ctx.clock.now().getTime());
    const touched: ReminderEvent[] = [];
    for (const ev of due) {
      if (ev.status !== 'queued' && ev.status !== 'sent') continue;
      const interview = this.requireInterview(ev.interviewId);
      if (interview.status !== 'eval_pending' && interview.status !== 'expired') continue;

      const drafts = this.ctx.store.listDraftsByInterview(ev.interviewId);
      if (drafts.length > 0 && drafts.every((d) => d.status === 'submitted')) {
        this.ctx.store.saveReminder({
          ...ev,
          status: 'acknowledged',
          acknowledgedBy: 'system:submitted',
          sentAt: ev.sentAt ?? nowIso(this.ctx),
          note: '面评已提交，催办自动收敛',
        });
        continue;
      }
      if (ev.suspended) continue;
      // 只提醒一次。已送达的事件仍留在 due 查询里，是为了让"面评已提交"把它收敛成 acknowledged。
      if (ev.status === 'sent') continue;
      touched.push(this.send(ev, interview));
    }
    return touched;
  }

  private send(ev: ReminderEvent, interview: Interview): ReminderEvent {
    const ctx = this.ctx;
    const stats = this.onTimeRateFor(interview);
    const link = `/interviews/${interview.id}/draft`;
    const candidate = ctx.store.findCandidate(interview.candidateId);
    const who = candidate ? anonymizedName(candidate.name, interview.id) : interview.candidateId;

    ctx.notifier.publish({
      id: makeId(ctx, 'rem'),
      orgId: interview.orgId,
      interviewId: interview.id,
      to: [...interview.interviewerIds],
      channel: 'in_app',
      kind: 'reminder',
      title: '这位候选人的面评还在等您',
      body: `候选人 ${who} 的面评已等满 ${ON_TIME_HOURS} 小时。您的准时率：${formatRate(stats)}。点击直接写面评：${link}`,
      link,
      at: nowIso(ctx),
    });

    const updated: ReminderEvent = { ...ev, status: 'sent', sentAt: nowIso(ctx) };
    ctx.store.saveReminder(updated);
    recordAudit(ctx, { kind: 'system', name: 'reminder-tick' }, 'reminder.send', 'ReminderEvent', ev.id, interview.orgId, {
      status: 'sent',
    });
    return updated;
  }

  /** PRD 3.5 step 4: three recovery options, all executed only after HR confirms. */
  suggestedActions(interviewId: string): string[] {
    this.requireInterview(interviewId);
    return ['重启面试（重新排期并保留准备包）', '更换面试官（保留金标准与准备包）', '由 HR 依据转写做自评替代'];
  }

  acknowledge(actor: Actor, reminderId: string): ReminderEvent {
    if (actor.kind !== 'human') throw new DomainError('human_only', '催办确认只能由人完成');
    const ev = this.ctx.store.findReminder(reminderId);
    if (!ev) throw new DomainError('reminder_not_found', '这条催办记录不存在');
    assertTransition(REMINDER_TRANSITIONS, ev.status, 'acknowledged', 'ReminderEvent');
    const next: ReminderEvent = { ...ev, status: 'acknowledged', acknowledgedBy: actor.userId };
    this.ctx.store.saveReminder(next);
    recordAudit(this.ctx, actor, 'reminder.acknowledge', 'ReminderEvent', reminderId, ev.orgId, {});
    return next;
  }

  /** 出差/请假：临时挂起，恢复后继续计时。 */
  suspend(actor: Actor, interviewId: string, reason: string): ReminderEvent[] {
    const next = this.ctx.store
      .listReminders(interviewId)
      .map((ev) => (ev.status === 'queued' || ev.status === 'sent' ? { ...ev, suspended: true, suspendReason: reason } : ev));
    for (const ev of next) this.ctx.store.saveReminder(ev);
    recordAudit(this.ctx, actor, 'reminder.suspend', 'Interview', interviewId, this.requireInterview(interviewId).orgId, { reason });
    return next;
  }

  resume(actor: Actor, interviewId: string): ReminderEvent[] {
    const next = this.ctx.store.listReminders(interviewId).map((ev) => ({ ...ev, suspended: false, suspendReason: null }));
    for (const ev of next) this.ctx.store.saveReminder(ev);
    recordAudit(this.ctx, actor, 'reminder.resume', 'Interview', interviewId, this.requireInterview(interviewId).orgId, {});
    return next;
  }

  /** HR 可在候选人粒度关掉催办（已明确不录用）。 */
  disable(actor: Actor, interviewId: string, reason: string): ReminderEvent[] {
    if (actor.kind !== 'human' || actor.role !== 'hr') throw new DomainError('hr_only', '关闭催办只能由 HR 决定');
    const next = this.ctx.store
      .listReminders(interviewId)
      .map((ev) =>
        ev.status === 'queued'
          ? { ...ev, status: 'acknowledged' as const, acknowledgedBy: `hr-closed:${actor.userId}`, note: `HR 关闭催办：${reason}` }
          : ev,
      );
    for (const ev of next) this.ctx.store.saveReminder(ev);
    recordAudit(this.ctx, actor, 'reminder.disable', 'Interview', interviewId, this.requireInterview(interviewId).orgId, { reason });
    return next;
  }

  delayCadence(actor: Actor, interviewerId: string, extraHours: number): void {
    if (actor.kind !== 'human' || actor.role !== 'hr') throw new DomainError('hr_only', '调整催办节奏只能由 HR 决定');
    const bounded = Math.max(0, Math.min(168, extraHours));
    const previous = this.cadenceDelayHours[interviewerId] ?? 0;
    this.cadenceDelayHours[interviewerId] = bounded;
    if (bounded !== previous) this.redateQueuedFor(interviewerId);
    const user = this.ctx.store.findUser(interviewerId);
    recordAudit(this.ctx, actor, 'reminder.delay_cadence', 'User', interviewerId, user?.orgId ?? '', { extraHours: bounded });
  }

  /**
   * HR widens the cadence for an interview that is already waiting, so the ladder must be
   * re-dated, not merely respected by future queues. Sent events are left alone: a nudge
   * already delivered cannot be unsent.
   */
  private redateQueuedFor(interviewerId: string): void {
    for (const ev of this.ctx.store.listQueuedReminders()) {
      if (!ev.deliveredTo.includes(interviewerId)) continue;
      const interview = this.requireInterview(ev.interviewId);
      const base = Date.parse(interview.endedAt ?? ev.dueAt);
      const dueAt = new Date(base + (ev.level + this.totalDelayFor(interview.interviewerIds)) * HOUR_MS).toISOString();
      this.ctx.store.saveReminder({ ...ev, dueAt });
    }
  }

  /** 准点率 = 窗口已关闭且按时提交的面评 / 该面试官参与且窗口已关闭的面评。 */
  onTimeRateFor(interview: Interview): OnTimeStats {
    const mine = this.ctx.store
      .listInterviews(interview.orgId)
      .filter((i) => i.interviewerIds.some((id) => interview.interviewerIds.includes(id)));
    const ids = new Set(mine.map((i) => i.id));
    const drafts = this.ctx.store.listDraftsByOrg(interview.orgId).filter((d) => ids.has(d.interviewId));
    return onTimeRate(mine, drafts, this.ctx.clock.now());
  }
}

/**
 * The denominator is every review whose 24h window has closed, including the ones nobody ever
 * filed. Counting only submitted drafts keeps an endlessly-late interview out of the denominator,
 * so the very number the pilot exists to lift could never fall.
 */
export function onTimeRate(interviews: Interview[], drafts: FeedbackDraft[], now: Date): OnTimeStats {
  const byInterview = new Map<string, FeedbackDraft[]>();
  for (const d of drafts) {
    const list = byInterview.get(d.interviewId) ?? [];
    list.push(d);
    byInterview.set(d.interviewId, list);
  }
  let due = 0;
  let onTime = 0;
  for (const i of interviews) {
    if (!i.endedAt) continue;
    const ended = Date.parse(i.endedAt);
    if (now.getTime() - ended < ON_TIME_HOURS * HOUR_MS) continue;
    due += 1;
    const owed = byInterview.get(i.id) ?? [];
    const filed = submittedDrafts(owed);
    const filedInWindow =
      filed.length > 0 && filed[0] !== undefined && Date.parse(filed[0].submittedAt ?? '') - ended <= ON_TIME_HOURS * HOUR_MS;
    if (filedInWindow) onTime += 1;
  }
  return { due, onTime, rate: due === 0 ? null : onTime / due };
}

/** Cross-candidate views must not leak the name unless the HR tick opted out of anonymizing. */
export function anonymizedName(name: string, seed: string): string {
  const tail = seed.slice(-4);
  return `${name.slice(0, 1)}**（${tail}）`;
}
