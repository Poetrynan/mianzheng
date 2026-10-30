import { DomainError } from '../errors.js';
import { scanForProtectedAttributes } from '../compliance/protectedAttributes.js';
import type { Interview, JobStandard, PrepPack, PrepPackQuestion } from '../types.js';
import type { Actor, ServiceContext } from '../services/context.js';
import { makeId, recordAudit } from '../services/context.js';
import type { PrepPackService } from '../services/prepPack.js';
import { carryOverFromLedger, openGaps, syncLedgerFromHistory } from './ledger.js';
import {
  type AgentAction,
  type AgentDriver,
  type AgentToolOutcome,
  failedCount,
  stepOf,
  stepsOf,
  succeeded,
} from './runtime.js';
import type { AgentRun } from './types.js';

const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 6;
const MAX_REPAIRS = 2;

export class PrepAgentDriver implements AgentDriver {
  readonly maxSteps = 16;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly prepPack: PrepPackService,
    private readonly actor: Actor,
  ) {}

  private interview(run: AgentRun): Interview {
    const id = run.subject.interviewId;
    if (!id) throw new DomainError('interview_required', '这次准备包还没关联面试');
    const interview = this.ctx.store.findInterview(id);
    if (!interview) throw new DomainError('interview_not_found', '这场面试不存在或已被删除');
    return interview;
  }

  private standard(interview: Interview): JobStandard {
    const std = this.ctx.store.findStandard(interview.standardId);
    if (!std || std.status !== 'confirmed') {
      throw new DomainError('standard_not_confirmed', '岗位金标准尚未定稿，无法生成一页纸');
    }
    return std;
  }

  next(run: AgentRun): AgentAction {
    if (!succeeded(run, 'read_ledger')) {
      return { type: 'tool', tool: 'read_ledger', label: '翻看上一轮留下的证据缺口', kind: 'read' };
    }
    if (!succeeded(run, 'read_resume')) {
      return { type: 'tool', tool: 'read_resume', label: '读候选人的简历', kind: 'read' };
    }
    if (!succeeded(run, 'build_pack')) {
      return { type: 'tool', tool: 'build_pack', label: '把缺口和简历合成一页纸', kind: 'draft' };
    }

    const lastStep = run.steps[run.steps.length - 1];
    const validate = stepOf(run, 'validate_pack');
    if (!validate || (lastStep?.tool === 'repair_pack' && lastStep.ok)) {
      return { type: 'tool', tool: 'validate_pack', label: '自查这一页纸能不能直接照着问', kind: 'verify' };
    }
    if (validate.ok) {
      const pack = this.ctx.store.latestPrepPack(this.interview(run).id);
      return {
        type: 'final',
        summary: pack
          ? `一页纸好了：${pack.questions.length} 个追问，其中 ${pack.carryOver?.length ?? 0} 个来自上一轮的缺口。`
          : '一页纸好了。',
        result: {
          prepPackId: pack?.id,
          carryOverDimensionNames: pack?.carryOver?.map((c) => c.dimensionName) ?? [],
        },
      };
    }
    if (failedCount(run, 'repair_pack') < MAX_REPAIRS) {
      return { type: 'tool', tool: 'repair_pack', label: '把对不上的问题补上或删掉', kind: 'draft' };
    }
    return { type: 'stop', reason: '一页纸自检没过，先停下交给你看' };
  }

  async act(run: AgentRun, tool: string): Promise<AgentToolOutcome> {
    const interview = this.interview(run);
    const std = this.standard(interview);
    switch (tool) {
      case 'read_ledger': {
        const candidate = this.ctx.store.findCandidate(interview.candidateId);
        if (!candidate) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除');
        const nameById = new Map(std.dimensions.map((d) => [d.id, d.name]));
        const ledger = syncLedgerFromHistory(this.ctx, candidate.id, interview.jobId);
        const carry = carryOverFromLedger(ledger, interview.round, nameById);
        const gaps = openGaps(ledger).filter((e) => e.fromRound < interview.round);
        return {
          kind: 'read',
          label: '翻看上一轮留下的证据缺口',
          detail:
            interview.round <= 1
              ? '这是第一轮，还没有跨轮次记忆'
              : carry.length === 0
                ? `翻过前 ${interview.round - 1} 轮，没有需要补的缺口`
                : `前几轮留下 ${gaps.length} 个缺口，这轮要补：${carry.map((c) => c.dimensionName).join('、')}`,
          data: {
            round: interview.round,
            carry: carry.map((c) => ({ dimensionId: c.dimensionId, name: c.dimensionName, reason: c.reason })),
            openGaps: gaps.map((g) => g.dimensionName),
          },
        };
      }
      case 'read_resume': {
        const candidate = this.ctx.store.findCandidate(interview.candidateId);
        if (!candidate) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除');
        return {
          kind: 'read',
          label: '读候选人的简历',
          detail: candidate.resume.parseFailed
            ? '简历解析不完整，这一页纸会标明需要 HR 补齐'
            : `简历里能看到 ${candidate.resume.companies.length} 段公司经历、${candidate.resume.titles.length} 个职位`,
          data: {
            parseFailed: candidate.resume.parseFailed,
            companies: candidate.resume.companies,
            years: candidate.resume.yearsOfExperience,
          },
        };
      }
      case 'build_pack': {
        const built = await this.prepPack.build(this.actor, interview.id);
        return {
          kind: 'draft',
          label: '把缺口和简历合成一页纸',
          detail: `生成了 ${built.questions.length} 个追问，${built.carryOver?.length ?? 0} 个来自上一轮缺口`,
          data: { packId: built.id, questions: built.questions.length, carry: built.carryOver?.length ?? 0 },
        };
      }
      case 'validate_pack': {
        const pack = this.ctx.store.latestPrepPack(interview.id);
        if (!pack) throw new DomainError('no_prep_pack', '还没有一页纸可以检查');
        const issues = validatePack(pack, std);
        if (issues.length > 0) {
          throw new DomainError('pack_invalid', `一页纸自检发现 ${issues.length} 个问题：${issues.join('；')}`, { issues });
        }
        return {
          kind: 'verify',
          label: '自查这一页纸能不能直接照着问',
          detail: `${std.dimensions.length} 个维度都有落点，没有不合规追问`,
          data: { questions: pack.questions.length, dimensions: std.dimensions.length },
        };
      }
      case 'repair_pack': {
        const pack = this.ctx.store.latestPrepPack(interview.id);
        if (!pack) throw new DomainError('no_prep_pack', '还没有一页纸可以修');
        const repaired = repairPack(this.ctx, pack, std);
        recordAudit(this.ctx, this.actor, 'prep_pack.agent_repair', 'PrepPack', repaired.pack.id, interview.orgId, {
          removed: repaired.removed,
          added: repaired.added,
        });
        return {
          kind: 'draft',
          label: '把对不上的问题补上或删掉',
          detail: repaired.removed + repaired.added === 0
            ? '没有需要改动的地方'
            : `删掉 ${repaired.removed} 条，补上 ${repaired.added} 条`,
          data: { removed: repaired.removed, added: repaired.added, questions: repaired.pack.questions.length },
        };
      }
      default:
        throw new DomainError('unknown_tool', `不认识的工具：${tool}`);
    }
  }
}

function validatePack(pack: PrepPack, std: JobStandard): string[] {
  const issues: string[] = [];
  if (pack.standardId !== std.id) issues.push('这一页纸挂的岗位标准不是当前定稿版本');
  const dimIds = new Set(std.dimensions.map((d) => d.id));

  const aligned = new Set(pack.alignment.map((a) => a.dimensionId));
  for (const dim of std.dimensions) {
    if (!aligned.has(dim.id)) issues.push(`「${dim.name}」没有出现在对齐表里`);
  }
  for (const row of pack.alignment) {
    if (!dimIds.has(row.dimensionId)) issues.push(`对齐表里有不属于当前标准的维度「${row.dimensionName}」`);
  }

  if (pack.questions.length < MIN_QUESTIONS) issues.push(`只有 ${pack.questions.length} 个追问，少于 ${MIN_QUESTIONS} 个`);
  if (pack.questions.length > MAX_QUESTIONS) issues.push(`有 ${pack.questions.length} 个追问，超过一页纸能承载的 ${MAX_QUESTIONS} 个`);
  for (const q of pack.questions) {
    if (q.dimensionId !== null && !dimIds.has(q.dimensionId)) {
      issues.push(`追问「${q.text.slice(0, 18)}…」挂在一个不存在的维度上`);
    }
    if (scanForProtectedAttributes({ question: q.text }).length > 0) {
      issues.push(`追问「${q.text.slice(0, 18)}…」涉及与岗位无关的隐私信息`);
    }
  }
  for (const carry of pack.carryOver ?? []) {
    if (!pack.questions.some((q) => q.dimensionId === carry.dimensionId)) {
      issues.push(`上一轮的缺口「${carry.dimensionName}」没有对应追问`);
    }
    if (pack.alignment.find((a) => a.dimensionId === carry.dimensionId)?.mark !== 'needs_probe') {
      issues.push(`上一轮的缺口「${carry.dimensionName}」没有标成重点考察`);
    }
  }
  if ((pack.carryOver?.length ?? 0) > 0) {
    const first = pack.questions[0];
    if (!first || !pack.carryOver?.some((c) => c.dimensionId === first.dimensionId)) {
      issues.push('上一轮的缺口没有排在最前面');
    }
  }
  if (pack.crux.length === 0) issues.push('一页纸没有关键信息');
  if (pack.redFlagChecks.length === 0) issues.push('一页纸没有红旗排查项');
  return issues;
}

/** Deterministic fix-up: the agent may repair its own artifact, but never invent a score or a claim. */
function repairPack(
  ctx: ServiceContext,
  pack: PrepPack,
  std: JobStandard,
): { pack: PrepPack; removed: number; added: number } {
  const dimIds = new Set(std.dimensions.map((d) => d.id));
  const dimById = new Map(std.dimensions.map((d) => [d.id, d]));
  let removed = 0;
  let added = 0;

  let questions: PrepPackQuestion[] = pack.questions.filter((q) => {
    const badDim = q.dimensionId !== null && !dimIds.has(q.dimensionId);
    const unsafe = scanForProtectedAttributes({ question: q.text }).length > 0;
    if (badDim || unsafe) {
      removed += 1;
      return false;
    }
    return true;
  });

  const carry = pack.carryOver ?? [];
  const carried = new Set(carry.map((c) => c.dimensionId));
  for (const gap of carry) {
    if (questions.some((q) => q.dimensionId === gap.dimensionId)) continue;
    const dim = dimById.get(gap.dimensionId);
    if (!dim) continue;
    const probe = dim.probes[0] ?? `请举一个具体例子说明「${dim.name}」。`;
    questions.push({
      id: makeId(ctx, 'qst'),
      text: probe,
      dimensionId: dim.id,
      why: `第 ${gap.fromRound} 轮${gap.reason}，这轮先补问`,
      source: 'standard',
      addedBy: null,
    });
    added += 1;
  }

  const covered = new Set(questions.map((q) => q.dimensionId));
  if (questions.length < MIN_QUESTIONS) {
    for (const dim of std.dimensions) {
      if (questions.length >= MIN_QUESTIONS) break;
      if (covered.has(dim.id)) continue;
      questions.push({
        id: makeId(ctx, 'qst'),
        text: dim.probes[0] ?? `请举一个具体例子说明「${dim.name}」。`,
        dimensionId: dim.id,
        why: `验证「${dim.name}」`,
        source: 'standard',
        addedBy: null,
      });
      covered.add(dim.id);
      added += 1;
    }
  }

  /** Carry-over questions stay at the top; the rest keep their order, then the page is capped. */
  const beforeSlice = questions.length;
  questions = [
    ...questions.filter((q) => q.dimensionId !== null && carried.has(q.dimensionId)),
    ...questions.filter((q) => q.dimensionId === null || !carried.has(q.dimensionId)),
  ].slice(0, MAX_QUESTIONS);
  removed += Math.max(0, beforeSlice - questions.length);

  const alignment = [...pack.alignment];
  for (const dim of std.dimensions) {
    const row = alignment.find((a) => a.dimensionId === dim.id);
    if (!row) {
      alignment.push({
        dimensionId: dim.id,
        dimensionName: dim.name,
        mark: 'needs_probe',
        rationale: '自检补上的维度，赛前请确认',
      });
      added += 1;
    } else if (carried.has(dim.id) && row.mark !== 'needs_probe') {
      row.mark = 'needs_probe';
    }
  }

  const next: PrepPack = {
    ...pack,
    alignment,
    questions,
    crux: pack.crux.length > 0 ? pack.crux : ['简历信息不足，赛前请 HR 补齐关键经历'],
    redFlagChecks:
      pack.redFlagChecks.length > 0 ? pack.redFlagChecks : ['赛前请确认候选人最近一段经历的具体职责与结果'],
    carryOver: pack.carryOver ?? [],
  };
  ctx.store.savePrepPack(next);
  return { pack: next, removed, added };
}

export function prepQuestionCount(pack: PrepPack): number {
  return pack.questions.length;
}

export function prepToolOrder(run: AgentRun): string[] {
  return stepsOf(run, 'validate_pack').map((s) => (s.ok ? 'ok' : 'fail'));
}
