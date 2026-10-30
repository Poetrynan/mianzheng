import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { createSqlDriver } from './db/driver.js';
import { Store } from './db/store.js';
import { defaultIdGenerator, type IdGenerator } from './ids.js';
import type { LlmProvider } from './ai/llm.js';
import type { TranscriptionProvider } from './ai/asr.js';
import { DEFAULT_RETENTION, type RetentionPolicy } from './compliance/retention.js';
import type { Candidate, Job, JobIntake, Org, Role, User } from './types.js';
import { createContext, humanActor, type Notifier, type ServiceContext, makeId, nowIso, systemActor, InMemoryNotifier } from './services/context.js';
import { GoldenStandardService } from './services/goldenStandard.js';
import { PrepPackService } from './services/prepPack.js';
import { InterviewFlowService } from './services/interviewFlow.js';
import { EvaluationService } from './services/evaluation.js';
import { ReminderService } from './services/reminders.js';
import { BoardService } from './services/board.js';
import { ComplianceService } from './services/compliance.js';
import { AuthService } from './auth.js';
import { AgentService } from './agent/service.js';

export interface OpenOptions {
  dbPath?: string;
  clock?: Clock;
  llm: LlmProvider;
  asr: TranscriptionProvider;
  notifier?: Notifier;
  ids?: IdGenerator;
  retention?: RetentionPolicy;
}

/** Single wiring point: every service shares one context, so time and identity are consistent. */
export class MianYanApp {
  readonly ctx: ServiceContext;
  readonly goldenStandard: GoldenStandardService;
  readonly prepPack: PrepPackService;
  readonly flow: InterviewFlowService;
  readonly evaluation: EvaluationService;
  readonly reminders: ReminderService;
  readonly board: BoardService;
  readonly compliance: ComplianceService;
  readonly auth: AuthService;
  readonly agent: AgentService;

  private constructor(readonly store: Store, ctx: ServiceContext) {
    this.ctx = ctx;
    this.goldenStandard = new GoldenStandardService(ctx);
    this.prepPack = new PrepPackService(ctx);
    this.flow = new InterviewFlowService(ctx);
    this.evaluation = new EvaluationService(ctx);
    this.reminders = new ReminderService(ctx);
    this.board = new BoardService(ctx);
    this.compliance = new ComplianceService(ctx);
    this.auth = new AuthService(ctx);
    this.agent = new AgentService(ctx, {
      goldenStandard: this.goldenStandard,
      prepPack: this.prepPack,
      evaluation: this.evaluation,
    });
  }

  static async open(options: OpenOptions): Promise<MianYanApp> {
    const path = options.dbPath ?? ':memory:';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const driver = await createSqlDriver(path);
    const store = Store.create(driver);
    const ctx = createContext({
      store,
      clock: options.clock ?? systemClock,
      llm: options.llm,
      asr: options.asr,
      notifier: options.notifier ?? new InMemoryNotifier(),
      ids: options.ids ?? defaultIdGenerator,
      retention: options.retention ?? DEFAULT_RETENTION,
    });
    return new MianYanApp(store, ctx);
  }

  // ---- tenancy seeding ----
  createOrg(name: string, complianceTemplateId = 'pipl-v1'): Org {
    const org: Org = { id: makeId(this.ctx, 'org'), name, atsType: null, complianceTemplateId, status: 'active' };
    this.store.saveOrg(org);
    return org;
  }

  addUser(orgId: string, role: Role, name: string, email?: string): User {
    const user: User = { id: makeId(this.ctx, 'usr'), orgId, role, name, email };
    this.store.saveUser(user);
    return user;
  }

  createJob(orgId: string, input: JobIntake & { description: string }): Job {
    const job: Job = {
      id: makeId(this.ctx, 'job'),
      orgId,
      title: input.jobTitle,
      level: input.level,
      reportsTo: input.reportsTo,
      teamSize: input.teamSize,
      description: input.description,
      status: 'open',
      confirmedStandardId: null,
      updatedBy: 'system:seed',
      updatedAt: nowIso(this.ctx),
    };
    this.store.saveJob(job);
    return job;
  }

  addCandidate(orgId: string, jobId: string, name: string, resumeText: string): Candidate {
    const candidate: Candidate = {
      id: makeId(this.ctx, 'cnd'),
      orgId,
      name,
      appliedJobId: jobId,
      status: 'screening',
      resume: { rawText: '', summary: null, companies: [], titles: [], yearsOfExperience: null, education: [], parseFailed: true },
      deletedAt: null,
      createdAt: nowIso(this.ctx),
    };
    this.store.saveCandidate(candidate);
    const hr = this.store.listUsers(orgId).find((u) => u.role === 'hr');
    this.prepPack.submitResume(hr ? humanActor(hr) : systemActor('seed'), candidate.id, resumeText);
    return this.store.findCandidate(candidate.id) as Candidate;
  }
}
