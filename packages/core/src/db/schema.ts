export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  org_id TEXT,
  ref_id TEXT,
  at_ms INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_records_ref ON records(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_records_org ON records(kind, org_id);

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at_ms INTEGER,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interviews_org_status ON interviews(org_id, status);
CREATE INDEX IF NOT EXISTS idx_interviews_ended ON interviews(ended_at_ms);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_interview ON segments(interview_id, start_ms);

CREATE TABLE IF NOT EXISTS audio_blobs (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_created ON audio_blobs(created_at_ms);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at_ms);
CREATE INDEX IF NOT EXISTS idx_reminders_interview ON reminders(interview_id, level);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_kind, entity_id);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_accounts_org ON auth_accounts(org_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at_ms);
`;
