export type SqlParam = string | number | bigint | null | Uint8Array;

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: SqlParam[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | undefined;
  close(): void;
}

interface SqliteStatement {
  run(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): Record<string, unknown>[];
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function normalize(params: SqlParam[] | undefined): SqlParam[] {
  if (!params) return [];
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

import { createRequire } from 'node:module';

/**
 * Uses the Node built-in SQLite driver so the stack carries no native module to compile.
 * Types are declared locally because the ambient node:sqlite typings are not guaranteed
 * across the @types/node versions this repo may run against.
 *
 * `require` is deliberate: a dynamic `import('node:sqlite')` is rewritten by the bundler
 * into a bare `sqlite` specifier it then fails to resolve, which breaks Vitest and Vite SSR.
 */
const requireBuiltins = createRequire(import.meta.url);

function createSqliteDatabase(path: string): SqliteDatabase {
  const mod = requireBuiltins('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase };
  return new mod.DatabaseSync(path);
}

export async function createSqlDriver(path: string): Promise<SqlDriver> {
  const db = createSqliteDatabase(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      db.prepare(sql).run(...normalize(params));
    },
    all: <T>(sql: string, params?: SqlParam[]) => db.prepare(sql).all(...normalize(params)) as T[],
    get: <T>(sql: string, params?: SqlParam[]) => db.prepare(sql).get(...normalize(params)) as T | undefined,
    close: () => db.close(),
  };
}
