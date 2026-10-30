import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DAY_MS } from './clock.js';
import type { ServiceContext, Actor } from './services/context.js';
import { makeId } from './services/context.js';
import { DomainError } from './errors.js';
import type { Org, Role, User } from './types.js';
import type { AuthAccount } from './db/store.js';

export const SESSION_TTL_MS = 14 * DAY_MS;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export const EMPLOYEE_ROLES: Role[] = ['hr', 'interviewer', 'hiring_manager'];

export interface RegisterInput {
  orgName: string;
  name: string;
  email: string;
  password: string;
}

export interface MemberInput {
  role: Role;
  name: string;
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: User;
  org: Org;
}

export interface ResolvedSession {
  token: string;
  user: User;
  org: Org;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 至少 8 位，同时包含字母与数字；中文也算字母，避免只认英文。 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < 8) throw new DomainError('password_weak', '密码至少 8 位');
  if (password.length > 128) throw new DomainError('password_weak', '密码最多 128 位');
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) {
    throw new DomainError('password_weak', '密码要同时包含字母和数字');
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_HASH = hashPassword('not-a-real-password-1');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Email + password accounts, server-side sessions and org membership.
 * The browser never sees a password hash or a session table row.
 */
export class AuthService {
  private failures = new Map<string, { count: number; firstAt: number }>();

  constructor(private readonly ctx: ServiceContext) {}

  private now(): number {
    return this.ctx.clock.now().getTime();
  }

  registerOrg(input: RegisterInput): LoginResult {
    const email = normalizeEmail(input.email);
    assertPasswordAcceptable(input.password);
    if (this.ctx.store.findAuthAccountByEmail(email)) {
      throw new DomainError('email_taken', '这个邮箱已经注册过，请直接登录');
    }
    const passwordHash = hashPassword(input.password);
    const org: Org = {
      id: makeId(this.ctx, 'org'),
      name: input.orgName.trim(),
      atsType: null,
      complianceTemplateId: 'pipl-v1',
      status: 'active',
    };
    const user: User = {
      id: makeId(this.ctx, 'usr'),
      orgId: org.id,
      role: 'hr',
      name: input.name.trim(),
      email,
    };
    this.ctx.store.saveOrg(org);
    this.ctx.store.saveUser(user);
    this.ctx.store.saveAuthAccount(this.accountOf(org.id, user.id, email, passwordHash));
    return { ...this.issue(user, org), user, org };
  }

  /** Used by the one-time migration for workspaces created before accounts existed. */
  attachAccount(user: User, emailRaw: string, password: string): AuthAccount {
    const email = normalizeEmail(emailRaw);
    assertPasswordAcceptable(password);
    const existing = this.ctx.store.findAuthAccountByEmail(email);
    if (existing && existing.userId !== user.id) {
      throw new DomainError('email_taken', '这个邮箱已经绑定到另一个成员');
    }
    if (existing) return existing;
    const hash = hashPassword(password);
    const account = this.accountOf(user.orgId, user.id, email, hash);
    this.ctx.store.saveAuthAccount(account);
    if (user.email !== email) this.ctx.store.saveUser({ ...user, email });
    return account;
  }

  login(emailRaw: string, password: string): LoginResult {
    const email = normalizeEmail(emailRaw);
    this.assertNotLocked(email);
    const account = this.ctx.store.findAuthAccountByEmail(email);
    const ok = verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
    if (!account || !ok) {
      this.noteFailure(email);
      throw new DomainError('invalid_credentials', '邮箱或密码不正确');
    }
    const user = this.ctx.store.findUser(account.userId);
    const org = this.ctx.store.findOrg(account.orgId);
    if (!user || !org) {
      this.noteFailure(email);
      throw new DomainError('invalid_credentials', '邮箱或密码不正确');
    }
    if (org.status !== 'active') throw new DomainError('org_suspended', '这个工作区已停用，请联系管理员');
    this.failures.delete(email);
    return { ...this.issue(user, org), user, org };
  }

  resolve(token: string): ResolvedSession | null {
    const hash = tokenHash(token);
    const row = this.ctx.store.findAuthSession(hash);
    if (!row) return null;
    const now = this.now();
    if (row.expiresAtMs <= now) {
      this.ctx.store.deleteAuthSession(hash);
      return null;
    }
    const user = this.ctx.store.findUser(row.userId);
    const org = this.ctx.store.findOrg(row.orgId);
    if (!user || !org || org.status !== 'active') {
      this.ctx.store.deleteAuthSession(hash);
      return null;
    }
    if (now - row.lastSeenMs > 60_000) this.ctx.store.touchAuthSession(hash, now);
    return { token, user, org };
  }

  logout(token: string): void {
    this.ctx.store.deleteAuthSession(tokenHash(token));
  }

  changePassword(userId: string, currentPassword: string, newPassword: string): void {
    const account = this.ctx.store.findAuthAccountByUser(userId);
    if (!account || !verifyPassword(currentPassword, account.passwordHash)) {
      throw new DomainError('password_mismatch', '当前密码不正确');
    }
    assertPasswordAcceptable(newPassword);
    this.ctx.store.saveAuthAccount({
      ...account,
      passwordHash: hashPassword(newPassword),
      updatedAtMs: this.now(),
    });
    this.ctx.store.deleteAuthSessionsForUser(userId);
  }

  createMember(actor: Actor, orgId: string, input: MemberInput): User {
    if (actor.kind !== 'human' || actor.role !== 'hr') {
      throw new DomainError('hr_only', '只有招聘负责人可以添加成员');
    }
    if (!EMPLOYEE_ROLES.includes(input.role)) {
      throw new DomainError('bad_request', '这个身份不能加入工作区');
    }
    const org = this.ctx.store.findOrg(orgId);
    if (!org) throw new DomainError('org_not_found', '工作区不存在');
    // The HTTP layer already scopes orgId to the session; the service must not trust that alone.
    if (this.ctx.store.findUser(actor.userId)?.orgId !== orgId) {
      throw new DomainError('forbidden', '你不能在别的工作区里添加成员');
    }
    const email = normalizeEmail(input.email);
    if (this.ctx.store.findAuthAccountByEmail(email)) {
      throw new DomainError('email_taken', '这个邮箱已经注册过，请换一个邮箱');
    }
    assertPasswordAcceptable(input.password);
    const passwordHash = hashPassword(input.password);
    const user: User = {
      id: makeId(this.ctx, 'usr'),
      orgId,
      role: input.role,
      name: input.name.trim(),
      email,
    };
    this.ctx.store.saveUser(user);
    this.ctx.store.saveAuthAccount(this.accountOf(orgId, user.id, email, passwordHash));
    return user;
  }

  private accountOf(orgId: string, userId: string, email: string, passwordHash: string): AuthAccount {
    const now = this.now();
    return { id: makeId(this.ctx, 'acc'), orgId, userId, email, passwordHash, createdAtMs: now, updatedAtMs: now };
  }

  private issue(user: User, org: Org): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.ctx.store.saveAuthSession({
      tokenHash: tokenHash(token),
      userId: user.id,
      orgId: org.id,
      createdAtMs: now,
      expiresAtMs: now + SESSION_TTL_MS,
      lastSeenMs: now,
    });
    this.ctx.store.purgeExpiredAuthSessions(now);
    return { token, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
  }

  private assertNotLocked(email: string): void {
    const state = this.failures.get(email);
    if (!state) return;
    if (this.now() - state.firstAt > FAILURE_WINDOW_MS) {
      this.failures.delete(email);
      return;
    }
    if (state.count >= MAX_FAILURES) {
      throw new DomainError('too_many_attempts', '尝试次数过多，请 15 分钟后再试');
    }
  }

  private noteFailure(email: string): void {
    const now = this.now();
    const state = this.failures.get(email);
    if (!state || now - state.firstAt > FAILURE_WINDOW_MS) {
      this.failures.set(email, { count: 1, firstAt: now });
      return;
    }
    state.count += 1;
  }
}
