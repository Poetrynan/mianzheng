/**
 * 一次性补齐账号：登录改造之前的库里只有成员名单、没有账号。
 * 这里给每位成员建一个可用的邮箱密码，把凭据写进 .tsbuild/demo-accounts.txt（已被 gitignore）。
 * 重复执行安全：已有账号的成员会被跳过。
 *
 * Run: npm run migrate:accounts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MockLlmProvider, MockTranscriptionProvider, type User } from '@mianyan/core';
import { MianYanApp } from '@mianyan/core/server';
import { loadConfig } from '../config.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const OUT = resolve(ROOT, '.tsbuild/demo-accounts.txt');

const ROLE_LABEL: Record<string, string> = { hr: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' };

/** 密码必须同时含字母和数字，所以字母段在前、随机数字段在后。 */
function makePassword(): string {
  const letters = randomBytes(3).toString('base64url').replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 5);
  const digits = randomBytes(4).readUInt32BE(0) % 100_000_000;
  return `${(letters || 'demo')}${digits.toString().padStart(8, '0')}`;
}

function emailFor(orgIndex: number, user: User, index: number): string {
  if (user.email && user.email.includes('@')) return user.email;
  const role = ['hr', 'interviewer', 'hiring_manager'].includes(user.role) ? user.role : 'member';
  return `${role}-w${orgIndex}-${index + 1}@demo.mianzheng.local`;
}

async function main(): Promise<void> {
  const config = loadConfig(ROOT);
  const app = await MianYanApp.open({
    dbPath: config.dbPath,
    llm: new MockLlmProvider(),
    asr: new MockTranscriptionProvider(),
    retention: config.retention,
  });

  const rows: string[] = [`面证 · 本地演示账号 @ ${new Date().toISOString()}`, `库：${config.dbPath}`, ''];
  let created = 0;
  let skipped = 0;

  const orgs = app.store.listOrgs();
  for (const [orgIndex, org] of orgs.entries()) {
    const users = app.store.listUsers(org.id);
    rows.push(`【${org.name}】${org.id} · ${users.length} 位成员${org.status === 'active' ? '' : ' · 已停用'}`);
    if (users.length === 0) rows.push('  （这个工作区还没有成员）');
    for (const [index, user] of users.entries()) {
      const existing = app.store.findAuthAccountByUser(user.id);
      if (existing) {
        skipped += 1;
        rows.push(`  ${ROLE_LABEL[user.role] ?? user.role} ${user.name} · ${existing.email} · 已有账号，未改动`);
        continue;
      }
      const email = emailFor(orgIndex + 1, user, index);
      const password = makePassword();
      app.auth.attachAccount(user, email, password);
      created += 1;
      rows.push(`  ${ROLE_LABEL[user.role] ?? user.role} ${user.name} · ${email} · ${password}`);
    }
    rows.push('');
  }

  rows.push('这些密码只用于本地演示库。登录页不预置任何默认身份；换库或清库后请重新运行 npm run migrate:accounts。');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rows.join('\n'), 'utf8');
  console.log(`工作区 ${orgs.length} 个 · 新建 ${created} 个账号 · 跳过 ${skipped} 个已有账号 · 凭据写入 ${OUT}`);
}

await main();
