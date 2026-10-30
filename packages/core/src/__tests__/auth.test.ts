import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import { DAY_MS, FixedClock } from '../clock.js';
import { DomainError } from '../errors.js';
import { SESSION_TTL_MS, assertPasswordAcceptable, normalizeEmail } from '../auth.js';
import type { Role } from '../types.js';
import { defaultAppDeps } from './fixtures.js';

let app: MianYanApp;
let clock: FixedClock;

const PASSWORD = 'mianzheng2026';

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'no-error';
}

describe('账号与口令', () => {
  it('注册同时建工作区、HR 成员和会话', () => {
    const res = app.auth.registerOrg({ orgName: '杭州演示科技', name: '李 HR', email: 'hr@demo.test', password: PASSWORD });
    expect(res.user.role).toBe('hr');
    expect(res.org.status).toBe('active');
    expect(res.token.length).toBeGreaterThan(20);
    expect(app.store.countAuthAccounts()).toBe(1);
  });

  it('库里只存 scrypt 散列，不存明文口令', () => {
    app.auth.registerOrg({ orgName: '杭州演示科技', name: '李 HR', email: 'hr@demo.test', password: PASSWORD });
    const account = app.store.findAuthAccountByEmail('hr@demo.test');
    expect(account?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(account?.passwordHash).not.toContain(PASSWORD);
  });

  it('会话表只存令牌散列，原始令牌不落库', () => {
    const res = app.auth.registerOrg({ orgName: '杭州演示科技', name: '李 HR', email: 'hr@demo.test', password: PASSWORD });
    const hash = createHash('sha256').update(res.token).digest('hex');
    const row = app.store.findAuthSession(hash);
    expect(row?.tokenHash).toBe(hash);
    expect(row?.tokenHash).not.toContain(res.token);
    expect(app.auth.resolve(res.token)?.org.id).toBe(res.org.id);
  });

  it('邮箱大小写与空格不算两个账号', () => {
    expect(normalizeEmail('  HR@Demo.Test ')).toBe('hr@demo.test');
    app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    expect(codeOf(() => app.auth.registerOrg({ orgName: 'B', name: '乙', email: ' HR@DEMO.TEST ', password: PASSWORD }))).toBe('email_taken');
  });

  it('负向：口令太短、纯数字、纯字母都不接受', () => {
    expect(codeOf(() => assertPasswordAcceptable('ab1'))).toBe('password_weak');
    expect(codeOf(() => assertPasswordAcceptable('12345678901'))).toBe('password_weak');
    expect(codeOf(() => assertPasswordAcceptable('abcdefghijklm'))).toBe('password_weak');
    expect(() => assertPasswordAcceptable('面证2026demo')).not.toThrow();
  });

  it('负向：口令错误不能登录，且不透露账号是否存在', () => {
    app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    expect(codeOf(() => app.auth.login('hr@demo.test', 'mianzheng2027'))).toBe('invalid_credentials');
    expect(codeOf(() => app.auth.login('ghost@demo.test', PASSWORD))).toBe('invalid_credentials');
  });

  it('同一邮箱连错 8 次后暂时锁定，正确口令也被挡住', () => {
    app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    for (let i = 0; i < 8; i += 1) {
      expect(codeOf(() => app.auth.login('hr@demo.test', 'wrong12345'))).toBe('invalid_credentials');
    }
    expect(codeOf(() => app.auth.login('hr@demo.test', PASSWORD))).toBe('too_many_attempts');
    clock.advanceMs(16 * 60 * 1000);
    expect(app.auth.login('hr@demo.test', PASSWORD).user.email).toBe('hr@demo.test');
  });
});

describe('会话', () => {
  it('resolve 认出有效令牌并返回同一身份', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    const resolved = app.auth.resolve(res.token);
    expect(resolved?.user.id).toBe(res.user.id);
    expect(resolved?.org.id).toBe(res.org.id);
  });

  it('负向：伪造令牌什么都解析不出来', () => {
    app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    expect(app.auth.resolve('not-a-real-token-at-all')).toBeNull();
  });

  it('退出登录后这枚令牌立刻失效', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    app.auth.logout(res.token);
    expect(app.auth.resolve(res.token)).toBeNull();
  });

  it('超过 14 天未用的会话自动过期', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    clock.advanceMs(SESSION_TTL_MS + DAY_MS);
    expect(app.auth.resolve(res.token)).toBeNull();
  });

  it('改口令后所有设备都要重新登录', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    const other = app.auth.login('hr@demo.test', PASSWORD);
    app.auth.changePassword(res.user.id, PASSWORD, 'mianzheng2027');
    expect(app.auth.resolve(res.token)).toBeNull();
    expect(app.auth.resolve(other.token)).toBeNull();
    expect(app.auth.login('hr@demo.test', 'mianzheng2027').user.id).toBe(res.user.id);
  });

  it('负向：当前口令不对就不能改', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    expect(codeOf(() => app.auth.changePassword(res.user.id, 'wrong12345', 'mianzheng2027'))).toBe('password_mismatch');
  });

  it('工作区停用后旧会话不再可用', () => {
    const res = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    app.store.saveOrg({ ...res.org, status: 'suspended' });
    expect(app.auth.resolve(res.token)).toBeNull();
    expect(codeOf(() => app.auth.login('hr@demo.test', PASSWORD))).toBe('org_suspended');
  });
});

describe('成员与工作区隔离', () => {
  it('HR 建的成员能用自己的账号登录，且落在同一个工作区', () => {
    const hr = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    const iv = app.auth.createMember({ kind: 'human', userId: hr.user.id, role: 'hr' }, hr.org.id, {
      role: 'interviewer',
      name: '王 面试官',
      email: 'wang@demo.test',
      password: PASSWORD,
    });
    const session = app.auth.login('wang@demo.test', PASSWORD);
    expect(session.user.id).toBe(iv.id);
    expect(session.org.id).toBe(hr.org.id);
  });

  it('负向：面试官不能开账号', () => {
    const hr = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    const interviewer = app.auth.createMember({ kind: 'human', userId: hr.user.id, role: 'hr' }, hr.org.id, {
      role: 'interviewer',
      name: '乙',
      email: 'iv@demo.test',
      password: PASSWORD,
    });
    expect(
      codeOf(() =>
        app.auth.createMember({ kind: 'human', userId: interviewer.id, role: 'interviewer' }, hr.org.id, {
          role: 'hr',
          name: '丙',
          email: 'sneak@demo.test',
          password: PASSWORD,
        }),
      ),
    ).toBe('hr_only');
  });

  it('负向：候选人身份不能成为登录成员', () => {
    const hr = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'hr@demo.test', password: PASSWORD });
    // HTTP 层已经把 role 收窄成三种员工身份，这里验的是服务层的最后一道闸。
    expect(
      codeOf(() =>
        app.auth.createMember({ kind: 'human', userId: hr.user.id, role: 'hr' }, hr.org.id, {
          role: 'candidate' as Role,
          name: '张伟',
          email: 'z@demo.test',
          password: PASSWORD,
        }),
      ),
    ).toBe('bad_request');
  });

  it('两个工作区互相看不见对方的成员', () => {
    const a = app.auth.registerOrg({ orgName: 'A', name: '甲', email: 'a@demo.test', password: PASSWORD });
    const b = app.auth.registerOrg({ orgName: 'B', name: '乙', email: 'b@demo.test', password: PASSWORD });
    expect(app.store.listUsers(a.org.id).map((u) => u.id)).toEqual([a.user.id]);
    expect(app.store.listUsers(b.org.id).map((u) => u.id)).toEqual([b.user.id]);
    expect(codeOf(() =>
      app.auth.createMember({ kind: 'human', userId: a.user.id, role: 'hr' }, b.org.id, {
        role: 'interviewer',
        name: '丙',
        email: 'c@demo.test',
        password: PASSWORD,
      }),
    )).toBe('forbidden');
  });

  it('迁移：给改造前的成员补账号，重复执行不会产生第二个账号', () => {
    const org = app.createOrg('旧的工作区');
    const user = app.addUser(org.id, 'interviewer', '王 面试官');
    const first = app.auth.attachAccount(user, 'wang@demo.test', PASSWORD);
    const again = app.auth.attachAccount(app.store.findUser(user.id)!, 'wang@demo.test', PASSWORD);
    expect(again.id).toBe(first.id);
    expect(app.store.countAuthAccounts()).toBe(1);
    expect(app.auth.login('wang@demo.test', PASSWORD).user.id).toBe(user.id);
  });
});
