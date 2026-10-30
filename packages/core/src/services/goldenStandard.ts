import { ComplianceError, DomainError } from '../errors.js';
import { assertNoProtectedAttributes } from '../compliance/protectedAttributes.js';
import { assertTransition, STANDARD_TRANSITIONS } from '../states.js';
import type { JobIntake, JobStandard, StandardConflict, StandardDimension } from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from './context.js';
import { STANDARD_INTERVIEW_SCRIPT } from '../ai/mockLlm.js';
import { DIMENSION_LIBRARY, defaultDimensions, libraryByKeyword } from '../ai/dimensionLibrary.js';

export const MIN_DIMENSIONS = 4;
export const MAX_DIMENSIONS = 7;
/** PRD 3.1: the same dimension reworked three times means the design needs a human expert. */
export const REVISION_ESCALATION_THRESHOLD = 3;

export interface ProposeResult {
  standard: JobStandard;
  escalationHints: string[];
  conflicts: StandardConflict[];
}

export class GoldenStandardService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireStandard(id: string): JobStandard {
    const std = this.ctx.store.findStandard(id);
    if (!std) throw new DomainError('standard_not_found', '这个岗位还没有金标准', { id });
    return std;
  }

  /** Step 1 of PRD 3.1: the 5-minute HR intake form, before any AI questioning. */
  startIntake(actor: Actor, jobId: string, intake: JobIntake): JobStandard {
    const job = this.ctx.store.findJob(jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在', { jobId });
    assertNoProtectedAttributes('岗位访谈表', { intake });

    const std: JobStandard = {
      id: makeId(this.ctx, 'std'),
      jobId,
      orgId: job.orgId,
      version: 'v0.0',
      status: 'draft',
      dimensions: [],
      createdBy: actor.kind === 'human' ? actor.userId : 'system',
      confirmedByHiringManager: null,
      confirmedByHr: null,
      createdAt: nowIso(this.ctx),
      updatedAt: nowIso(this.ctx),
      intake,
      answers: [],
      revisionCounts: {},
      conflicts: [],
    };
    this.ctx.store.saveStandard(std);
    recordAudit(this.ctx, actor, 'standard.intake', 'JobStandard', std.id, job.orgId, { jobId, intake });
    return std;
  }

  /** The AI interviewer asks the script in order and stops when the round budget is used up. */
  nextQuestion(standardId: string): string | null {
    const std = this.requireStandard(standardId);
    const asked = new Set(std.answers.map((a) => a.question));
    return STANDARD_INTERVIEW_SCRIPT.find((q) => !asked.has(q)) ?? null;
  }

  recordAnswer(actor: Actor, standardId: string, question: string, answer: string): { standard: JobStandard; nextQuestion: string | null } {
    const std = this.requireStandard(standardId);
    if (std.status !== 'draft') throw new DomainError('standard_locked', '金标准已定稿，不能再补录访谈回答', { status: std.status });
    assertNoProtectedAttributes('访谈回答', { answer });
    const withAnswer: JobStandard = {
      ...std,
      answers: [...std.answers, { question, answer, by: actor.kind === 'human' ? actor.userId : 'ai' }],
      updatedAt: nowIso(this.ctx),
    };
    this.ctx.store.saveStandard(withAnswer);
    recordAudit(this.ctx, actor, 'standard.answer', 'JobStandard', standardId, std.orgId, { question });
    return { standard: withAnswer, nextQuestion: this.nextQuestion(standardId) };
  }

  /** Step 3-4: extract dimensions from the collected answers and produce a reviewable draft. */
  async proposeDraft(actor: Actor, standardId: string): Promise<ProposeResult> {
    const std = this.requireStandard(standardId);
    const job = this.ctx.store.findJob(std.jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在', { jobId: std.jobId });
    if (!std.intake) throw new DomainError('intake_required', '请先完成 5 分钟岗位填表，再让 AI 访谈官提问');
    if (std.answers.length < 2) {
      throw new DomainError('not_enough_answers', `至少需要 ${2} 轮用人经理回答才能提取金标准`, {
        have: std.answers.length,
      });
    }

    const result = await this.ctx.llm.extractStandard({
      intake: std.intake,
      answers: std.answers,
      requestDraft: true,
    });
    const drafts = result.dimensions.slice(0, MAX_DIMENSIONS);
    if (drafts.length < MIN_DIMENSIONS) {
      throw new DomainError('too_few_dimensions', `只提取到 ${drafts.length} 个维度，至少需要 ${MIN_DIMENSIONS} 个，请继续访谈或改用模板库`, {
        found: drafts.length,
      });
    }

    const minor = Number(std.version.split('.')[1] ?? '0');
    const version = `v0.${(Number.isNaN(minor) ? 0 : minor) + 1}`;
    const dimensions: StandardDimension[] = drafts.map((d) => {
      assertNoProtectedAttributes(`考察维度「${d.name}」`, { ...d });
      return {
        id: makeId(this.ctx, 'dim'),
        standardId,
        name: d.name,
        positiveEvidence: d.positiveEvidence,
        redFlags: d.redFlags,
        probes: d.probes,
        matchKeywords: d.matchKeywords.length > 0 ? d.matchKeywords : [d.name],
        createdBy: `ai:${result.model}`,
        confirmedBy: null,
      };
    });

    const conflicts = this.detectConflicts(job.description, dimensions);
    const next: JobStandard = { ...std, version, dimensions, conflicts, updatedAt: nowIso(this.ctx) };
    this.ctx.store.saveStandard(next);
    recordAudit(this.ctx, actor, 'standard.propose', 'JobStandard', standardId, std.orgId, {
      version,
      dimensions: dimensions.map((d) => d.name),
      model: result.model,
    });

    const escalationHints = dimensions
      .filter((d) => (std.revisionCounts[d.id] ?? 0) >= REVISION_ESCALATION_THRESHOLD)
      .map((d) => `维度「${d.name}」已被反复修改 ${std.revisionCounts[d.id]} 次，建议让 HR 或外部专家介入设计`);

    return { standard: next, escalationHints, conflicts };
  }

  /** PRD 3.1 异常兜底: 用人经理没空时，HR 用通用词库一键生成模板再改。 */
  createFromTemplateLibrary(actor: Actor, jobId: string, freeText: string): JobStandard {
    const job = this.ctx.store.findJob(jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在', { jobId });
    const picked = [...libraryByKeyword(`${job.title} ${job.description} ${freeText}`, MAX_DIMENSIONS)];
    for (const fallback of defaultDimensions(MAX_DIMENSIONS)) {
      if (picked.length >= MIN_DIMENSIONS) break;
      if (!picked.some((p) => p.name === fallback.name)) picked.push(fallback);
    }
    const dimensions: StandardDimension[] = picked.slice(0, MAX_DIMENSIONS).map((entry) => ({
      id: makeId(this.ctx, 'dim'),
      standardId: '',
      name: entry.name,
      positiveEvidence: [...entry.positiveEvidence],
      redFlags: [...entry.redFlags],
      probes: [...entry.probes],
      matchKeywords: [...entry.matchKeywords],
      createdBy: 'template_library',
      confirmedBy: null,
    }));

    const std: JobStandard = {
      id: makeId(this.ctx, 'std'),
      jobId,
      orgId: job.orgId,
      version: 'v0.1',
      status: 'draft',
      dimensions: dimensions.map((d) => ({ ...d })),
      createdBy: actor.kind === 'human' ? actor.userId : 'system',
      confirmedByHiringManager: null,
      confirmedByHr: null,
      createdAt: nowIso(this.ctx),
      updatedAt: nowIso(this.ctx),
      intake: { jobTitle: job.title, level: job.level ?? '', reportsTo: job.reportsTo ?? '', teamSize: job.teamSize ?? 0, painPoints: freeText, description: job.description },
      answers: [],
      revisionCounts: {},
      conflicts: this.detectConflicts(job.description, dimensions),
    };
    std.dimensions = std.dimensions.map((d) => ({ ...d, standardId: std.id }));
    this.ctx.store.saveStandard(std);
    recordAudit(this.ctx, actor, 'standard.from_template', 'JobStandard', std.id, job.orgId, {
      dimensions: std.dimensions.map((x) => x.name),
      librarySize: DIMENSION_LIBRARY.length,
    });
    return std;
  }

  private detectConflicts(jobDescription: string, dimensions: StandardDimension[]): StandardConflict[] {
    const jd = jobDescription.toLowerCase();
    const conflicts: StandardConflict[] = [];
    for (const dim of dimensions) {
      const inJd = dim.matchKeywords.some((k) => jd.includes(k.toLowerCase())) || jd.includes(dim.name.toLowerCase());
      if (!inJd) {
        conflicts.push({
          dimensionId: dim.id,
          note: `维度「${dim.name}」在职位描述里没有对应表述，请确认保留访谈提取的金标准还是回到职位描述`,
          resolved: null,
        });
      }
    }
    return conflicts;
  }

  resolveConflict(actor: Actor, standardId: string, dimensionId: string, side: StandardConflict['resolved']): JobStandard {
    if (actor.kind !== 'human' || actor.role !== 'hr') {
      throw new DomainError('hr_only', '维度与职位描述冲突只能由 HR 裁定保留哪一侧', { actor });
    }
    if (side === null) throw new DomainError('resolution_required', '必须明确选择保留金标准或保留职位描述');
    const std = this.requireStandard(standardId);
    const conflicts = std.conflicts.map((c) => (c.dimensionId === dimensionId ? { ...c, resolved: side } : c));
    const next = { ...std, conflicts, updatedAt: nowIso(this.ctx) };
    this.ctx.store.saveStandard(next);
    recordAudit(this.ctx, actor, 'standard.conflict_resolved', 'JobStandard', standardId, std.orgId, { dimensionId, side });
    return next;
  }

  reviseDimension(
    actor: Actor,
    standardId: string,
    dimensionId: string,
    patch: Partial<Pick<StandardDimension, 'name' | 'positiveEvidence' | 'redFlags' | 'probes' | 'matchKeywords'>>,
    overrideReason?: string,
  ): { standard: JobStandard; escalationHint: string | null; guardHits: string[] } {
    const std = this.requireStandard(standardId);
    if (std.status !== 'draft') throw new DomainError('standard_locked', '金标准已定稿，如需修改请创建新版本', { status: std.status });
    const guard = assertNoProtectedAttributes(`考察维度修订「${patch.name ?? dimensionId}」`, { ...patch }, overrideReason);
    const guardHits = guard.hits.map((h) => `${h.category}:${h.term}`);

    const dim = std.dimensions.find((x) => x.id === dimensionId);
    if (!dim) throw new DomainError('dimension_not_found', '这个考察维度不在当前金标准里', { dimensionId });

    const revised = std.dimensions.map((x) => (x.id === dimensionId ? { ...x, ...patch } : x));
    const count = (std.revisionCounts[dimensionId] ?? 0) + 1;
    /** Any edit invalidates that dimension's confirmation. */
    const next: JobStandard = {
      ...std,
      dimensions: revised,
      revisionCounts: { ...std.revisionCounts, [dimensionId]: count },
      updatedAt: nowIso(this.ctx),
    };
    next.dimensions = next.dimensions.map((x) => (x.id === dimensionId ? { ...x, confirmedBy: null } : x));
    this.ctx.store.saveStandard(next);
    recordAudit(this.ctx, actor, 'standard.revise_dimension', 'JobStandard', standardId, std.orgId, {
      dimensionId,
      patch,
      revisionCount: count,
      flaggedForAudit: guard.hits,
    });
    const hint =
      count >= REVISION_ESCALATION_THRESHOLD
        ? `维度「${dim.name}」已第 ${count} 次修改，建议让 HR 或外部专家介入设计`
        : null;
    return { standard: next, escalationHint: hint, guardHits };
  }

  /** 用人经理必须逐项确认，AI 默认输出不会直接生效。 */
  confirmDimension(actor: Actor, standardId: string, dimensionId: string): JobStandard {
    if (actor.kind !== 'human') throw new DomainError('human_only', '维度确认必须由人完成');
    const std = this.requireStandard(standardId);
    const dim = std.dimensions.find((x) => x.id === dimensionId);
    if (!dim) throw new DomainError('dimension_not_found', '这个考察维度不在当前金标准里', { dimensionId });
    const dimensions = std.dimensions.map((x) => (x.id === dimensionId ? { ...x, confirmedBy: actor.userId } : x));
    const next = { ...std, dimensions, updatedAt: nowIso(this.ctx) };
    this.ctx.store.saveStandard(next);
    recordAudit(this.ctx, actor, 'standard.confirm_dimension', 'JobStandard', standardId, std.orgId, { dimensionId });
    return next;
  }

  sign(actor: Actor, standardId: string, party: 'hiring_manager' | 'hr'): JobStandard {
    if (actor.kind !== 'human') throw new DomainError('human_only', '定稿签署必须由人完成');
    /** 两栏签的是「两个视角」，不是两次点击：谁签只能签自己那一栏，一个人替两边签字，闸门就退化成一个人。 */
    if (actor.role !== party) {
      throw new DomainError('sign_role_mismatch', '这一栏只能由对应角色自己签署：用人经理签用人经理那一栏，HR 签 HR 那一栏');
    }
    const std = this.requireStandard(standardId);
    const next: JobStandard = {
      ...std,
      confirmedByHiringManager: party === 'hiring_manager' ? actor.userId : std.confirmedByHiringManager,
      confirmedByHr: party === 'hr' ? actor.userId : std.confirmedByHr,
      updatedAt: nowIso(this.ctx),
    };
    this.ctx.store.saveStandard(next);
    recordAudit(this.ctx, actor, `standard.sign.${party}`, 'JobStandard', standardId, std.orgId, {});
    return next;
  }

  /** v1.0 gate: every dimension confirmed by a person, both parties signed, no open conflict. */
  finalize(actor: Actor, standardId: string): JobStandard {
    const std = this.requireStandard(standardId);
    assertTransition(STANDARD_TRANSITIONS, std.status, 'confirmed', 'JobStandard');

    const unconfirmed = std.dimensions.filter((d) => d.confirmedBy === null);
    if (unconfirmed.length > 0) {
      throw new DomainError('dimensions_unconfirmed', `还有 ${unconfirmed.length} 个维度未被逐项确认：${unconfirmed.map((d) => d.name).join('、')}`, {
        unconfirmed: unconfirmed.map((d) => d.id),
      });
    }
    const openConflict = std.conflicts.find((c) => c.resolved === null);
    if (openConflict) {
      const name = std.dimensions.find((d) => d.id === openConflict.dimensionId)?.name ?? openConflict.dimensionId;
      throw new DomainError('conflict_unresolved', `维度「${name}」与职位描述的冲突还没裁定，HR 必须先选择保留哪一侧`, {
        conflict: openConflict,
      });
    }
    if (!std.confirmedByHiringManager) throw new DomainError('needs_hiring_manager_signature', '用人经理必须签署，不能让 AI 输出直接生效');
    if (!std.confirmedByHr) throw new DomainError('needs_hr_signature', 'HR 必须看到金标准定稿并确认，避免单一视角偏差');

    for (const previous of this.ctx.store.listStandardsForJob(std.jobId)) {
      if (previous.id !== std.id && previous.status === 'confirmed') {
        this.ctx.store.saveStandard({ ...previous, status: 'archived', updatedAt: nowIso(this.ctx) });
      }
    }

    const next: JobStandard = { ...std, version: 'v1.0', status: 'confirmed', updatedAt: nowIso(this.ctx) };
    this.ctx.store.saveStandard(next);
    const job = this.ctx.store.findJob(std.jobId);
    if (job) this.ctx.store.saveJob({ ...job, confirmedStandardId: next.id, updatedBy: actor.kind === 'human' ? actor.userId : 'system', updatedAt: nowIso(this.ctx) });
    recordAudit(this.ctx, actor, 'standard.finalize', 'JobStandard', standardId, std.orgId, { version: 'v1.0' });
    return next;
  }

  requireConfirmed(standardId: string): JobStandard {
    const std = this.requireStandard(standardId);
    if (std.status !== 'confirmed') {
      throw new ComplianceError('standard_not_confirmed', `岗位金标准尚未定稿（当前 ${std.version} / ${std.status}），不能生成准备包或面评草稿`, {
        standardId,
        status: std.status,
      });
    }
    return std;
  }
}
