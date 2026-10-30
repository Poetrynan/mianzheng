import { DomainError } from '../errors.js';
import type { FeedbackDraft, Interview, JobIntake, JobStandard, PrepPack } from '../types.js';
import { type Actor, type ServiceContext, makeId, nowIso, recordAudit } from '../services/context.js';
import type { GoldenStandardService } from '../services/goldenStandard.js';
import type { PrepPackService } from '../services/prepPack.js';
import type { EvaluationService } from '../services/evaluation.js';
import { answerAgentQuestion, driveAgent } from './runtime.js';
import { StandardAgentDriver } from './standardAgent.js';
import { PrepAgentDriver } from './prepAgent.js';
import { EvaluationAgentDriver } from './evaluationAgent.js';
import { syncLedgerFromHistory } from './ledger.js';
import type { AgentPhase, AgentRun, AgentSubject, EvidenceLedgerEntry } from './types.js';

export interface AgentBundle {
  run: AgentRun;
  standard?: JobStandard;
  pack?: PrepPack;
  draft?: FeedbackDraft;
}

export interface AgentDeps {
  goldenStandard: GoldenStandardService;
  prepPack: PrepPackService;
  evaluation: EvaluationService;
}

const GOALS: Record<AgentPhase, string> = {
  standard: '用尽量少的轮次，问出 4-7 个能落到证据上的考察维度',
  prep: '把上一轮没问清的缺口带进这一场，给出一页能直接照着问的提纲',
  evaluation: '每个维度要么找到原话，要么标成缺口，不替人下结论',
};

const BUDGETS: Record<AgentPhase, number> = { standard: 32, prep: 16, evaluation: 44 };

export class AgentService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: AgentDeps,
  ) {}

  private save = (run: AgentRun): void => {
    this.ctx.store.saveAgentRun(run);
  };

  private createRun(phase: AgentPhase, orgId: string, subject: AgentSubject, interviewerId: string | null): AgentRun {
    const now = nowIso(this.ctx);
    return {
      id: makeId(this.ctx, 'run'),
      orgId,
      phase,
      goal: GOALS[phase],
      subject,
      status: 'running',
      steps: [],
      budget: { maxSteps: BUDGETS[phase] },
      question: null,
      result: null,
      stopReason: null,
      llm: { driver: this.ctx.llm.driver, model: this.ctx.llm.model },
      interviewerId,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    };
  }

  private requireRun(runId: string): AgentRun {
    const run = this.ctx.store.findAgentRun(runId);
    if (!run) throw new DomainError('agent_run_not_found', '这次助手任务不存在或已被删除', { runId });
    return run;
  }

  getRun(runId: string): AgentRun {
    return this.requireRun(runId);
  }

  /** Re-opening a task after a refresh needs the artifacts, not just the step list. */
  getBundle(runId: string): AgentBundle {
    return this.bundle(this.requireRun(runId));
  }

  listRunsForInterview(interviewId: string): AgentRun[] {
    return this.ctx.store.listAgentRunsByRef(interviewId).filter((r) => r.subject.interviewId === interviewId);
  }

  listRunsForJob(jobId: string): AgentRun[] {
    return this.ctx.store.listAgentRunsByRef(jobId).filter((r) => r.subject.jobId === jobId);
  }

  ledgerFor(candidateId: string, jobId: string): EvidenceLedgerEntry[] {
    return syncLedgerFromHistory(this.ctx, candidateId, jobId);
  }

  private bundle(run: AgentRun): AgentBundle {
    const standard = run.subject.standardId ? this.ctx.store.findStandard(run.subject.standardId) : undefined;
    const interviewId = run.subject.interviewId;
    const pack = interviewId ? this.ctx.store.latestPrepPack(interviewId) : undefined;
    const draft = run.result?.draftId ? this.ctx.store.findDraft(run.result.draftId) : undefined;
    return { run, standard, pack, draft };
  }

  async startStandard(actor: Actor, jobId: string, intake: JobIntake): Promise<AgentBundle> {
    const job = this.ctx.store.findJob(jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在', { jobId });
    const standard = this.deps.goldenStandard.startIntake(actor, jobId, intake);
    const run = this.createRun(
      'standard',
      job.orgId,
      { jobId, candidateId: null, interviewId: null, standardId: standard.id },
      null,
    );
    this.save(run);
    recordAudit(this.ctx, actor, 'agent.run.start', 'AgentRun', run.id, run.orgId, { phase: run.phase, goal: run.goal });

    const driver = new StandardAgentDriver(this.ctx, this.deps.goldenStandard, actor);
    const finished = await driveAgent(this.ctx, run, driver, actor, this.save);
    return { ...this.bundle(finished), standard: this.ctx.store.findStandard(standard.id) };
  }

  async startPrep(actor: Actor, interviewId: string): Promise<AgentBundle> {
    const interview = this.requireInterview(interviewId);
    const standard = this.ctx.store.findStandard(interview.standardId);
    if (!standard || standard.status !== 'confirmed') {
      throw new DomainError('standard_not_confirmed', '岗位金标准尚未定稿，无法生成一页纸', { standardId: interview.standardId });
    }
    const run = this.createRun(
      'prep',
      interview.orgId,
      { jobId: interview.jobId, candidateId: interview.candidateId, interviewId, standardId: interview.standardId },
      null,
    );
    this.save(run);
    recordAudit(this.ctx, actor, 'agent.run.start', 'AgentRun', run.id, run.orgId, { phase: run.phase, goal: run.goal });

    const driver = new PrepAgentDriver(this.ctx, this.deps.prepPack, actor);
    const finished = await driveAgent(this.ctx, run, driver, actor, this.save);
    return this.bundle(finished);
  }

  async startEvaluation(actor: Actor, interviewId: string, interviewerId?: string): Promise<AgentBundle> {
    const interview = this.requireInterview(interviewId);
    if (interview.status !== 'eval_pending' && interview.status !== 'expired') {
      throw new DomainError('wrong_state', '这场面试还没到写面评的阶段，先结束面试再来起草', { status: interview.status });
    }
    const standard = this.ctx.store.findStandard(interview.standardId);
    if (!standard || standard.status !== 'confirmed') {
      throw new DomainError('standard_not_confirmed', '岗位金标准未定稿，不能起草面评', { standardId: interview.standardId });
    }
    if (this.ctx.store.listSegments(interviewId).length === 0) {
      throw new DomainError('no_transcript', '没有转写内容，无法生成草稿，请改用人工笔记直接填写');
    }
    const assigned =
      interviewerId ?? (actor.kind === 'human' ? actor.userId : interview.interviewerIds[0] ?? null);
    const run = this.createRun(
      'evaluation',
      interview.orgId,
      { jobId: interview.jobId, candidateId: interview.candidateId, interviewId, standardId: interview.standardId },
      assigned,
    );
    this.save(run);
    recordAudit(this.ctx, actor, 'agent.run.start', 'AgentRun', run.id, run.orgId, {
      phase: run.phase,
      goal: run.goal,
      interviewerId: assigned,
    });

    const driver = new EvaluationAgentDriver(
      this.ctx,
      this.deps.evaluation,
      actor,
      assigned ?? (actor.kind === 'human' ? actor.userId : ''),
    );
    const finished = await driveAgent(this.ctx, run, driver, actor, this.save);
    return this.bundle(finished);
  }

  async answer(runId: string, actor: Actor, answer: string): Promise<AgentBundle> {
    const run = this.requireRun(runId);
    const driver = this.driverFor(run, actor);
    const resumed = await answerAgentQuestion(this.ctx, run, driver, actor, answer, this.save);
    const finished = await driveAgent(this.ctx, resumed, driver, actor, this.save);
    return this.bundle(finished);
  }

  private driverFor(run: AgentRun, actor: Actor) {
    switch (run.phase) {
      case 'standard':
        return new StandardAgentDriver(this.ctx, this.deps.goldenStandard, actor);
      case 'prep':
        return new PrepAgentDriver(this.ctx, this.deps.prepPack, actor);
      case 'evaluation': {
        const assigned = run.interviewerId ?? (actor.kind === 'human' ? actor.userId : '');
        return new EvaluationAgentDriver(this.ctx, this.deps.evaluation, actor, assigned);
      }
    }
  }

  private requireInterview(interviewId: string): Interview {
    const interview = this.ctx.store.findInterview(interviewId);
    if (!interview) throw new DomainError('interview_not_found', '这场面试不存在或已被删除', { interviewId });
    return interview;
  }
}
