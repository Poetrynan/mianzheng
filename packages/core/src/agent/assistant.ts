import { DomainError } from '../errors.js';
import type {
  AssistantObservation,
  AssistantProposalDraft,
  AssistantStepDecision,
  AssistantToolSpec,
} from '../ai/llm.js';
import type { Interview, InterviewStatus } from '../types.js';
import type { ServiceContext } from '../services/context.js';
import type { BoardService } from '../services/board.js';
import { syncLedgerFromHistory } from './ledger.js';
import { searchSegments } from './evaluationAgent.js';
import type { AgentAction, AgentDriver, AgentToolOutcome, DecisionSource } from './runtime.js';
import type { AgentRun, AgentStepKind, AssistantProposal } from './types.js';

/**
 * 「问面证」：面试官用一句话提出目标，agent 自己决定查什么、按什么顺序查、什么时候够了。
 * 工具全部只读、全部限定在当前工作区；会改数据的事只以「建议」交回给人确认。
 */

export const ASSISTANT_MAX_STEPS = 8;

const STATUS_LABEL: Record<InterviewStatus, string> = {
  scheduled: '已排期',
  in_progress: '进行中',
  audio_done: '转写处理中',
  eval_pending: '待写面评',
  eval_submitted: '已面评',
  expired: '已失效',
};

const LEDGER_LABEL: Record<string, string> = {
  covered: '有原话、已终评',
  missing: '没有原话',
  unscored: '有原话但没终评',
  contradicted: '终评与原话不一致',
};

export const ASSISTANT_TOOLS: AssistantToolSpec[] = [
  {
    name: 'find_interviews',
    description: '列出工作区里的面试（候选人、岗位、轮次、状态）。不确定用户说的是哪位候选人、哪一场时先调它。',
    args: { candidate: '可选，候选人姓名或其中几个字' },
  },
  {
    name: 'evidence_gaps',
    description: '读某位候选人的证据账本：每个考察维度在已提交的面评里有没有原话、哪些缺口会带到下一轮。',
    args: { candidateId: '必填，find_interviews 返回的 candidateId' },
  },
  {
    name: 'search_transcript',
    description: '在某一场面试的转写里按关键词找候选人的原话，返回原文与时间点。找不到就是找不到，不要编。',
    args: { interviewId: '必填', query: '必填，2-12 个字的关键词' },
  },
  {
    name: 'prep_questions',
    description: '读某一场面试的一页纸：上一轮带过来的缺口和追问提纲。',
    args: { interviewId: '必填' },
  },
  {
    name: 'review_status',
    description: '读某一场面试的面评进度：每个维度 AI 起评、面试官终评、缺口。',
    args: { interviewId: '必填' },
  },
  {
    name: 'pending_reviews',
    description: '列出还没提交的面评以及等了多久。',
    args: {},
  },
];

const TOOL_KIND: Record<string, AgentStepKind> = {
  find_interviews: 'read',
  evidence_gaps: 'remember',
  search_transcript: 'search',
  prep_questions: 'read',
  review_status: 'read',
  pending_reviews: 'read',
};

const PROPOSAL_KINDS = new Set<AssistantProposal['kind']>(['run_prep', 'open_prep', 'open_draft', 'open_board', 'open_results']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}` : mm;
}

/** Keeps observations small enough for a model prompt while staying valid JSON. */
function compact(value: unknown, limit = 3500): unknown {
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  return { truncated: true, preview: text.slice(0, limit) };
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export class AssistantAgentDriver implements AgentDriver {
  readonly maxSteps = ASSISTANT_MAX_STEPS;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly board: BoardService,
    private readonly role: string,
    private readonly history: AssistantTurn[],
  ) {}

  private get decidedBy(): DecisionSource {
    return this.ctx.llm.driver === 'mock' ? 'mock' : 'model';
  }

  private interviewIn(run: AgentRun, id: unknown): Interview {
    const interview = this.ctx.store.findInterview(str(id));
    if (!interview || interview.orgId !== run.orgId) {
      throw new DomainError('interview_not_found', '找不到这场面试（或它不属于当前工作区）');
    }
    return interview;
  }

  labelOf(interview: Interview): string {
    const candidate = this.ctx.store.findCandidate(interview.candidateId)?.name ?? '候选人';
    const job = this.ctx.store.findJob(interview.jobId)?.title ?? '岗位';
    return `${candidate} · ${job} · 第 ${interview.round} 轮`;
  }

  private observations(run: AgentRun): AssistantObservation[] {
    return run.steps
      .filter((s) => s.tool && ASSISTANT_TOOLS.some((t) => t.name === s.tool))
      .map((s) => ({
        tool: s.tool as string,
        args: (s.data?.args as Record<string, unknown>) ?? {},
        ok: s.ok,
        result: s.ok ? compact(s.data?.result) : { error: s.detail },
      }));
  }

  private stepLabel(run: AgentRun, tool: string, args: Record<string, unknown>): string {
    const safeLabel = (id: unknown) => {
      const interview = this.ctx.store.findInterview(str(id));
      return interview && interview.orgId === run.orgId ? this.labelOf(interview) : '这场面试';
    };
    switch (tool) {
      case 'find_interviews':
        return str(args.candidate) ? `找「${str(args.candidate)}」的面试` : '看看工作区里有哪些面试';
      case 'evidence_gaps': {
        const name = this.ctx.store.findCandidate(str(args.candidateId))?.name ?? '候选人';
        return `翻看「${name}」的证据账本`;
      }
      case 'search_transcript':
        return `在「${safeLabel(args.interviewId)}」的转写里找「${str(args.query)}」`;
      case 'prep_questions':
        return `读「${safeLabel(args.interviewId)}」的一页纸`;
      case 'review_status':
        return `看「${safeLabel(args.interviewId)}」的面评进度`;
      case 'pending_reviews':
        return '查还没交的面评';
      default:
        return `调用 ${tool}`;
    }
  }

  async next(run: AgentRun): Promise<AgentAction> {
    if (!this.ctx.llm.assistantStep) {
      return { type: 'stop', reason: '当前配置的模型不支持对话式查询' };
    }
    const focus = run.subject.interviewId ? this.ctx.store.findInterview(run.subject.interviewId) : undefined;
    const used = run.steps.filter((s) => s.kind !== 'stop').length;
    const decision: AssistantStepDecision = await this.ctx.llm.assistantStep({
      message: run.goal,
      history: this.history.slice(-6),
      context: {
        role: this.role,
        focusInterviewId: focus && focus.orgId === run.orgId ? focus.id : null,
        focusLabel: focus && focus.orgId === run.orgId ? this.labelOf(focus) : null,
      },
      tools: ASSISTANT_TOOLS,
      observations: this.observations(run),
      stepsLeft: Math.max(0, this.maxSteps - used),
    });

    if (decision.type === 'answer') {
      const text = decision.text.trim();
      if (!text) return { type: 'stop', reason: '模型没有给出回答' };
      return { type: 'final', summary: text, result: { proposals: this.proposals(run, decision.proposals) } };
    }

    const spec = ASSISTANT_TOOLS.find((t) => t.name === decision.tool);
    if (!spec) {
      return { type: 'stop', reason: `模型想调用不存在的工具「${decision.tool}」，先停下` };
    }
    const args = decision.args ?? {};
    return {
      type: 'tool',
      tool: spec.name,
      args,
      label: this.stepLabel(run, spec.name, args),
      kind: TOOL_KIND[spec.name] ?? 'read',
      why: decision.thought?.trim() || undefined,
      decidedBy: this.decidedBy,
    };
  }

  /** Drops anything the model suggested that does not exist or does not belong to this workspace. */
  private proposals(run: AgentRun, drafts: AssistantProposalDraft[]): AssistantProposal[] {
    const out: AssistantProposal[] = [];
    for (const p of drafts ?? []) {
      if (!PROPOSAL_KINDS.has(p.kind)) continue;
      if (p.kind === 'open_board' || p.kind === 'open_results') {
        out.push({ kind: p.kind, interviewId: null, label: p.kind === 'open_board' ? '打开交付看板' : '打开候选人结果' });
        continue;
      }
      const interview = this.ctx.store.findInterview(str(p.interviewId));
      if (!interview || interview.orgId !== run.orgId) continue;
      const label = this.labelOf(interview);
      if (p.kind === 'run_prep') out.push({ kind: p.kind, interviewId: interview.id, label: `生成「${label}」的一页纸` });
      if (p.kind === 'open_prep') out.push({ kind: p.kind, interviewId: interview.id, label: `打开「${label}」的一页纸` });
      if (p.kind === 'open_draft') out.push({ kind: p.kind, interviewId: interview.id, label: `打开「${label}」的面评` });
    }
    return out.filter((p, i) => out.findIndex((q) => q.kind === p.kind && q.interviewId === p.interviewId) === i).slice(0, 3);
  }

  act(run: AgentRun, tool: string, args: Record<string, unknown> = {}): AgentToolOutcome {
    const result = this.run(run, tool, args);
    return { kind: TOOL_KIND[tool] ?? 'read', detail: result.detail, data: { args, result: result.data } };
  }

  private run(run: AgentRun, tool: string, args: Record<string, unknown>): { detail: string; data: unknown } {
    const orgId = run.orgId;
    switch (tool) {
      case 'find_interviews': {
        const needle = str(args.candidate);
        const list = this.ctx.store
          .listInterviews(orgId)
          .map((i) => ({ i, candidate: this.ctx.store.findCandidate(i.candidateId) }))
          .filter(({ candidate }) => candidate && !candidate.deletedAt && (!needle || candidate.name.includes(needle)))
          .sort((a, b) => a.i.round - b.i.round || a.i.scheduledAt.localeCompare(b.i.scheduledAt))
          .slice(0, 20)
          .map(({ i, candidate }) => ({
            interviewId: i.id,
            candidateId: i.candidateId,
            candidate: candidate?.name ?? '',
            job: this.ctx.store.findJob(i.jobId)?.title ?? '',
            round: i.round,
            status: i.status,
            statusLabel: STATUS_LABEL[i.status],
            scheduledAt: i.scheduledAt,
          }));
        return {
          detail: list.length === 0 ? '没有找到对应的面试' : `找到 ${list.length} 场：${[...new Set(list.map((x) => x.candidate))].join('、')}`,
          data: { interviews: list },
        };
      }
      case 'evidence_gaps': {
        const candidate = this.ctx.store.findCandidate(str(args.candidateId));
        if (!candidate || candidate.orgId !== orgId) throw new DomainError('candidate_not_found', '找不到这位候选人');
        const entries = syncLedgerFromHistory(this.ctx, candidate.id, candidate.appliedJobId).map((e) => ({
          dimension: e.dimensionName,
          status: e.status,
          statusLabel: LEDGER_LABEL[e.status] ?? e.status,
          fromRound: e.fromRound,
          reason: e.reason,
          carryOver: e.carryOver,
          quotes: e.evidence.slice(0, 1).map((q) => ({ at: clock(q.startMs), text: q.quote.slice(0, 60) })),
        }));
        const open = entries.filter((e) => e.status !== 'covered');
        return {
          detail: entries.length === 0 ? '还没有提交过的面评，账本是空的' : `${entries.length} 个维度，${open.length} 个还没核实：${open.map((e) => e.dimension).join('、') || '无'}`,
          data: { candidate: candidate.name, candidateId: candidate.id, entries },
        };
      }
      case 'search_transcript': {
        const interview = this.interviewIn(run, args.interviewId);
        const query = str(args.query);
        if (query.length < 2) throw new DomainError('bad_query', '检索词至少两个字');
        const hits = searchSegments(this.ctx.store.listSegments(interview.id), query, 4).map((s) => ({
          segmentId: s.id,
          at: clock(s.startMs),
          text: s.text,
        }));
        return {
          detail: hits.length === 0 ? `没找到候选人说过「${query}」` : `找到 ${hits.length} 段候选人原话`,
          data: { interviewId: interview.id, query, hits },
        };
      }
      case 'prep_questions': {
        const interview = this.interviewIn(run, args.interviewId);
        const pack = this.ctx.store.latestPrepPack(interview.id);
        if (!pack) {
          return { detail: '这场还没有生成一页纸', data: { interviewId: interview.id, exists: false } };
        }
        const std = this.ctx.store.findStandard(pack.standardId);
        const dimName = (id: string | null) => std?.dimensions.find((d) => d.id === id)?.name ?? '自由追问';
        return {
          detail: `${pack.questions.length} 个追问，${pack.carryOver?.length ?? 0} 个来自上一轮缺口`,
          data: {
            interviewId: interview.id,
            exists: true,
            carryOver: (pack.carryOver ?? []).map((c) => ({ dimension: c.dimensionName, fromRound: c.fromRound, reason: c.reason })),
            questions: pack.questions.map((q) => ({ text: q.text, dimension: dimName(q.dimensionId), source: q.source })),
          },
        };
      }
      case 'review_status': {
        const interview = this.interviewIn(run, args.interviewId);
        const drafts = this.ctx.store.listDraftsByInterview(interview.id).map((d) => ({
          interviewer: this.ctx.store.findUser(d.interviewerId)?.name ?? '面试官',
          status: d.status,
          dims: d.checks.map((c) => ({ name: c.dimensionName, ai: c.aiScore, final: c.finalScore, quotes: c.finalEvidence.length || c.aiEvidence.length })),
        }));
        return {
          detail: drafts.length === 0 ? `这场${STATUS_LABEL[interview.status]}，还没有面评草稿` : `${drafts.length} 份面评`,
          data: { interviewId: interview.id, status: interview.status, statusLabel: STATUS_LABEL[interview.status], drafts },
        };
      }
      case 'pending_reviews': {
        const rows = this.board
          .rows(orgId)
          .filter((r) => r.submittedOnTime === null && r.waitingHours !== null)
          .map((r) => ({ interviewId: r.interviewId, candidate: r.candidateLabel, job: r.jobTitle, round: r.round, interviewers: r.interviewers, waitingHours: r.waitingHours }));
        return {
          detail: rows.length === 0 ? '没有等待提交的面评' : `${rows.length} 份面评还没交`,
          data: { rows },
        };
      }
      default:
        throw new DomainError('unknown_tool', `不认识的工具：${tool}`);
    }
  }
}
