import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { LlmProvider } from '../ai/llm.js';
import type { TranscriptionProvider } from '../ai/asr.js';
import type { AuditEntry, Role, User } from '../types.js';
import type { IdGenerator, IdPrefix } from '../ids.js';
import { defaultIdGenerator, newId } from '../ids.js';
import type { Store } from '../db/store.js';
import { DEFAULT_RETENTION, type RetentionPolicy } from '../compliance/retention.js';

export type Actor =
  | { kind: 'human'; userId: string; role: Role }
  | { kind: 'ai'; model: string }
  | { kind: 'system'; name: string };

export const humanActor = (user: Pick<User, 'id' | 'role'>): Actor => ({ kind: 'human', userId: user.id, role: user.role });
export const aiActor = (model: string): Actor => ({ kind: 'ai', model });
export const systemActor = (name: string): Actor => ({ kind: 'system', name });

export type NotificationChannel = 'in_app' | 'feishu' | 'wecom' | 'email';

export interface AppNotification {
  id: string;
  orgId: string;
  interviewId: string | null;
  to: string[];
  channel: NotificationChannel;
  kind: 'prep_pack' | 'interview_starting' | 'draft_ready' | 'reminder' | 'escalation' | 'submitted';
  title: string;
  body: string;
  link: string;
  at: string;
}

export interface Notifier {
  publish(n: AppNotification): void;
}

/** Only in-app notifications ship today; external chat and email channels attach through this same interface. */
export class InMemoryNotifier implements Notifier {
  readonly sent: AppNotification[] = [];
  publish(n: AppNotification): void {
    this.sent.push(n);
  }
  forUser(userId: string): AppNotification[] {
    return this.sent.filter((n) => n.to.includes(userId));
  }
  clear(): void {
    this.sent.length = 0;
  }
}

export interface ServiceContext {
  store: Store;
  clock: Clock;
  llm: LlmProvider;
  asr: TranscriptionProvider;
  notifier: Notifier;
  ids: IdGenerator;
  retention: RetentionPolicy;
}

export function createContext(parts: {
  store: Store;
  clock?: Clock;
  llm: LlmProvider;
  asr: TranscriptionProvider;
  notifier?: Notifier;
  ids?: IdGenerator;
  retention?: RetentionPolicy;
}): ServiceContext {
  return {
    store: parts.store,
    clock: parts.clock ?? systemClock,
    llm: parts.llm,
    asr: parts.asr,
    notifier: parts.notifier ?? new InMemoryNotifier(),
    ids: parts.ids ?? defaultIdGenerator,
    retention: parts.retention ?? DEFAULT_RETENTION,
  };
}

export function makeId(ctx: ServiceContext, prefix: IdPrefix): string {
  return newId(prefix, ctx.ids);
}

export function nowIso(ctx: ServiceContext): string {
  return ctx.clock.now().toISOString();
}

export function recordAudit(
  ctx: ServiceContext,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  orgId: string,
  payload: Record<string, unknown> = {},
): AuditEntry {
  const entry: AuditEntry = {
    id: makeId(ctx, 'aud'),
    orgId,
    actorType: actor.kind,
    actorId: actor.kind === 'human' ? actor.userId : actor.kind === 'ai' ? `ai:${actor.model}` : `system:${actor.name}`,
    action,
    entityType,
    entityId,
    payload,
    at: nowIso(ctx),
  };
  ctx.store.appendAudit(entry);
  return entry;
}
