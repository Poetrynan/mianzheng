import { useRef, useState, type FormEvent } from 'react';
import { KeyRound, RefreshCw, UserPlus, Users } from 'lucide-react';
import { api } from '../api/client';
import type { Role } from '../api/types';
import { messageOf, useSession } from '../session';
import { Badge, Btn, ErrorNote, Field, OkNote, Panel, ROLE_LABEL, Select, cx } from '../ui';

const EMPLOYEE_ROLES: Array<{ role: Role; hint: string }> = [
  { role: 'interviewer', hint: '准备、记录、提交面评' },
  { role: 'hiring_manager', hint: '定标准、看依据' },
  { role: 'hr', hint: '排期、催办、管理成员' },
];

const ROLE_TONE: Record<Role, 'ai' | 'human' | 'idle' | 'ok'> = {
  hr: 'ai',
  hiring_manager: 'human',
  interviewer: 'ok',
  candidate: 'idle',
};

const ROLE_ORDER: Record<Role, number> = { hr: 0, hiring_manager: 1, interviewer: 2, candidate: 3 };

function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const raw = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return `${raw}A1`;
}

export function TeamScreen() {
  const { org, users, me, reloadMembers } = useSession();
  const isHr = me?.role === 'hr';
  const sorted = [...users].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name, 'zh'));
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await reloadMembers();
    } catch (err) {
      setRefreshError(messageOf(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.42fr_1fr]">
      <div className="flex flex-col gap-4">
        <Panel
          title="团队成员"
          subtitle={org ? `${org.name} · ${users.length} 位成员` : '本企业成员'}
          icon={Users}
          right={
            <Btn
              variant="quiet"
              icon={RefreshCw}
              onClick={() => void refresh()}
              busy={refreshing}
              busyLabel="刷新中…"
            >
              刷新
            </Btn>
          }
        >
          <ErrorNote message={refreshError} />
          <ul className="mt-1 flex flex-col">
            {sorted.map((u) => (
              <li key={u.id} className="flex items-center gap-3 border-b border-line-soft/70 py-3 last:border-0 first:pt-1">
                <span
                  className={cx(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold',
                    u.role === 'hr'
                      ? 'bg-brand/12 text-tint-brand'
                      : u.role === 'hiring_manager'
                        ? 'bg-human/12 text-tint-human'
                        : 'bg-ok/12 text-tint-ok',
                  )}
                  aria-hidden
                >
                  {u.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[14px] font-medium text-paper">{u.name}</p>
                    {u.id === me?.id ? (
                      <Badge tone="idle" className="px-1.5 py-0 text-[11px]">
                        我
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-mist-dim">{u.email ?? '尚未开通登录账号'}</p>
                </div>
                <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-mist-dim">
            成员用邮箱和密码登录，只能看到本企业的岗位、候选人和面试记录。
          </p>
        </Panel>

        {isHr ? <AddMemberCard onAdded={() => void refresh()} /> : null}
        {!isHr ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-4 text-[12px] leading-relaxed text-mist">
            添加成员由招聘负责人完成。需要新同事加入时，把姓名、邮箱和角色发给他即可。
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <Panel title="我的账号" subtitle="修改密码后，其他设备上的登录会立即失效" icon={KeyRound}>
          <AccountSummary />
          <ChangePassword />
        </Panel>

        <Panel title="账号与会话" subtitle="登录状态、数据范围和密码的保存方式。">
          <ul className="flex flex-col gap-1.5 text-[12px] leading-relaxed text-mist-dim">
            <li>登录状态保留 14 天，退出后当前设备立即失效。</li>
            <li>密码采用加盐哈希保存，服务端不保存明文。</li>
            <li>同企业的成员共享岗位与面试数据，跨企业互不可见。</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function AccountSummary() {
  const { me, org } = useSession();
  if (!me) return null;
  return (
    <div className="inset flex items-center gap-3 px-4 py-3">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/12 text-[13px] font-semibold text-tint-brand"
        aria-hidden
      >
        {me.name.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-paper">{me.name}</p>
        <p className="mt-0.5 truncate text-[12px] text-mist-dim">{me.email ?? '未绑定邮箱'}</p>
        <p className="mt-0.5 truncate text-[11px] text-mist-dim">{org?.name}</p>
      </div>
      <Badge tone={ROLE_TONE[me.role]}>{ROLE_LABEL[me.role]}</Badge>
    </div>
  );
}

type MemberField = 'name' | 'email' | 'password';
type MemberErrors = Partial<Record<MemberField, string>>;

function AddMemberCard({ onAdded }: { onAdded: () => void }) {
  const { org } = useSession();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('interviewer');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [errors, setErrors] = useState<MemberErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const edit = (field: MemberField, next: string, set: (value: string) => void) => {
    set(next);
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!org) return;
    setError(null);
    setDone(null);
    if (!name.trim()) {
      setErrors({ name: '请填写成员姓名' });
      nameRef.current?.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErrors({ email: '请填写有效的工作邮箱' });
      emailRef.current?.focus();
      return;
    }
    if (password.length < 8 || !/\p{L}/u.test(password) || !/\d/.test(password)) {
      setErrors({ password: '初始密码至少 8 位，并同时包含字母和数字' });
      passwordRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.auth.addMember(org.id, { role, name: name.trim(), email: email.trim(), password });
      setDone(`已为 ${name.trim()} 开通登录：${email.trim()}`);
      setName('');
      setEmail('');
      setPassword('');
      onAdded();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="添加成员" subtitle="由招聘负责人设置初始密码，当面交给成员" icon={UserPlus}>
      <form className="mt-1 flex flex-col gap-3" onSubmit={(event) => void submit(event)} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="姓名"
            value={name}
            onChange={(v) => edit('name', v, setName)}
            placeholder="例如：王越"
            error={errors.name}
            inputRef={nameRef}
            autoComplete="off"
          />
          <Select label="角色" value={role} onChange={(v) => setRole(v as Role)}>
            {EMPLOYEE_ROLES.map((item) => (
              <option key={item.role} value={item.role}>
                {ROLE_LABEL[item.role]} · {item.hint}
              </option>
            ))}
          </Select>
        </div>

        <Field
          label="工作邮箱"
          type="email"
          value={email}
          onChange={(v) => edit('email', v, setEmail)}
          placeholder="wang.yue@company.com"
          error={errors.email}
          inputRef={emailRef}
          inputMode="email"
          autoComplete="off"
        />

        <div>
          <Field
            label="初始密码"
            value={password}
            onChange={(v) => edit('password', v, setPassword)}
            placeholder="至少 8 位，含字母和数字"
            error={errors.password}
            hint="初始密码只在创建时显示，请通过安全渠道交给成员；对方登录后可自行修改。"
            inputRef={passwordRef}
            autoComplete="new-password"
          />
          <Btn variant="quiet" className="mt-1" onClick={() => setPassword(suggestPassword())}>
            生成一个初始密码
          </Btn>
        </div>

        <ErrorNote message={error} />
        <OkNote message={done} />
        <Btn variant="primary" type="submit" disabled={busy} busy={busy} busyLabel="正在添加…" icon={UserPlus}>
          添加成员
        </Btn>
      </form>
    </Panel>
  );
}

type PasswordField = 'current' | 'next' | 'confirm';
type PasswordErrors = Partial<Record<PasswordField, string>>;

function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [errors, setErrors] = useState<PasswordErrors>({});
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const edit = (field: PasswordField, next: string, set: (value: string) => void) => {
    set(next);
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setDone(null);
    if (!currentPassword) {
      setErrors({ current: '请输入当前密码' });
      currentRef.current?.focus();
      return;
    }
    if (newPassword.length < 8 || !/\p{L}/u.test(newPassword) || !/\d/.test(newPassword)) {
      setErrors({ next: '新密码至少 8 位，并同时包含字母和数字' });
      nextRef.current?.focus();
      return;
    }
    if (newPassword !== confirm) {
      setErrors({ confirm: '两次输入的新密码不一致' });
      confirmRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setDone('密码已更新，其他设备上的登录已退出。');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mt-4 flex flex-col gap-3 border-t border-line-soft pt-4" onSubmit={(event) => void submit(event)} noValidate>
      <h3 className="text-[13px] font-semibold text-paper">修改密码</h3>
      <Field
        label="当前密码"
        type="password"
        value={currentPassword}
        onChange={(v) => edit('current', v, setCurrentPassword)}
        error={errors.current}
        inputRef={currentRef}
        autoComplete="current-password"
      />
      <Field
        label="新密码"
        type="password"
        value={newPassword}
        onChange={(v) => edit('next', v, setNewPassword)}
        placeholder="至少 8 位，含字母和数字"
        error={errors.next}
        inputRef={nextRef}
        autoComplete="new-password"
      />
      <Field
        label="确认新密码"
        type="password"
        value={confirm}
        onChange={(v) => edit('confirm', v, setConfirm)}
        error={errors.confirm}
        inputRef={confirmRef}
        autoComplete="new-password"
      />
      <ErrorNote message={error} />
      <OkNote message={done} />
      <Btn variant="primary" type="submit" disabled={busy} busy={busy} busyLabel="正在更新…">
        更新密码
      </Btn>
    </form>
  );
}
