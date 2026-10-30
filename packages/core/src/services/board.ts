import { HOUR_MS } from '../clock.js';
import type { CandidateStatus, FeedbackDraft, Interview, ScoreLevel } from '../types.js';
import { ON_TIME_HOURS, onTimeRate, submittedDrafts, usableWithin24h, type OnTimeStats, type UsableStats } from './reminders.js';
import type { ServiceContext } from './context.js';

export type BoardLight = 'idle' | 'waiting' | 'attention' | 'overdue' | 'done';

export interface BoardRow {
  interviewId: string;
  candidateId: string;
  /** Anonymized in aggregate views; HR can reveal per row. */
  candidateLabel: string;
  jobTitle: string;
  round: number;
  interviewStatus: Interview['status'];
  light: BoardLight;
  waitingHours: number | null;
  interviewers: string[];
  submittedOnTime: boolean | null;
  latestDraftStatus: FeedbackDraft['status'] | null;
}

export interface BoardOverview {
  scheduled: number;
  inProgress: number;
  awaitingEval: number;
  evaluated: number;
  overdue: number;
  onTimeRate: OnTimeStats;
  /** 同一分母，分子只留「每个维度都有落点、结论挂得回原文」的那几份。 */
  usable: UsableStats;
}

export interface FunnelStage {
  stage: 'new' | 'screening' | 'interview' | 'offer' | 'hired';
  count: number;
  avgDwellHours: number | null;
}

/** One axis of the candidate matrix: what the interviewer finally decided about this dimension. */
export interface CandidateResultCell {
  dimensionId: string;
  dimensionName: string;
  level: ScoreLevel | null;
  evidenceCount: number;
  /** 提交版挂上的原话，点开某一维时原样给出来。 */
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
  /** 下一场还没开始的面：用来区分「面了没交」和「还没面」。 */
  upcomingAt: string | null;
}

export interface CandidateResults {
  jobId: string;
  jobTitle: string;
  standard: { id: string; version: string; dimensions: Array<{ id: string; name: string }> } | null;
  candidates: CandidateResultRow[];
}

const LIGHT_BY_STATUS: Record<Interview['status'], BoardLight> = {
  scheduled: 'idle',
  in_progress: 'idle',
  audio_done: 'waiting',
  eval_pending: 'waiting',
  expired: 'overdue',
  eval_submitted: 'done',
};

export class BoardService {
  constructor(private readonly ctx: ServiceContext) {}

  private nameOf(interviewerId: string): string {
    return this.ctx.store.findUser(interviewerId)?.name ?? interviewerId;
  }

  rows(orgId: string): BoardRow[] {
    const draftsByInterview = new Map<string, FeedbackDraft[]>();
    for (const d of this.ctx.store.listDraftsByOrg(orgId)) {
      const list = draftsByInterview.get(d.interviewId) ?? [];
      list.push(d);
      draftsByInterview.set(d.interviewId, list);
    }

    return this.ctx.store.listInterviews(orgId).map((i) => {
      const drafts = draftsByInterview.get(i.id) ?? [];
      const endedMs = i.endedAt ? Date.parse(i.endedAt) : null;
      const waitingHours = endedMs === null ? null : Math.max(0, Math.round((this.ctx.clock.now().getTime() - endedMs) / HOUR_MS));
      const filed = submittedDrafts(drafts);
      const light: BoardLight =
        filed.length > 0
          ? 'done'
          : i.status === 'eval_pending' && waitingHours !== null && waitingHours >= ON_TIME_HOURS
            ? 'attention'
            : LIGHT_BY_STATUS[i.status];
      const candidate = this.ctx.store.findCandidate(i.candidateId);
      const job = this.ctx.store.findJob(i.jobId);
      return {
        interviewId: i.id,
        candidateId: i.candidateId,
        candidateLabel: candidate?.name ?? i.candidateId,
        jobTitle: job?.title ?? i.jobId,
        round: i.round,
        interviewStatus: i.status,
        light,
        waitingHours,
        interviewers: i.interviewerIds.map((id) => this.nameOf(id)),
        submittedOnTime:
          filed.length > 0 && endedMs !== null ? Date.parse(filed[0]?.submittedAt ?? '') - endedMs <= ON_TIME_HOURS * HOUR_MS : null,
        latestDraftStatus: drafts.length > 0 ? (drafts[drafts.length - 1]?.status ?? null) : null,
      };
    });
  }

  /**
   * 岗位标准下的候选人结果矩阵：一条轴一个维度，取值只认面试官提交版里的最终评分，
   * 后面的轮次覆盖前面的轮次；没评或没挂上原话的轴算缺口，不拿 AI 起评分顶替。
   */
  candidateResults(orgId: string, jobId: string): CandidateResults {
    const job = this.ctx.store.findJob(jobId);
    const standard = job?.confirmedStandardId ? this.ctx.store.findStandard(job.confirmedStandardId) : undefined;
    const dims = standard?.dimensions ?? [];
    const interviews = this.ctx.store
      .listInterviews(orgId)
      .filter((i) => i.jobId === jobId)
      .sort((a, b) => a.round - b.round || Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));

    const candidates = this.ctx.store
      .listCandidates(orgId)
      .filter((c) => !c.deletedAt && c.appliedJobId === jobId)
      .map<CandidateResultRow>((candidate) => {
        const byDimension = new Map<string, CandidateResultCell>();
        const roundsWithDraft = new Set<number>();
        let recommendation: string | null = null;
        let lastSubmittedAt: string | null = null;

        for (const interview of interviews.filter((i) => i.candidateId === candidate.id)) {
          for (const draft of submittedDrafts(this.ctx.store.listDraftsByInterview(interview.id))) {
            roundsWithDraft.add(interview.round);
            for (const check of draft.checks) {
              byDimension.set(check.dimensionId, {
                dimensionId: check.dimensionId,
                dimensionName: check.dimensionName,
                level: check.finalScore,
                evidenceCount: check.finalEvidence.length,
                evidence: check.finalEvidence.map((e) => ({ quote: e.quote, startMs: e.startMs })),
                redFlagHits: check.aiRedFlagHits,
                summary: check.finalSummary ?? check.aiSummary,
                round: interview.round,
                interviewId: interview.id,
                interviewerName: this.nameOf(draft.interviewerId),
                submittedAt: draft.submittedAt,
              });
            }
            if (draft.humanRecommendation) recommendation = draft.humanRecommendation;
            lastSubmittedAt = draft.submittedAt ?? lastSubmittedAt;
          }
        }

        const cells = dims.map<CandidateResultCell>(
          (d) =>
            byDimension.get(d.id) ?? {
              dimensionId: d.id,
              dimensionName: d.name,
              level: null,
              evidenceCount: 0,
              evidence: [],
              redFlagHits: [],
              summary: null,
              round: 0,
              interviewId: '',
              interviewerName: '',
              submittedAt: null,
            },
        );
        const gaps = cells.filter((c) => c.level === null || c.evidenceCount === 0).length;
        const own = interviews.filter((i) => i.candidateId === candidate.id);
        const nextUpcoming = own
          .filter((i) => i.status === 'scheduled' && Date.parse(i.scheduledAt) > this.ctx.clock.now().getTime())
          .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];

        return {
          candidateId: candidate.id,
          name: candidate.name,
          status: candidate.status,
          rounds: new Set(own.map((i) => i.round)).size,
          submittedRounds: roundsWithDraft.size,
          scored: cells.filter((c) => c.level !== null).length,
          gaps,
          cells,
          recommendation,
          lastSubmittedAt,
          upcomingAt: nextUpcoming?.scheduledAt ?? null,
        };
      });

    return {
      jobId,
      jobTitle: job?.title ?? jobId,
      standard: standard
        ? { id: standard.id, version: standard.version, dimensions: dims.map((d) => ({ id: d.id, name: d.name })) }
        : null,
      candidates,
    };
  }

  overview(orgId: string): BoardOverview {
    const interviews = this.ctx.store.listInterviews(orgId);
    const drafts = this.ctx.store.listDraftsByOrg(orgId);
    return {
      scheduled: interviews.filter((i) => i.status === 'scheduled').length,
      inProgress: interviews.filter((i) => i.status === 'in_progress' || i.status === 'audio_done').length,
      awaitingEval: interviews.filter((i) => i.status === 'eval_pending').length,
      evaluated: interviews.filter((i) => i.status === 'eval_submitted').length,
      overdue: interviews.filter((i) => i.status === 'expired').length,
      onTimeRate: onTimeRate(interviews, drafts, this.ctx.clock.now()),
      usable: usableWithin24h(interviews, drafts, this.ctx.clock.now()),
    };
  }

  /** Candidate-level funnel with dwell time; the number HR otherwise assembles in Excel. */
  funnel(orgId: string): FunnelStage[] {
    const candidates = this.ctx.store.listCandidates(orgId).filter((c) => !c.deletedAt);
    const interviews = this.ctx.store.listInterviews(orgId);
    const order: FunnelStage['stage'][] = ['new', 'screening', 'interview', 'offer', 'hired'];
    return order.map((stage) => {
      const inStage = candidates.filter((c) => c.status === stage);
      let dwell: number | null = null;
      if (stage === 'interview') {
        const waiting = interviews
          .filter((i) => i.status === 'eval_pending' && i.endedAt)
          .map((i) => (this.ctx.clock.now().getTime() - Date.parse(i.endedAt as string)) / HOUR_MS);
        dwell = waiting.length > 0 ? Math.round(waiting.reduce((a, b) => a + b, 0) / waiting.length) : null;
      }
      if (stage === 'offer') {
        const betweenOfferAndInterview = candidates
          .filter((c) => c.status === 'offer' || c.status === 'hired')
          .map((c) => {
            const list = interviews.filter((i) => i.candidateId === c.id && i.endedAt);
            if (list.length === 0) return null;
            const last = list[list.length - 1];
            return last ? (this.ctx.clock.now().getTime() - Date.parse(last.endedAt as string)) / HOUR_MS : null;
          })
          .filter((x): x is number => x !== null);
        dwell = betweenOfferAndInterview.length > 0 ? Math.round(betweenOfferAndInterview.reduce((a, b) => a + b, 0) / betweenOfferAndInterview.length) : null;
      }
      return { stage, count: inStage.length, avgDwellHours: dwell };
    });
  }

  weeklyReport(orgId: string): string {
    const now = this.ctx.clock.now();
    const weekStart = now.getTime() - 7 * 24 * HOUR_MS;
    const interviews = this.ctx.store.listInterviews(orgId);
    // 近 7 天：排在本周内的面试，以及本周结束的面试。
    const inWeek = interviews.filter((i) => {
      const scheduled = Date.parse(i.scheduledAt);
      const ended = i.endedAt ? Date.parse(i.endedAt) : null;
      return scheduled >= weekStart || (ended !== null && ended >= weekStart);
    });
    const weekIds = new Set(inWeek.map((i) => i.id));
    const weekDrafts = this.ctx.store.listDraftsByOrg(orgId).filter((d) => weekIds.has(d.interviewId));
    const rate = onTimeRate(inWeek, weekDrafts, now);
    const usable = usableWithin24h(inWeek, weekDrafts, now);
    const rows = this.rows(orgId).filter((r) => r.light === 'waiting' || r.light === 'attention' || r.light === 'overdue');
    const lines = [
      `本周进展：待面试 ${inWeek.filter((i) => i.status === 'scheduled').length} 场，进行中 ${inWeek.filter((i) => i.status === 'in_progress' || i.status === 'audio_done').length} 场，待提交 ${inWeek.filter((i) => i.status === 'eval_pending').length} 场，已提交 ${inWeek.filter((i) => i.status === 'eval_submitted').length} 场。`,
      `24 小时内提交的面评占比（含尚未提交）：${rate.rate === null ? '暂无数据' : `${Math.round(rate.rate * 100)}%（${rate.onTime}/${rate.due}）`}`,
      `其中每个维度都有落点、结论挂得回原话的：${usable.rate === null ? '暂无数据' : `${Math.round(usable.rate * 100)}%（${usable.usable}/${usable.due}）`}`,
      rows.length > 0 ? '需要跟进的候选人：' : '本周没有需要跟进的候选人。',
      ...rows
        .slice(0, 10)
        .map(
          (r) =>
            `- ${r.candidateLabel} · ${r.jobTitle} 第 ${r.round} 轮 · ${
              r.light === 'overdue' ? '已标记失效' : r.light === 'attention' ? '已超过 24 小时' : '等待面评'
            } · 已等 ${r.waitingHours ?? 0} 小时 · 面试官 ${r.interviewers.join('、')}`,
        ),
    ];
    return lines.join('\n');
  }
}
