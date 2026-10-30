export type IdGenerator = () => string;

export type IdPrefix =
  | 'org'
  | 'usr'
  | 'job'
  | 'std'
  | 'dim'
  | 'cnd'
  | 'int'
  | 'seg'
  | 'chk'
  | 'drf'
  | 'rem'
  | 'con'
  | 'aud'
  | 'qst'
  | 'pck'
  | 'acc'
  | 'run';

let counter = 0;

/** Works in both Node and the browser; falls back to a counter when randomUUID is absent. */
export const defaultIdGenerator: IdGenerator = () => {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function newId(prefix: IdPrefix, gen: IdGenerator = defaultIdGenerator): string {
  return `${prefix}_${gen()}`;
}
