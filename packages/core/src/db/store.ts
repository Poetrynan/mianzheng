import type { SqlDriver } from './driver.js';
import { SCHEMA_SQL } from './schema.js';
import type {
  AuditEntry,
  Candidate,
  ConsentRecord,
  FeedbackDraft,
  Interview,
  Job,
  JobStandard,
  Org,
  PrepPack,
  ReminderEvent,
  StandardDimensionCheck,
  TranscriptSegment,
  User,
} from '../types.js';
import type { AgentRun, EvidenceLedgerEntry } from '../agent/types.js';

export type RecordKind =
  | 'org'
  | 'user'
  | 'job'
  | 'standard'
  | 'candidate'
  | 'consent'
  | 'draft'
  | 'check'
  | 'preppack'
  | 'agent_run'
  | 'ledger';

interface Row<T> {
  id: string;
  org_id: string | null;
  ref_id: string | null;
  at_ms: number | null;
  data: string;
}

export interface AudioBlobMeta {
  id: string;
  interviewId: string;
  createdAtMs: number;
  mime: string;
  bytes: number;
}

export interface AuthAccount {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  passwordHash: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AuthSessionRow {
  tokenHash: string;
  userId: string;
  orgId: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenMs: number;
}

function toDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export class Store {
  private constructor(readonly db: SqlDriver) {}

  static create(db: SqlDriver): Store {
    db.exec(SCHEMA_SQL);
    return new Store(db);
  }

  private put<T extends { id: string }>(kind: RecordKind, row: T, refId: string | null, atIso: string | null): void {
    this.db.run(
      'INSERT INTO records (kind, id, org_id, ref_id, at_ms, data) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(kind, id) DO UPDATE SET org_id=excluded.org_id, ref_id=excluded.ref_id, at_ms=excluded.at_ms, data=excluded.data',
      [
        kind,
        row.id,
        (row as { orgId?: string }).orgId ?? null,
        refId,
        toDateMs(atIso),
        JSON.stringify(row),
      ],
    );
  }

  private getRow<T>(kind: RecordKind, id: string): T | undefined {
    const r = this.db.get<Row<T>>(
      'SELECT id, org_id, ref_id, at_ms, data FROM records WHERE kind=? AND id=?',
      [kind, id],
    );
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  private rowsByRef<T>(kind: RecordKind, refId: string): T[] {
    return this.db
      .all<Row<T>>('SELECT data FROM records WHERE kind=? AND ref_id=? ORDER BY at_ms ASC', [kind, refId])
      .map((r) => JSON.parse(r.data) as T);
  }

  private rowsByOrg<T>(kind: RecordKind, orgId: string): T[] {
    return this.db
      .all<Row<T>>('SELECT data FROM records WHERE kind=? AND org_id=? ORDER BY at_ms ASC', [kind, orgId])
      .map((r) => JSON.parse(r.data) as T);
  }

  // ---- orgs / users ----
  saveOrg(org: Org): void {
    this.put('org', org, null, null);
  }
  findOrg(id: string): Org | undefined {
    return this.getRow<Org>('org', id);
  }
  listOrgs(): Org[] {
    return this.db
      .all<Row<Org>>("SELECT data FROM records WHERE kind='org'")
      .map((r) => JSON.parse(r.data) as Org);
  }

  saveUser(user: User): void {
    this.put('user', user, user.orgId, null);
  }
  findUser(id: string): User | undefined {
    return this.getRow<User>('user', id);
  }
  listUsers(orgId: string): User[] {
    return this.rowsByOrg<User>('user', orgId);
  }

  // ---- jobs / standards ----
  saveJob(job: Job): void {
    this.put('job', job, job.orgId, job.updatedAt);
  }
  findJob(id: string): Job | undefined {
    return this.getRow<Job>('job', id);
  }
  listJobs(orgId: string): Job[] {
    return this.rowsByOrg<Job>('job', orgId);
  }

  saveStandard(std: JobStandard): void {
    this.put('standard', std, std.jobId, std.updatedAt);
  }
  findStandard(id: string): JobStandard | undefined {
    return this.getRow<JobStandard>('standard', id);
  }
  listStandardsForJob(jobId: string): JobStandard[] {
    return this.rowsByRef<JobStandard>('standard', jobId);
  }

  // ---- candidates ----
  saveCandidate(c: Candidate): void {
    this.put('candidate', c, c.appliedJobId, c.createdAt);
  }
  findCandidate(id: string): Candidate | undefined {
    return this.getRow<Candidate>('candidate', id);
  }
  listCandidates(orgId: string): Candidate[] {
    return this.rowsByOrg<Candidate>('candidate', orgId);
  }

  // ---- interviews ----
  saveInterview(i: Interview): void {
    this.db.run(
      'INSERT INTO interviews (id, org_id, job_id, candidate_id, status, scheduled_at_ms, started_at_ms, ended_at_ms, data) ' +
        'VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET status=excluded.status, scheduled_at_ms=excluded.scheduled_at_ms, ' +
        'started_at_ms=excluded.started_at_ms, ended_at_ms=excluded.ended_at_ms, data=excluded.data',
      [
        i.id,
        i.orgId,
        i.jobId,
        i.candidateId,
        i.status,
        toDateMs(i.scheduledAt),
        toDateMs(i.startedAt),
        toDateMs(i.endedAt),
        JSON.stringify(i),
      ],
    );
  }
  findInterview(id: string): Interview | undefined {
    const r = this.db.get<{ data: string }>('SELECT data FROM interviews WHERE id=?', [id]);
    return r ? (JSON.parse(r.data) as Interview) : undefined;
  }
  listInterviews(orgId: string, statuses?: Interview['status'][]): Interview[] {
    const where = statuses && statuses.length > 0 ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    const params = statuses && statuses.length > 0 ? [orgId, ...statuses] : [orgId];
    return this.db
      .all<{ data: string }>(`SELECT data FROM interviews WHERE org_id=?${where} ORDER BY scheduled_at_ms ASC`, params)
      .map((r) => JSON.parse(r.data) as Interview);
  }
  /** Retention sweep input: interviews whose audio is past the cutoff. */
  interviewsOlderThan(cutoffMs: number): Interview[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM interviews WHERE ended_at_ms IS NOT NULL AND ended_at_ms < ? ORDER BY ended_at_ms ASC',
        [cutoffMs],
      )
      .map((r) => JSON.parse(r.data) as Interview);
  }

  // ---- consent ----
  saveConsent(c: ConsentRecord): void {
    this.put('consent', c, c.interviewId, c.respondedAt);
  }
  findConsent(id: string): ConsentRecord | undefined {
    return this.getRow<ConsentRecord>('consent', id);
  }
  findConsentByInterview(interviewId: string): ConsentRecord | undefined {
    const rows = this.rowsByRef<ConsentRecord>('consent', interviewId);
    return rows.length > 0 ? rows[rows.length - 1] : undefined;
  }
  purgeConsentLogs(cutoffMs: number): number {
    const doomed = this.db
      .all<{ id: string }>('SELECT id FROM records WHERE kind=? AND at_ms IS NOT NULL AND at_ms < ?', ['consent', cutoffMs])
      .map((r) => r.id);
    for (const id of doomed) this.db.run('DELETE FROM records WHERE kind=? AND id=?', ['consent', id]);
    return doomed.length;
  }

  // ---- transcript ----
  saveSegment(s: TranscriptSegment): void {
    this.db.run(
      'INSERT INTO segments (id, interview_id, start_ms, end_ms, speaker, data) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, speaker=excluded.speaker, data=excluded.data',
      [s.id, s.interviewId, s.startMs, s.endMs, s.speaker, JSON.stringify(s)],
    );
  }
  findSegment(id: string): TranscriptSegment | undefined {
    const r = this.db.get<{ data: string }>('SELECT data FROM segments WHERE id=?', [id]);
    return r ? (JSON.parse(r.data) as TranscriptSegment) : undefined;
  }
  listSegments(interviewId: string): TranscriptSegment[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM segments WHERE interview_id=? ORDER BY start_ms ASC', [interviewId])
      .map((r) => JSON.parse(r.data) as TranscriptSegment);
  }
  purgeTranscript(interviewId: string): number {
    const n = this.db
      .all<{ c: number }>('SELECT COUNT(*) AS c FROM segments WHERE interview_id=?', [interviewId])
      .map((r) => Number(r.c))[0];
    this.db.run('DELETE FROM segments WHERE interview_id=?', [interviewId]);
    return n ?? 0;
  }

  // ---- audio ----
  saveAudioBlob(meta: AudioBlobMeta): void {
    this.db.run(
      'INSERT INTO audio_blobs (id, interview_id, created_at_ms, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at_ms=excluded.created_at_ms, data=excluded.data',
      [meta.id, meta.interviewId, meta.createdAtMs, JSON.stringify(meta)],
    );
  }
  listAudioBlobs(interviewId: string): AudioBlobMeta[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM audio_blobs WHERE interview_id=?', [interviewId])
      .map((r) => JSON.parse(r.data) as AudioBlobMeta);
  }
  purgeAudioBlobs(cutoffMs: number): number {
    const n = this.db
      .all<{ c: number }>('SELECT COUNT(*) AS c FROM audio_blobs WHERE created_at_ms < ?', [cutoffMs])
      .map((r) => Number(r.c))[0];
    this.db.run('DELETE FROM audio_blobs WHERE created_at_ms < ?', [cutoffMs]);
    return n ?? 0;
  }

  // ---- dimension checks (always written through saveDraft) ----
  listChecksByDraft(draftId: string): StandardDimensionCheck[] {
    return this.rowsByRef<StandardDimensionCheck>('check', draftId);
  }
  findCheck(id: string): StandardDimensionCheck | undefined {
    return this.getRow<StandardDimensionCheck>('check', id);
  }

  // ---- drafts ----
  saveDraft(d: FeedbackDraft): void {
    this.put('draft', d, d.interviewId, d.createdAt);
    /** Checks are written from the draft so there is exactly one source of truth. */
    for (const check of d.checks) this.put('check', check, d.id, d.createdAt);
  }
  findDraft(id: string): FeedbackDraft | undefined {
    return this.getRow<FeedbackDraft>('draft', id);
  }
  findDraftByInterview(interviewId: string, interviewerId?: string): FeedbackDraft | undefined {
    const rows = this.rowsByRef<FeedbackDraft>('draft', interviewId).filter(
      (d) => interviewerId === undefined || d.interviewerId === interviewerId,
    );
    return rows.length > 0 ? rows[rows.length - 1] : undefined;
  }
  listDraftsByInterview(interviewId: string): FeedbackDraft[] {
    return this.rowsByRef<FeedbackDraft>('draft', interviewId);
  }
  listDraftsByOrg(orgId: string): FeedbackDraft[] {
    return this.rowsByOrg<FeedbackDraft>('draft', orgId);
  }

  // ---- prep packs ----
  savePrepPack(p: PrepPack): void {
    this.put('preppack', p, p.interviewId, p.generatedAt);
  }
  listPrepPacks(interviewId: string): PrepPack[] {
    return this.rowsByRef<PrepPack>('preppack', interviewId);
  }
  latestPrepPack(interviewId: string): PrepPack | undefined {
    const rows = this.rowsByRef<PrepPack>('preppack', interviewId);
    return rows.length > 0 ? rows[rows.length - 1] : undefined;
  }

  // ---- agent runs ----
  saveAgentRun(run: AgentRun): void {
    const ref = run.subject.interviewId ?? run.subject.jobId ?? run.subject.standardId;
    this.put('agent_run', run, ref, run.startedAt);
  }
  findAgentRun(id: string): AgentRun | undefined {
    return this.getRow<AgentRun>('agent_run', id);
  }
  listAgentRunsByRef(refId: string): AgentRun[] {
    return this.rowsByRef<AgentRun>('agent_run', refId);
  }
  listAgentRuns(orgId: string): AgentRun[] {
    return this.rowsByOrg<AgentRun>('agent_run', orgId);
  }

  // ---- evidence ledger (one row per candidate + job + dimension) ----
  saveLedgerEntry(e: EvidenceLedgerEntry): void {
    this.put('ledger', e, e.candidateId, e.updatedAt);
  }
  listLedger(candidateId: string): EvidenceLedgerEntry[] {
    return this.rowsByRef<EvidenceLedgerEntry>('ledger', candidateId);
  }

  // ---- reminders ----
  saveReminder(r: ReminderEvent): void {
    this.db.run(
      'INSERT INTO reminders (id, interview_id, org_id, level, due_at_ms, status, data) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET status=excluded.status, due_at_ms=excluded.due_at_ms, data=excluded.data',
      [r.id, r.interviewId, r.orgId, r.level, toDateMs(r.dueAt), r.status, JSON.stringify(r)],
    );
  }
  findReminder(id: string): ReminderEvent | undefined {
    const r = this.db.get<{ data: string }>('SELECT data FROM reminders WHERE id=?', [id]);
    return r ? (JSON.parse(r.data) as ReminderEvent) : undefined;
  }
  listReminders(interviewId: string): ReminderEvent[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM reminders WHERE interview_id=? ORDER BY level ASC', [interviewId])
      .map((r) => JSON.parse(r.data) as ReminderEvent);
  }
  findReminderByLevel(interviewId: string, level: number): ReminderEvent | undefined {
    const r = this.db.get<{ data: string }>('SELECT data FROM reminders WHERE interview_id=? AND level=?', [
      interviewId,
      level,
    ]);
    return r ? (JSON.parse(r.data) as ReminderEvent) : undefined;
  }
  dueReminders(nowMs: number): ReminderEvent[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM reminders WHERE status IN ('queued','sent') AND due_at_ms <= ? ORDER BY due_at_ms ASC",
        [nowMs],
      )
      .map((r) => JSON.parse(r.data) as ReminderEvent);
  }
  listQueuedReminders(): ReminderEvent[] {
    return this.db
      .all<{ data: string }>("SELECT data FROM reminders WHERE status='queued' ORDER BY due_at_ms ASC")
      .map((r) => JSON.parse(r.data) as ReminderEvent);
  }

  // ---- audit ----
  appendAudit(entry: AuditEntry): void {
    this.db.run(
      'INSERT INTO audit_log (id, org_id, entity_kind, entity_id, at_ms, data) VALUES (?,?,?,?,?,?)',
      [entry.id, entry.orgId, entry.entityType, entry.entityId, toDateMs(entry.at) ?? Date.now(), JSON.stringify(entry)],
    );
  }
  listAudit(entityId: string): AuditEntry[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM audit_log WHERE entity_id=? ORDER BY at_ms ASC', [entityId])
      .map((r) => JSON.parse(r.data) as AuditEntry);
  }
  listAuditByOrg(orgId: string, limit = 200): AuditEntry[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM audit_log WHERE org_id=? ORDER BY at_ms DESC LIMIT ?', [orgId, limit])
      .map((r) => JSON.parse(r.data) as AuditEntry);
  }

  // ---- auth accounts ----
  saveAuthAccount(a: AuthAccount): void {
    this.db.run(
      'INSERT INTO auth_accounts (id, org_id, user_id, email, password_hash, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET email=excluded.email, password_hash=excluded.password_hash, updated_at_ms=excluded.updated_at_ms',
      [a.id, a.orgId, a.userId, a.email, a.passwordHash, a.createdAtMs, a.updatedAtMs],
    );
  }
  findAuthAccountByEmail(email: string): AuthAccount | undefined {
    return this.db.get<AuthAccount>(
      'SELECT id, org_id AS orgId, user_id AS userId, email, password_hash AS passwordHash, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs ' +
        'FROM auth_accounts WHERE email=?',
      [email],
    );
  }
  findAuthAccountByUser(userId: string): AuthAccount | undefined {
    return this.db.get<AuthAccount>(
      'SELECT id, org_id AS orgId, user_id AS userId, email, password_hash AS passwordHash, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs ' +
        'FROM auth_accounts WHERE user_id=?',
      [userId],
    );
  }
  countAuthAccounts(): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM auth_accounts');
    return Number(row?.c ?? 0);
  }

  // ---- auth sessions (only the hash of the bearer token is stored) ----
  saveAuthSession(s: AuthSessionRow): void {
    this.db.run(
      'INSERT INTO auth_sessions (token_hash, user_id, org_id, created_at_ms, expires_at_ms, last_seen_ms) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(token_hash) DO UPDATE SET last_seen_ms=excluded.last_seen_ms',
      [s.tokenHash, s.userId, s.orgId, s.createdAtMs, s.expiresAtMs, s.lastSeenMs],
    );
  }
  findAuthSession(tokenHash: string): AuthSessionRow | undefined {
    return this.db.get<AuthSessionRow>(
      'SELECT token_hash AS tokenHash, user_id AS userId, org_id AS orgId, created_at_ms AS createdAtMs, expires_at_ms AS expiresAtMs, last_seen_ms AS lastSeenMs ' +
        'FROM auth_sessions WHERE token_hash=?',
      [tokenHash],
    );
  }
  touchAuthSession(tokenHash: string, atMs: number): void {
    this.db.run('UPDATE auth_sessions SET last_seen_ms=? WHERE token_hash=?', [atMs, tokenHash]);
  }
  deleteAuthSession(tokenHash: string): void {
    this.db.run('DELETE FROM auth_sessions WHERE token_hash=?', [tokenHash]);
  }
  deleteAuthSessionsForUser(userId: string): void {
    this.db.run('DELETE FROM auth_sessions WHERE user_id=?', [userId]);
  }
  purgeExpiredAuthSessions(nowMs: number): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM auth_sessions WHERE expires_at_ms < ?', [nowMs]);
    this.db.run('DELETE FROM auth_sessions WHERE expires_at_ms < ?', [nowMs]);
    return Number(row?.c ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
