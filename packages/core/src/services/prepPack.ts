import { DomainError } from '../errors.js';
import type { Interview, PrepPack, PrepPackQuestion } from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from './context.js';
import { carryOverFromLedger, syncLedgerFromHistory } from '../agent/ledger.js';

export class PrepPackService {
  constructor(private readonly ctx: ServiceContext) {}

  private require(interviewId: string): Interview {
    const i = this.ctx.store.findInterview(interviewId);
    if (!i) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { interviewId });
    return i;
  }

  /** Ingests a resume; parses into structured fields or flags parseFailed for the degraded path. */
  submitResume(actor: Actor, candidateId: string, rawText: string): { parseFailed: boolean; summary: string | null } {
    const c = this.ctx.store.findCandidate(candidateId);
    if (!c) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除', { candidateId });
    const trimmed = rawText.trim();
    const looksStructured = /@|mailto|电话|手机|邮箱|年|公司|项目/i.test(trimmed);
    const parseFailed = trimmed.length < 40 || !looksStructured;
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    // Names without a company suffix (青禾数据) only surface when the line starts with a date range.
    // Education lines are excluded so a university is never counted as an employer.
    const experienceLines = lines.filter((l) => !/(大学|学院|本科|硕士|博士|学校|University|College)/i.test(l));
    const datedCompanies = experienceLines
      .flatMap((l) =>
        Array.from(
          l.matchAll(
            /(?:19|20)\d{2}\s*[.\-/年]\s*(?:0?[1-9]|1[0-2])?\s*月?\s*[-–—~至]\s*(?:(?:19|20)\d{2}\s*[.\-/年]\s*(?:0?[1-9]|1[0-2])?\s*月?|至今|现在)\s*([^\s，,、|/）)]{2,30})/g,
          ),
          (m) => m[1] ?? '',
        ),
      )
      .filter((s) => s.length >= 2);
    const suffixedCompanies = experienceLines.flatMap(
      (l) => l.match(/[\u4e00-\u9fa5A-Za-z0-9]+(?:公司|科技|集团|网络|信息技术|Bank|Tech|Inc|Ltd|Corp)/g) ?? [],
    );
    const companies = Array.from(new Set([...datedCompanies, ...suffixedCompanies])).slice(0, 8);
    const titles = Array.from(new Set(lines.filter((l) => /(工程师|经理|主管|架构师|设计师|分析师|总监|Developer|Engineer|Manager)/.test(l)).map((l) => l.slice(0, 40)))).slice(0, 6);
    const years = trimmed.match(/(\d{1,2})\s*年(?:经验|工作)/);
    const summary = parseFailed ? null : lines.slice(0, 6).join(' ');

    this.ctx.store.saveCandidate({
      ...c,
      resume: {
        rawText: trimmed,
        summary,
        companies,
        titles,
        yearsOfExperience: years ? Number(years[1]) : null,
        education: lines.filter((l) => /(大学|学院|本科|硕士|博士|University|College)/.test(l)).slice(0, 4),
        parseFailed,
      },
    });
    recordAudit(this.ctx, actor, 'resume.submit', 'Candidate', candidateId, c.orgId, { parseFailed });
    return { parseFailed, summary };
  }

  async build(actor: Actor, interviewId: string): Promise<PrepPack> {
    const i = this.require(interviewId);
    const standard = this.ctx.store.findStandard(i.standardId);
    if (!standard || standard.status !== 'confirmed') {
      throw new DomainError('standard_not_confirmed', `岗位金标准尚未定稿，无法生成准备包`, { standardId: i.standardId });
    }
    const candidate = this.ctx.store.findCandidate(i.candidateId);
    if (!candidate) throw new DomainError('candidate_not_found', '这个候选人不存在或已被删除');
    const job = this.ctx.store.findJob(i.jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在');

    const degraded = candidate.resume.parseFailed;
    const result = await this.ctx.llm.buildPrepPack({
      candidateName: candidate.name,
      resumeText: degraded ? `${candidate.resume.summary ?? ''}\n(HR 需手动补充)` : candidate.resume.rawText,
      parseFailed: degraded,
      round: i.round,
      intake: standard.intake ?? { jobTitle: job.title, level: job.level ?? '', reportsTo: job.reportsTo ?? '', teamSize: job.teamSize ?? 0, painPoints: '', description: job.description },
      dimensions: standard.dimensions.map((d) => ({
        id: d.id,
        name: d.name,
        positiveEvidence: d.positiveEvidence,
        redFlags: d.redFlags,
        probes: d.probes,
        matchKeywords: d.matchKeywords,
      })),
    });

    const nameById = new Map(standard.dimensions.map((d) => [d.id, d.name]));
    /** Memory is rebuilt from submitted reviews, then read; the ledger is the only carry-over source. */
    const ledger = syncLedgerFromHistory(this.ctx, candidate.id, i.jobId);
    const carryOver = carryOverFromLedger(ledger, i.round, nameById);
    const carried = new Set(carryOver.map((c) => c.dimensionId));
    const carryQuestions: PrepPackQuestion[] = carryOver.flatMap((c) => {
      const probe = standard.dimensions.find((d) => d.id === c.dimensionId)?.probes[0];
      return probe
        ? [{ id: makeId(this.ctx, 'qst'), text: probe, dimensionId: c.dimensionId, why: `第 ${c.fromRound} 轮${c.reason}，这轮先补问`, source: 'standard' as const, addedBy: null }]
        : [];
    });
    const seenText = new Set<string>();
    const questions: PrepPackQuestion[] = [
      ...carryQuestions,
      ...result.questions.map((q) => ({
        id: makeId(this.ctx, 'qst'),
        text: q.text,
        dimensionId: q.dimensionId,
        why: q.why,
        source: 'ai' as const,
        addedBy: null,
      })),
    ].filter((q) => {
      const key = q.text.trim().toLowerCase();
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    });

    const pack: PrepPack = {
      id: makeId(this.ctx, 'pck'),
      interviewId,
      candidateId: candidate.id,
      standardId: standard.id,
      generatedAt: nowIso(this.ctx),
      aiModel: result.model,
      crux: result.crux,
      alignment: result.alignment.map((a) => ({
        ...a,
        dimensionName: nameById.get(a.dimensionId) ?? a.dimensionId,
        mark: carried.has(a.dimensionId) ? 'needs_probe' : a.mark,
      })),
      questions,
      carryOver,
      redFlagChecks: degraded
        ? ['简历解析失败：请 HR 手动补齐关键经历后再判断', ...result.redFlagChecks]
        : result.redFlagChecks,
      degraded,
      degradedReason: degraded ? '候选人简历解析失败（PDF/扫描件），已切半自动生成' : null,
    };
    this.ctx.store.savePrepPack(pack);
    recordAudit(this.ctx, actor, 'prep_pack.build', 'PrepPack', pack.id, i.orgId, {
      model: result.model,
      degraded,
      dimensions: pack.alignment.length,
    });
    return pack;
  }

  /** 面试官可补充自己的提纲，与考察维度关联，赛中用于识别是否问到。 */
  addInterviewerQuestion(actor: Actor, interviewId: string, text: string, dimensionId: string | null): PrepPack {
    if (actor.kind !== 'human') throw new DomainError('human_only', '提纲补充必须由面试官本人完成');
    const pack = this.ctx.store.latestPrepPack(interviewId);
    if (!pack) throw new DomainError('no_prep_pack', '还没有准备包，无法补充提纲');
    const standard = this.ctx.store.findStandard(pack.standardId);
    if (dimensionId && !standard?.dimensions.some((d) => d.id === dimensionId)) {
      throw new DomainError('dimension_mismatch', '这条追问挂靠的考察维度不在定稿的金标准里，请重新选一个维度', { dimensionId });
    }
    const next: PrepPack = {
      ...pack,
      questions: [...pack.questions, { id: makeId(this.ctx, 'qst'), text, dimensionId, why: '面试官自定义', source: 'interviewer', addedBy: actor.userId }],
    };
    this.ctx.store.savePrepPack(next);
    recordAudit(this.ctx, actor, 'prep_pack.add_question', 'PrepPack', next.id, this.require(interviewId).orgId, { text, dimensionId });
    return next;
  }

  /** HR can veto a question that steps on a compliance landmine (e.g. 婚育). */
  vetoQuestion(actor: Actor, interviewId: string, questionId: string, reason: string): PrepPack {
    if (actor.kind !== 'human' || actor.role !== 'hr') throw new DomainError('hr_only', '只有 HR 能否决追问');
    const pack = this.ctx.store.latestPrepPack(interviewId);
    if (!pack) throw new DomainError('no_prep_pack', '没有准备包');
    const target = pack.questions.find((q) => q.id === questionId);
    if (!target) throw new DomainError('question_not_found', '这条追问已经不在准备包里');
    const next: PrepPack = {
      ...pack,
      questions: pack.questions.filter((q) => q.id !== questionId),
      redFlagChecks: [...pack.redFlagChecks, `已由 HR 否决追问「${target.text}」：${reason}`],
    };
    this.ctx.store.savePrepPack(next);
    recordAudit(this.ctx, actor, 'prep_pack.veto_question', 'PrepPack', next.id, this.require(interviewId).orgId, { questionId, reason });
    return next;
  }

  /** 赛前 1h: 合并多位面试官补充的提纲，去重并标注谁会问哪个维度。 */
  mergePanelPacks(interviewId: string): { merged: PrepPackQuestion[] } {
    const pack = this.ctx.store.latestPrepPack(interviewId);
    if (!pack) return { merged: [] };
    const seen = new Set<string>();
    const merged = pack.questions.filter((q) => {
      const key = `${q.dimensionId ?? ''}|${q.text.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { merged };
  }
}
