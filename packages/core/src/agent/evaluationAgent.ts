import { DomainError } from '../errors.js';
import { EvidenceVerifier } from '../ai/evidence.js';
import type { EvaluationPlan, EvaluationPlanRequest } from '../ai/llm.js';
import type {
  EvidenceRef,
  FeedbackDraft,
  Interview,
  JobStandard,
  RejectedClaim,
  StandardDimension,
  StandardDimensionCheck,
  TranscriptSegment,
} from '../types.js';
import type { Actor, ServiceContext } from '../services/context.js';
import { makeId } from '../services/context.js';
import type { EvaluationService } from '../services/evaluation.js';
import { carryOverFromLedger, openGaps, syncLedgerFromHistory } from './ledger.js';
import {
  type AgentAction,
  type AgentAnswerOutcome,
  type AgentDriver,
  type AgentToolOutcome,
  dataString,
  failedCount,
  stepOf,
  succeeded,
} from './runtime.js';
import type { AgentQuestion, AgentRun, AgentStep } from './types.js';

const MAX_SEARCHES_PER_DIMENSION = 3;
/**
 * 合成、问缺口、人回答、收尾这四步不计入调查：预算再紧也得留下，
 * 否则 agent 走完调查却交不出草稿。
 */
const FINISH_STEPS = 4;

function normalize(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。、；：,.;:!?！？、"'“”‘’]/g, '').toLowerCase();
}

export function searchQueries(dim: StandardDimension): string[] {
  const out: string[] = [];
  for (const raw of [...dim.matchKeywords, dim.name]) {
    const q = raw.trim();
    if (q.length < 2 || out.includes(q)) continue;
    out.push(q);
    if (out.length >= MAX_SEARCHES_PER_DIMENSION) break;
  }
  return out.length > 0 ? out : [dim.name];
}

export function searchSegments(segments: TranscriptSegment[], query: string, limit = 4): TranscriptSegment[] {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  return segments
    .filter((s) => s.speaker === 'candidate' && normalize(s.text).includes(needle))
    .slice(0, limit);
}

function stepForDim(run: AgentRun, tool: string, dimensionId: string): AgentStep | undefined {
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const s = run.steps[i];
    if (s?.tool === tool && s.data?.dimensionId === dimensionId) return s;
  }
  return undefined;
}

function verifiedNote(run: AgentRun, dimensionId: string): AgentStep | undefined {
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const s = run.steps[i];
    if (s?.kind === 'verify' && s.tool === null && s.data?.dimensionId === dimensionId) return s;
  }
  return undefined;
}

function countSearches(run: AgentRun, dimensionId: string): number {
  return run.steps.filter((s) => s.tool === 'search_transcript' && s.data?.dimensionId === dimensionId).length;
}

function refsFromStep(step: AgentStep | undefined): EvidenceRef[] {
  const refs = step?.data?.refs;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (r): r is EvidenceRef =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as EvidenceRef).segmentId === 'string' &&
      typeof (r as EvidenceRef).quote === 'string' &&
      typeof (r as EvidenceRef).startMs === 'number',
  );
}

function rejectedFromRun(run: AgentRun): RejectedClaim[] {
  const seen = new Set<string>();
  const out: RejectedClaim[] = [];
  for (const step of run.steps) {
    if (step.tool !== 'draft_dimension' || step.ok) continue;
    const details = step.data?.details;
    const list = (details as { rejected?: unknown } | undefined)?.rejected;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const r = item as RejectedClaim;
      if (typeof r.claim !== 'string' || typeof r.reason !== 'string') continue;
      const key = `${r.dimensionId ?? ''}|${r.reason}|${r.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

interface PriorGap {
  dimensionId: string;
  name: string;
  reason: string;
}

function priorGapsFromStep(step: AgentStep | undefined): PriorGap[] {
  const gaps = step?.data?.priorGaps;
  if (!Array.isArray(gaps)) return [];
  return gaps
    .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
    .map((g) => ({
      dimensionId: typeof g.dimensionId === 'string' ? g.dimensionId : '',
      name: typeof g.name === 'string' ? g.name : '',
      reason: typeof g.reason === 'string' ? g.reason : '',
    }))
    .filter((g) => g.dimensionId.length > 0);
}

interface PlannedEntry {
  dimensionId: string;
  queries: string[];
  fromPreviousRound: boolean;
  priorReason: string | null;
}

function planEntries(run: AgentRun): PlannedEntry[] {
  const plan = stepOf(run, 'plan_searches')?.data?.plan;
  if (!Array.isArray(plan)) return [];
  const out: PlannedEntry[] = [];
  for (const raw of plan) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.dimensionId !== 'string') continue;
    out.push({
      dimensionId: entry.dimensionId,
      queries: Array.isArray(entry.queries)
        ? entry.queries.filter((q): q is string => typeof q === 'string')
        : [],
      fromPreviousRound: entry.fromPreviousRound === true,
      priorReason: typeof entry.priorReason === 'string' ? entry.priorReason : null,
    });
  }
  return out;
}

/**
 * The model's plan decides the order and the angles; the standard's keywords are only the
 * fallback. A model may narrow a dimension to at most two phrases so one checked keyword
 * slot always remains.
 */
function plannedQueries(run: AgentRun, dim: StandardDimension): string[] {
  const entry = planEntries(run).find((e) => e.dimensionId === dim.id);
  return entry && entry.queries.length > 0 ? entry.queries : searchQueries(dim);
}

function mergePlannedQueries(modelQueries: string[], fallback: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...modelQueries.slice(0, 2), ...fallback]) {
    const query = raw.trim();
    if (query.length < 2 || query.length > 24 || out.includes(query)) continue;
    out.push(query);
    if (out.length >= MAX_SEARCHES_PER_DIMENSION) break;
  }
  return out.length > 0 ? out : fallback.slice(0, MAX_SEARCHES_PER_DIMENSION);
}

function resolveModelPlan(plan: EvaluationPlan, std: JobStandard): { order: string[]; queries: Map<string, string[]> } {
  const byId = new Set(std.dimensions.map((d) => d.id));
  const byName = new Map(std.dimensions.map((d) => [d.name, d.id]));
  const resolve = (key: string): string | null => (byId.has(key) ? key : (byName.get(key) ?? null));
  const queries = new Map<string, string[]>();
  for (const [key, list] of Object.entries(plan.queries ?? {})) {
    const id = resolve(key);
    if (!id || !Array.isArray(list)) continue;
    const cleaned = list
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter((q) => q.length >= 2 && q.length <= 24);
    if (cleaned.length > 0) queries.set(id, cleaned);
  }
  const order: string[] = [];
  for (const key of plan.order ?? []) {
    const id = resolve(key);
    if (id && !order.includes(id)) order.push(id);
  }
  return { order, queries };
}

/**
 * The plan step is the agent's own decision about what to look at first, so the loop follows
 * it. Carried gaps stay in front (a product promise), and any dimension the model skipped is
 * appended instead of being lost.
 */
function plannedDims(run: AgentRun, std: JobStandard): StandardDimension[] {
  const byId = new Map(std.dimensions.map((d) => [d.id, d]));
  const ordered: StandardDimension[] = [];
  for (const entry of planEntries(run)) {
    const dim = byId.get(entry.dimensionId);
    if (dim && !ordered.includes(dim)) ordered.push(dim);
  }
  if (ordered.length === 0) {
    for (const gap of priorGapsFromStep(stepOf(run, 'read_memory'))) {
      const dim = byId.get(gap.dimensionId);
      if (dim && !ordered.includes(dim)) ordered.push(dim);
    }
  }
  for (const dim of std.dimensions) {
    if (!ordered.includes(dim)) ordered.push(dim);
  }
  return ordered;
}

function unresolvedDims(run: AgentRun, dims: StandardDimension[]): StandardDimension[] {
  return dims.filter(
    (d) => !stepForDim(run, 'draft_dimension', d.id)?.ok && !stepForDim(run, 'mark_gap', d.id)?.ok,
  );
}

/**
 * The agent checks its own runway before starting another search: every unresolved dimension
 * still needs one step, and the last four steps belong to finishing. When investigating would
 * eat that reserve, it stops digging and writes down what it has — a complete draft with honest
 * gaps beats a run that dies with nothing.
 */
function outOfRunway(run: AgentRun, dims: StandardDimension[]): boolean {
  const left = unresolvedDims(run, dims).length;
  if (left === 0) return false;
  return run.budget.maxSteps - run.steps.length <= left + FINISH_STEPS;
}

/** Working memory accumulates: a retry reads every hit found for this dimension, not just the last query's. */
function segmentIdsFromSearches(run: AgentRun, dimensionId: string): string[] {
  const ids: string[] = [];
  for (const step of run.steps) {
    if (step.tool !== 'search_transcript' || !step.ok || step.data?.dimensionId !== dimensionId) continue;
    for (const id of segmentIdsFromStep(step)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * 面评 agent: per dimension it searches the transcript, reads the hits, drafts once,
 * verifies every quote against the database, retries with another keyword, and finally
 * marks a gap rather than inventing a score. A human decides what happens to the gaps.
 */
export class EvaluationAgentDriver implements AgentDriver {
  readonly maxSteps = 44;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly evaluation: EvaluationService,
    private readonly actor: Actor,
    private readonly interviewerId: string,
  ) {}

  private interview(run: AgentRun): Interview {
    const id = run.subject.interviewId;
    if (!id) throw new DomainError('interview_required', '这次面评还没关联面试');
    const interview = this.ctx.store.findInterview(id);
    if (!interview) throw new DomainError('interview_not_found', '这场面试不存在或已被删除');
    return interview;
  }

  private standard(interview: Interview): JobStandard {
    const std = this.ctx.store.findStandard(interview.standardId);
    if (!std || std.status !== 'confirmed') {
      throw new DomainError('standard_not_confirmed', '岗位金标准未定稿，不能起草面评');
    }
    return std;
  }

  private segments(interview: Interview): TranscriptSegment[] {
    const segments = this.ctx.store.listSegments(interview.id);
    if (segments.length === 0) {
      throw new DomainError('no_transcript', '没有转写内容，无法生成草稿，请改用人工笔记直接填写');
    }
    return segments;
  }

  private draftOf(run: AgentRun): FeedbackDraft | undefined {
    const step = stepOf(run, 'assemble_draft');
    const id = dataString(step, 'draftId');
    return id ? this.ctx.store.findDraft(id) : undefined;
  }

  next(run: AgentRun): AgentAction {
    const interview = this.interview(run);
    const std = this.standard(interview);

    if (!succeeded(run, 'read_memory')) {
      return { type: 'tool', tool: 'read_memory', label: '翻看上几轮留下的记录', kind: 'read' };
    }
    if (!succeeded(run, 'plan_searches')) {
      return { type: 'tool', tool: 'plan_searches', label: '按维度准备检索词', kind: 'plan' };
    }

    const assembled = stepOf(run, 'assemble_draft');
    if (assembled?.ok) {
      const draft = this.draftOf(run);
      if (!draft) return { type: 'stop', reason: '草稿没落盘，先停下' };
      const gaps = draft.checks.filter((c) => c.aiScore === null);
      if (gaps.length > 0 && !draft.gapDisposition) {
        return {
          type: 'ask',
          question: {
            question: `有 ${gaps.length} 个维度这轮没拿到能用的结论，怎么处理？`,
            detail: `缺口：${gaps.map((g) => g.dimensionName).join('、')}。带进下一轮的话，下一场一页纸会先补这些维度。`,
            options: [
              { value: 'carry_over', label: '带进下一轮（推荐）', description: '下一场先补这些维度' },
              { value: 'not_carry', label: '只留在这轮记录里', description: '不带到下一轮' },
            ],
          },
        };
      }
      return {
        type: 'final',
        summary: `面评草稿好了：${draft.checks.length - gaps.length} 个维度有原话，${gaps.length} 个留了缺口。接下来请你逐项确认并提交。`,
        result: {
          draftId: draft.id,
          gapDimensionIds: gaps.map((g) => g.dimensionId),
        },
      };
    }

    const dims = plannedDims(run, std);
    for (const dim of dims) {
      const draftStep = stepForDim(run, 'draft_dimension', dim.id);
      if (draftStep?.ok) {
        if (!verifiedNote(run, dim.id)) {
          const refs = refsFromStep(draftStep);
          return {
            type: 'note',
            kind: 'verify',
            label: `核对「${dim.name}」的引用`,
            detail: `${refs.length} 段引用都能在转写里找到，保留转写原文`,
            data: { dimensionId: dim.id, refs: refs.length },
          };
        }
        continue;
      }
      const gapStep = stepForDim(run, 'mark_gap', dim.id);
      if (gapStep?.ok) continue;

      if (outOfRunway(run, dims)) {
        /** No room for another angle: record the gap and keep the remaining steps for the draft. */
        return { type: 'tool', tool: 'mark_gap', label: `把「${dim.name}」标成缺口`, kind: 'remember' };
      }

      const queries = plannedQueries(run, dim);
      const searches = countSearches(run, dim.id);
      const lastSearch = stepForDim(run, 'search_transcript', dim.id);
      const lastRead = stepForDim(run, 'read_segments', dim.id);
      const lastDraft = stepForDim(run, 'draft_dimension', dim.id);

      const searchAgainOrGap = (): AgentAction => {
        if (searches < queries.length) {
          const query = queries[searches] as string;
          return { type: 'tool', tool: 'search_transcript', label: `换个词再找「${query}」`, kind: 'search', detail: dim.name };
        }
        return { type: 'tool', tool: 'mark_gap', label: `把「${dim.name}」标成缺口`, kind: 'remember' };
      };

      if (!lastSearch || lastSearch.ok === false) {
        return searchAgainOrGap();
      }

      const hits = refsSegments(lastSearch);
      if (hits.length === 0) {
        return searchAgainOrGap();
      }

      const readIsFresh = Boolean(lastRead && lastRead.ok && lastRead.index > lastSearch.index);
      if (!readIsFresh) {
        return { type: 'tool', tool: 'read_segments', label: `读「${dim.name}」相关的 ${hits.length} 段原话`, kind: 'read' };
      }

      /** A failed draft only retries after fresh evidence was read; otherwise try another keyword. */
      if (lastDraft && !lastDraft.ok && lastDraft.index > (lastRead?.index ?? -1)) {
        return searchAgainOrGap();
      }
      return { type: 'tool', tool: 'draft_dimension', label: `给「${dim.name}」起一稿`, kind: 'draft' };
    }

    return { type: 'tool', tool: 'assemble_draft', label: '把逐个维度的结果合成面评草稿', kind: 'draft' };
  }

  async act(run: AgentRun, tool: string): Promise<AgentToolOutcome> {
    const interview = this.interview(run);
    const std = this.standard(interview);
    const dims = plannedDims(run, std);
    switch (tool) {
      case 'read_memory': {
        const ledger = syncLedgerFromHistory(this.ctx, interview.candidateId, interview.jobId);
        const nameById = new Map(std.dimensions.map((d) => [d.id, d.name]));
        const carry = carryOverFromLedger(ledger, interview.round, nameById);
        const open = openGaps(ledger).filter((e) => e.fromRound < interview.round);
        return {
          kind: 'read',
          label: '翻看上几轮留下的记录',
          detail:
            interview.round <= 1
              ? '第一次面这位候选人，没有上一轮的记录'
              : carry.length > 0
                ? `前几轮留下 ${carry.length} 个缺口，这轮先补：${carry.map((g) => g.dimensionName).join('、')}`
                : open.length === 0
                  ? '前几轮的维度都有结论，没有带着缺口进来'
                  : `${open.length} 个维度前几轮没有结论，但都定了不带到这一轮`,
          data: {
            round: interview.round,
            priorGaps: carry.map((g) => ({
              dimensionId: g.dimensionId,
              name: g.dimensionName,
              reason: g.reason,
              fromRound: g.fromRound,
            })),
            openGaps: open.map((g) => ({
              dimensionId: g.dimensionId,
              name: g.dimensionName,
              carryOver: g.carryOver,
            })),
          },
        };
      }
      case 'plan_searches': {
        const carry = priorGapsFromStep(stepOf(run, 'read_memory'));
        const carryIds = carry
          .map((g) => g.dimensionId)
          .filter((id) => std.dimensions.some((d) => d.id === id));
        const request: EvaluationPlanRequest = {
          round: interview.round,
          dimensions: std.dimensions.map((dim) => ({
            id: dim.id,
            name: dim.name,
            positiveEvidence: [...dim.positiveEvidence],
            redFlags: [...dim.redFlags],
            matchKeywords: [...dim.matchKeywords],
            priorGapReason: carry.find((g) => g.dimensionId === dim.id)?.reason ?? null,
          })),
        };
        let modelPlan: EvaluationPlan | null = null;
        let planError: string | null = null;
        if (this.ctx.llm.planEvaluation) {
          try {
            modelPlan = await this.ctx.llm.planEvaluation(request);
          } catch (err) {
            planError = err instanceof Error ? err.message : String(err);
          }
        }
        const resolved = modelPlan ? resolveModelPlan(modelPlan, std) : { order: [], queries: new Map<string, string[]>() };
        const orderedIds: string[] = [];
        const pushId = (id: string) => {
          if (!orderedIds.includes(id)) orderedIds.push(id);
        };
        /** Carried gaps go first no matter what the model chose; that promise belongs to the product. */
        for (const id of carryIds) pushId(id);
        for (const id of resolved.order) pushId(id);
        for (const dim of std.dimensions) pushId(dim.id);

        const plan = orderedIds.map((id) => {
          const dim = std.dimensions.find((d) => d.id === id) as StandardDimension;
          const gap = carry.find((g) => g.dimensionId === id);
          return {
            dimensionId: id,
            name: dim.name,
            queries: mergePlannedQueries(resolved.queries.get(id) ?? [], searchQueries(dim)),
            fromPreviousRound: Boolean(gap),
            priorReason: gap?.reason ?? null,
          };
        });
        const carried = plan.filter((p) => p.fromPreviousRound).length;
        const usedModel = Boolean(modelPlan && (resolved.order.length > 0 || resolved.queries.size > 0));
        const rest = plan.length - carried;
        const baseDetail =
          carried > 0
            ? resolved.order.length > 0
              ? `先补前几轮留下的 ${carried} 个缺口，再按 AI 排的顺序查其余 ${rest} 个维度`
              : `先补前几轮留下的 ${carried} 个缺口，其余 ${rest} 个维度按标准顺序查`
            : resolved.order.length > 0
              ? `AI 排了 ${plan.length} 个维度的调查顺序，每维先查它挑的词`
              : resolved.queries.size > 0
                ? `AI 给 ${plan.length} 个维度挑了先查的词，其余按标准兜底`
                : `${plan.length} 个维度，每个先按 ${MAX_SEARCHES_PER_DIMENSION} 组词找`;
        return {
          kind: 'plan',
          label: '排这场面评的调查顺序',
          detail: planError ? `${baseDetail}（AI 没给出计划，先用标准里的关键词）` : baseDetail,
          data: {
            plan,
            source: usedModel ? 'model' : 'fallback',
            rationale: modelPlan?.rationale ?? null,
            error: planError,
          },
        };
      }
      case 'search_transcript': {
        const dim = this.readDim(run, dims);
        const segments = this.segments(interview);
        const queries = plannedQueries(run, dim);
        const used = countSearches(run, dim.id);
        const query = queries[used];
        if (!query) throw new DomainError('no_more_queries', `「${dim.name}」已经没有别的检索词了`, { dimensionId: dim.id });
        const hits = searchSegments(segments, query);
        return {
          kind: 'search',
          label: `在转写里找「${query}」`,
          detail:
            hits.length === 0
              ? `没有找到，${used + 1 < queries.length ? '换一个词继续' : '这个词也找不到'}`
              : `找到 ${hits.length} 段候选人的原话`,
          data: {
            dimensionId: dim.id,
            query,
            segmentIds: hits.map((s) => s.id),
            startMs: hits.map((s) => s.startMs),
          },
        };
      }
      case 'read_segments': {
        const dim = this.readDim(run, dims);
        const segments = this.segments(interview);
        const ids = segmentIdsFromSearches(run, dim.id);
        const picked = ids
          .map((id) => segments.find((s) => s.id === id))
          .filter((s): s is TranscriptSegment => Boolean(s));
        if (picked.length === 0) throw new DomainError('no_segments', '刚才找到的片段已经不在转写里了', { dimensionId: dim.id });
        const combined = picked.map((s) => s.text).join(' ');
        return {
          kind: 'read',
          label: `读「${dim.name}」相关的原话`,
          detail: combined.length > 90 ? `${combined.slice(0, 90)}…` : combined,
          data: {
            dimensionId: dim.id,
            segmentIds: picked.map((s) => s.id),
            previews: picked.map((s) => ({ id: s.id, startMs: s.startMs, text: s.text.slice(0, 80) })),
          },
        };
      }
      case 'draft_dimension': {
        const dim = this.readDim(run, dims);
        const segments = this.segments(interview);
        const read = stepForDim(run, 'read_segments', dim.id);
        const ids = segmentIdsFromStep(read);
        const picked = ids
          .map((id) => segments.find((s) => s.id === id))
          .filter((s): s is TranscriptSegment => Boolean(s));
        if (picked.length === 0) throw new DomainError('no_segments', '没有可供引用的原话', { dimensionId: dim.id });

        const result = await this.ctx.llm.draftEvaluation({
          interviewId: interview.id,
          dimensions: [
            {
              id: dim.id,
              name: dim.name,
              positiveEvidence: dim.positiveEvidence,
              redFlags: dim.redFlags,
              matchKeywords: dim.matchKeywords,
            },
          ],
          segments: picked.map((s) => ({
            id: s.id,
            startMs: s.startMs,
            speaker: s.speaker,
            text: s.text,
            confidence: s.confidence,
          })),
          interviewerNotes: [],
        });
        const aiDim = result.dimensions.find((d) => d.dimensionId === dim.id);
        const verifier = new EvidenceVerifier(segments);
        const { refs, rejected } = verifier.resolve(
          (aiDim?.segmentIds ?? []).map((id) => ({ segmentId: id })),
          dim.id,
          aiDim?.summary ?? dim.name,
        );
        if (!aiDim || aiDim.score === null) {
          throw new DomainError('no_score', `AI 没有给出「${dim.name}」的判断，换一组原话再试`, {
            dimensionId: dim.id,
            rejected,
          });
        }
        if (refs.length === 0) {
          throw new DomainError(
            'no_evidence_for_dimension',
            `AI 的结论对不上转写，不能作为「${dim.name}」的证据`,
            { dimensionId: dim.id, rejected },
          );
        }
        return {
          kind: 'draft',
          label: `给「${dim.name}」起一稿`,
          detail: `${refs.length} 段原话支撑，AI 起评 ${aiDim.score}；引用已按转写原文保留`,
          data: {
            dimensionId: dim.id,
            score: aiDim.score,
            summary: aiDim.summary,
            refs,
            redFlagHits: aiDim.redFlagHits,
            needsHumanInput: aiDim.needsHumanInput,
            rejected,
          },
        };
      }
      case 'mark_gap': {
        const dim = this.readDim(run, dims);
        const segments = this.segments(interview);
        const searchSteps = run.steps.filter(
          (s) => s.tool === 'search_transcript' && s.data?.dimensionId === dim.id,
        );
        const searchedQueries = searchSteps
          .map((s) => dataString(s, 'query'))
          .filter((q): q is string => Boolean(q));
        const ids = Array.from(new Set(searchSteps.flatMap((s) => segmentIdsFromStep(s))));
        const refs: EvidenceRef[] = ids
          .map((id) => segments.find((s) => s.id === id))
          .filter((s): s is TranscriptSegment => Boolean(s))
          .map((s) => ({ segmentId: s.id, startMs: s.startMs, quote: s.text }));
        const hadEvidence = refs.length > 0;
        /** No search at all means the runway check stopped this dimension before it started. */
        const noSearch = searchSteps.length === 0;
        const truncated = !noSearch && searchedQueries.length < plannedQueries(run, dim).length;
        const reason = noSearch
          ? '这一轮步数不够，没来得及查'
          : hadEvidence
            ? '有原话但没能落到判断'
            : '没有找到候选人的原话';
        return {
          kind: 'remember',
          label: `把「${dim.name}」标成缺口`,
          detail: noSearch
            ? '剩下的步数要留给合成和收尾，这个维度先标成缺口'
            : truncated
              ? `步数不够，只试了 ${searchedQueries.length} 组词（${searchedQueries.join('、')}），先把这里标成缺口`
              : hadEvidence
                ? `有 ${refs.length} 段相关原话，但没能落到可核对的判断，留给你补`
                : `换了 ${searchedQueries.length} 组词（${searchedQueries.join('、')}）也没找到候选人的原话`,
          data: {
            dimensionId: dim.id,
            reason,
            queries: searchedQueries,
            refs,
            truncated,
          },
        };
      }
      case 'assemble_draft': {
        const checks = std.dimensions.map((dim) => this.checkFor(run, interview, dim));
        const draft = this.evaluation.assembleAgentDraft(this.actor, interview.id, {
          interviewerId: this.interviewerId,
          checks,
          rejectedClaims: rejectedFromRun(run),
          aiModel: this.ctx.llm.model,
          agentRunId: run.id,
        });
        const gaps = draft.checks.filter((c) => c.aiScore === null);
        run.result = {
          summary: gaps.length > 0 ? '草稿已生成，等你决定缺口怎么处理' : '草稿已生成',
          draftId: draft.id,
          gapDimensionIds: gaps.map((g) => g.dimensionId),
        };
        return {
          kind: 'draft',
          label: '把逐个维度的结果合成面评草稿',
          detail: `${draft.checks.length - gaps.length} 个维度有原话，${gaps.length} 个留缺口`,
          data: { draftId: draft.id, gaps: gaps.map((g) => g.dimensionName) },
        };
      }
      default:
        throw new DomainError('unknown_tool', `不认识的工具：${tool}`);
    }
  }

  applyAnswer(run: AgentRun, question: AgentQuestion, answer: string): AgentAnswerOutcome {
    const value = answer.trim();
    if (value !== 'carry_over' && value !== 'not_carry') {
      throw new DomainError('invalid_gap_disposition', '请从「带进下一轮」或「只留在这轮」里选一个');
    }
    const draft = this.draftOf(run);
    if (!draft) throw new DomainError('no_draft', '还没有可以处理的面评草稿');
    const updated = this.evaluation.setGapDisposition(this.actor, draft.id, value);
    const gaps = updated.checks.filter((c) => c.aiScore === null).map((c) => c.dimensionName);
    return {
      label: value === 'carry_over' ? '你选择：带进下一轮' : '你选择：只留在这轮',
      detail:
        value === 'carry_over'
          ? `${gaps.join('、')} 会在下一场的一页纸里先补`
          : `${gaps.join('、')} 只留在这场记录里，不带到下一轮`,
    };
  }

  private readDim(run: AgentRun, dims: StandardDimension[]): StandardDimension {
    /** The tool action does not carry the dimension id; the loop picks the first unfinished one. */
    for (const dim of dims) {
      if (stepForDim(run, 'draft_dimension', dim.id)?.ok) continue;
      if (stepForDim(run, 'mark_gap', dim.id)?.ok) continue;
      const lastSearch = stepForDim(run, 'search_transcript', dim.id);
      const lastDraft = stepForDim(run, 'draft_dimension', dim.id);
      const lastRead = stepForDim(run, 'read_segments', dim.id);
      if (lastDraft && !lastDraft.ok) return dim;
      if (!lastSearch) return dim;
      if (lastSearch.ok === false) return dim;
      if (segmentIdsFromStep(lastSearch).length === 0) return dim;
      if (!lastRead || lastRead.ok === false) return dim;
      return dim;
    }
    throw new DomainError('all_dimensions_done', '所有维度都处理完了');
  }

  private checkFor(run: AgentRun, interview: Interview, dim: StandardDimension): StandardDimensionCheck {
    const draftStep = stepForDim(run, 'draft_dimension', dim.id);
    if (draftStep?.ok) {
      const data = draftStep.data ?? {};
      return {
        id: makeId(this.ctx, 'chk'),
        interviewId: interview.id,
        dimensionId: dim.id,
        dimensionName: dim.name,
        aiScore: (data.score as StandardDimensionCheck['aiScore']) ?? null,
        aiSummary: typeof data.summary === 'string' ? data.summary : null,
        aiEvidence: refsFromStep(draftStep),
        aiRedFlagHits: Array.isArray(data.redFlagHits) ? (data.redFlagHits as string[]) : [],
        needsHumanInput: data.needsHumanInput === true,
        finalScore: null,
        finalSummary: null,
        finalEvidence: [],
        revisedBy: [],
        status: 'auto_filled',
      };
    }
    const gapStep = stepForDim(run, 'mark_gap', dim.id);
    const reason = dataString(gapStep, 'reason');
    const refs = refsFromStep(gapStep);
    const baseSummary =
      reason === '这一轮步数不够，没来得及查'
        ? `这一轮步数不够，还没查「${dim.name}」，需要人工补充`
        : reason === '没有找到候选人的原话'
          ? `换了检索词也没找到与「${dim.name}」相关的原话，需要人工补充判断`
          : `有 ${refs.length} 段相关原话，但没能落到可核对的判断，需要人工补充`;
    return {
      id: makeId(this.ctx, 'chk'),
      interviewId: interview.id,
      dimensionId: dim.id,
      dimensionName: dim.name,
      aiScore: null,
      aiSummary:
        gapStep?.data?.truncated === true ? `${baseSummary}（这一轮步数不够，没有查完）` : baseSummary,
      aiEvidence: refs,
      aiRedFlagHits: [],
      needsHumanInput: true,
      finalScore: null,
      finalSummary: null,
      finalEvidence: [],
      revisedBy: [],
      status: 'auto_filled',
    };
  }
}

function segmentIdsFromStep(step: AgentStep | undefined): string[] {
  const ids = step?.data?.segmentIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

function refsSegments(step: AgentStep): string[] {
  return segmentIdsFromStep(step);
}

export function evaluationFailures(run: AgentRun): number {
  return failedCount(run, 'draft_dimension');
}
