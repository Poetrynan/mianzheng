import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api/client';
import { CHANNEL_LABEL } from './ui';
import type { Interview, Org, SessionSnapshot, User } from './api/types';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

interface SessionValue {
  status: SessionStatus;
  org: Org | null;
  users: User[];
  me: User | null;
  /** Set when the initial session check failed for a reason other than "not logged in". */
  bootError: string | null;
  retryBoot: () => void;
  /** One shared interview list: every screen reloads it after a mutation, so the header pill is never behind. */
  interviews: Loader<Interview[]>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { orgName: string; name: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  reloadMembers: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : '刚才的操作没有完成，请重试';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const apply = useCallback((next: SessionSnapshot) => {
    setSnapshot(next);
    setStatus('authenticated');
    setBootError(null);
  }, []);

  const clear = useCallback(() => {
    setSnapshot(null);
    setStatus('anonymous');
  }, []);

  const boot = useCallback(async () => {
    setStatus('loading');
    setBootError(null);
    try {
      apply(await api.auth.me());
    } catch (err) {
      clear();
      if (!(err instanceof ApiError && err.status === 401)) setBootError(messageOf(err));
    }
  }, [apply, clear]);

  useEffect(() => {
    void boot();
  }, [boot]);

  /** An expired session anywhere in the app drops the shell back to the login screen. */
  useEffect(() => {
    const onUnauthorized = () => clear();
    window.addEventListener('mianzheng:unauthorized', onUnauthorized);
    return () => window.removeEventListener('mianzheng:unauthorized', onUnauthorized);
  }, [clear]);

  const login = useCallback(
    async (email: string, password: string) => {
      apply(await api.auth.login(email, password));
    },
    [apply],
  );

  const register = useCallback(
    async (input: { orgName: string; name: string; email: string; password: string }) => {
      apply(await api.auth.register(input));
    },
    [apply],
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      clear();
    }
  }, [clear]);

  const reloadMembers = useCallback(async () => {
    if (!snapshot) return;
    const members = await api.listUsers(snapshot.org.id);
    setSnapshot({ ...snapshot, members });
  }, [snapshot]);

  const org = snapshot?.org ?? null;
  const users = snapshot?.members ?? [];
  const me = useMemo(
    () => (snapshot ? (snapshot.members.find((u) => u.id === snapshot.user.id) ?? snapshot.user) : null),
    [snapshot],
  );
  const interviews = useLoader<Interview[]>(org ? () => api.listInterviews(org.id) : async () => [], [org?.id]);

  const value: SessionValue = {
    status,
    org,
    users,
    me,
    bootError,
    retryBoot: () => void boot(),
    interviews,
    login,
    register,
    logout,
    reloadMembers,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

export interface Loader<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Minimal fetch-on-deps hook; reload() is what every action button calls after a mutation. */
export function useLoader<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loader<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    latest
      .current()
      .then((res) => {
        if (!live) return;
        setData(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(messageOf(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export interface Directory {
  /** 「张伟 · 高级后端工程师 · 第 1 轮 · 视频面」— pickers must never show an id. */
  labelOf: (it: Pick<Interview, 'candidateId' | 'jobId' | 'round' | 'channel'>) => string;
  candidateName: (id: string) => string;
  jobTitle: (id: string) => string;
  loading: boolean;
  error: string | null;
}

const UNKNOWN_CANDIDATE = '未入库候选人';
const UNKNOWN_JOB = '未命名岗位';

export function useDirectory(orgId: string, revision?: unknown): Directory {
  const res = useLoader(async () => {
    if (!orgId) return { names: new Map<string, string>(), titles: new Map<string, string>() };
    const [candidates, jobs] = await Promise.all([api.listCandidates(orgId), api.listJobs(orgId)]);
    return {
      names: new Map(candidates.map((c) => [c.id, c.name])),
      titles: new Map(jobs.map((j) => [j.id, j.title])),
    };
  }, [orgId, revision]);

  return useMemo(() => {
    const nameOf = (id: string) => res.data?.names.get(id) ?? null;
    const titleOf = (id: string) => res.data?.titles.get(id) ?? null;
    return {
      loading: res.loading,
      error: res.error,
      candidateName: (id: string) => nameOf(id) ?? UNKNOWN_CANDIDATE,
      jobTitle: (id: string) => titleOf(id) ?? UNKNOWN_JOB,
      labelOf: (it: Pick<Interview, 'candidateId' | 'jobId' | 'round' | 'channel'>) =>
        [nameOf(it.candidateId), titleOf(it.jobId), `第 ${it.round} 轮`, CHANNEL_LABEL[it.channel]]
          .filter((s): s is string => Boolean(s))
          .join(' · '),
    };
  }, [res.data, res.error, res.loading]);
}
