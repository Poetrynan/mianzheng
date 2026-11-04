import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronDown, Eye, EyeOff, HelpCircle, ShieldCheck, Sparkles, Stamp } from 'lucide-react';
import { Brand, ThemeToggle } from '../chrome';
import { messageOf, useSession } from '../session';
import { Btn, ErrorNote, Field, Segmented, cx } from '../ui';

type Mode = 'login' | 'register';

type FieldErrors = Partial<Record<'orgName' | 'name' | 'email' | 'password' | 'confirm', string>>;

const DEMO_ACCOUNTS = [
  { label: '面试官 · 建议先体验', email: 'wang@demo.mianzheng.local' },
  { label: '招聘负责人（HR）', email: 'hr@demo.mianzheng.local' },
  { label: '用人经理', email: 'zhao@demo.mianzheng.local' },
];
const DEMO_PASSWORD = 'mianzheng2026';

export function AuthScreen() {
  const { login, register, bootError, retryBoot } = useSession();
  const [mode, setMode] = useState<Mode>('login');
  const [orgName, setOrgName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showDemo, setShowDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const orgRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    setErrors({});
    setConfirm('');
    setShowPassword(false);
    if (window.matchMedia('(min-width: 1024px)').matches) {
      (mode === 'register' ? orgRef : emailRef).current?.focus({ preventScroll: true });
    }
  }, [mode]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, []);

  /** 改过这一栏，就把这一栏的错误撤掉。 */
  const edit = (field: keyof FieldErrors, next: string, set: (value: string) => void) => {
    set(next);
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const mail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErrors({ email: '请填写有效的工作邮箱' });
      emailRef.current?.focus();
      return;
    }
    if (mode === 'login') {
      if (!password) {
        setErrors({ password: '请输入密码' });
        passwordRef.current?.focus();
        return;
      }
      setErrors({});
      setBusy(true);
      try {
        await login(mail, password);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (orgName.trim().length < 2) {
      setErrors({ orgName: '企业名称至少 2 个字' });
      orgRef.current?.focus();
      return;
    }
    if (!name.trim()) {
      setErrors({ name: '请填写你的姓名' });
      nameRef.current?.focus();
      return;
    }
    if (password.length < 8 || !/\p{L}/u.test(password) || !/\d/.test(password)) {
      setErrors({ password: '密码至少 8 位，并同时包含字母和数字' });
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setErrors({ confirm: '两次输入的密码不一致' });
      confirmRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await register({ orgName: orgName.trim(), name: name.trim(), email: mail, password });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const eyeButton = (
    <button
      type="button"
      onClick={() => setShowPassword((v) => !v)}
      aria-label={showPassword ? '隐藏密码' : '显示密码'}
      aria-pressed={showPassword}
      className="press absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-mist-dim hover:bg-raise hover:text-paper"
    >
      {showPassword ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />}
    </button>
  );

  return (
    <div className="auth-layout relative grid min-h-[100dvh] lg:grid-cols-[1fr_1fr]">
      <aside className="auth-story relative hidden px-10 py-9 lg:flex lg:flex-col xl:px-16">
        <div className="relative flex h-full flex-col">
          <Brand />
          <div className="my-auto max-w-[540px] py-10">
            <p className="mb-4 text-[13px] font-medium text-brand">面试准备 · 原话记录 · 面评协作</p>
            <h1 className="text-[36px] font-semibold leading-[1.4] tracking-tight text-paper xl:text-[42px]">
              让每一句评价，
              <br />
              都能回到原话。
            </h1>
            <p className="mt-5 max-w-[430px] text-[13px] leading-[1.95] text-mist">
              面证把考察标准、追问和面评放在同一条证据链上。面试官少写一点，用人经理多看一点依据。
            </p>

            <figure className="mt-7">
              <div className="auth-interview-frame overflow-hidden rounded-2xl border border-line-soft">
                <img
                  src="/images/auth-interview-v1.webp"
                  width={1536}
                  height={1024}
                  alt="两位职场人士面对面交流，一人专注倾听并用纸笔记录"
                  decoding="async"
                  fetchPriority="high"
                  className="auth-interview-photo block aspect-[16/9] h-auto w-full object-cover"
                />
              </div>
              <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[13px] font-medium text-paper">把注意力留给对话，把判断建立在依据上。</span>
              </figcaption>
            </figure>

            <ol className="auth-steps mt-6" aria-label="面试协作流程">
              <li><span>面试前</span><strong>带着标准准备</strong></li>
              <li><span>面试后</span><strong>对照原话核实</strong></li>
              <li><span>下一轮</span><strong>接着缺口追问</strong></li>
            </ol>

            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-[12px] text-mist">
              <li className="flex items-center gap-1.5">
                <Stamp className="h-3.5 w-3.5 text-human" strokeWidth={1.8} aria-hidden />
                标准由人签字
              </li>
              <li className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-human" strokeWidth={1.8} aria-hidden />
                同意后才开始记录
              </li>
              <li className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-human" strokeWidth={1.8} aria-hidden />
                AI 不给录用结论
              </li>
            </ul>
          </div>
        </div>
      </aside>

      <main className="relative flex min-h-[100dvh] flex-col">
        <div className="flex items-center justify-between px-5 py-4 lg:justify-end lg:px-8">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="flex items-center gap-1">
            <a
              href="/landing.html"
              className="press inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-mist hover:bg-raise hover:text-paper"
            >
              了解面证
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
            </a>
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-8">
          <div className="w-full max-w-[440px]">
            {bootError ? (
              <div className="mb-4 rounded-xl border border-line bg-raise-soft px-3 py-3">
                <p className="text-[12px] leading-relaxed text-mist">连接服务时遇到问题：{bootError}</p>
                <button
                  type="button"
                  onClick={retryBoot}
                  className="press mt-2 text-[12px] font-medium text-brand hover:text-brand-hi"
                >
                  重新连接
                </button>
              </div>
            ) : null}

            <div className="auth-form-card surface-2 px-1 py-4 sm:px-5">
              <Segmented<Mode>
                options={[
                  { id: 'login', label: '登录' },
                  { id: 'register', label: '创建企业' },
                ]}
                value={mode}
                onChange={setMode}
                label="登录或创建企业"
                full
              />

              <div className="mt-6">
                <h2 className="text-[28px] font-semibold leading-tight tracking-tight text-paper">
                  {mode === 'login' ? '登录工作区' : '从第一位成员开始'}
                </h2>
                <p className="mt-2 text-[13px] leading-relaxed text-mist">
                  {mode === 'login'
                    ? '用工作邮箱继续。看到的内容只属于你的企业。'
                    : '创建者就是招聘负责人，之后可以添加面试官和用人经理。'}
                </p>
              </div>

              <form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
                {mode === 'register' ? (
                  <>
                    <Field
                      label="企业名称"
                      value={orgName}
                      onChange={(v) => edit('orgName', v, setOrgName)}
                      placeholder="例如：青山科技"
                      error={errors.orgName}
                      inputRef={orgRef}
                      autoComplete="organization"
                    />
                    <Field
                      label="你的姓名"
                      value={name}
                      onChange={(v) => edit('name', v, setName)}
                      placeholder="例如：李岚"
                      error={errors.name}
                      inputRef={nameRef}
                      autoComplete="name"
                    />
                  </>
                ) : null}

                <Field
                  label="工作邮箱"
                  type="email"
                  value={email}
                  onChange={(v) => edit('email', v, setEmail)}
                  placeholder="you@company.com"
                  error={errors.email}
                  inputRef={emailRef}
                  autoComplete="email"
                  inputMode="email"
                />

                <Field
                  label="密码"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(v) => edit('password', v, setPassword)}
                  placeholder={mode === 'register' ? '至少 8 位，含字母和数字' : '输入登录密码'}
                  error={errors.password}
                  hint={mode === 'register' ? '至少 8 位，同时包含字母和数字。' : undefined}
                  inputRef={passwordRef}
                  inputClassName="pr-10"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  trailing={eyeButton}
                />

                {mode === 'register' ? (
                  <Field
                    label="确认密码"
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(v) => edit('confirm', v, setConfirm)}
                    placeholder="再输入一次"
                    error={errors.confirm}
                    inputRef={confirmRef}
                    inputClassName="pr-10"
                    autoComplete="new-password"
                    trailing={eyeButton}
                  />
                ) : null}

                <ErrorNote message={error} />

                <Btn
                  variant="primary"
                  type="submit"
                  full
                  disabled={busy}
                  busy={busy}
                  busyLabel={mode === 'login' ? '正在登录…' : '正在创建…'}
                  className="mt-1"
                >
                  {mode === 'login' ? '登录' : '创建工作区'}
                </Btn>
              </form>

              {mode === 'login' ? (
                <div className="mt-4 rounded-xl border border-line-soft bg-raise-soft">
                  <button
                    type="button"
                    onClick={() => setShowDemo((prev) => !prev)}
                    aria-expanded={showDemo}
                    className="press flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-mist">
                      <HelpCircle className="h-3.5 w-3.5" aria-hidden />
                      体验 Demo · 选择一个角色
                    </span>
                    <ChevronDown
                      className={cx('h-3.5 w-3.5 text-mist-dim transition-transform', showDemo && 'rotate-180')}
                      aria-hidden
                    />
                  </button>
                  {showDemo ? (
                    <ul className="border-t border-line-soft p-2">
                      {DEMO_ACCOUNTS.map((account) => (
                        <li key={account.email}>
                          <button
                            type="button"
                            onClick={() => {
                              edit('email', account.email, setEmail);
                              setPassword(DEMO_PASSWORD);
                              setError(null);
                            }}
                            disabled={busy}
                            className="press flex w-full flex-wrap items-baseline justify-between gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-raise disabled:opacity-60"
                          >
                            <span className="text-[12px] text-paper">{account.label}</span>
                            <span className="text-[11px] text-mist-dim">{account.email}</span>
                          </button>
                        </li>
                      ))}
                      <li className="px-2 pt-1 text-[11px] leading-relaxed text-mist-dim">
                        点一个角色自动填好，再点「登录」。密码都是 {DEMO_PASSWORD}。共享演示数据为虚构，请勿上传真实简历或录音。
                      </li>
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4">
                {mode === 'login' ? (
                  <>
                    <p className="text-[12px] leading-relaxed text-mist-dim">
                      忘记密码请联系企业的招聘负责人重置。
                    </p>
                    <p className="mt-1.5 text-[12px] text-mist-dim">
                      还没有工作区？
                      <button
                        type="button"
                        onClick={() => setMode('register')}
                        className="press ml-1 font-medium text-brand hover:text-brand-hi"
                      >
                        创建一个
                      </button>
                    </p>
                  </>
                ) : (
                  <p className="text-[12px] text-mist-dim">
                    已经有账号？
                    <button
                      type="button"
                      onClick={() => setMode('login')}
                      className="press ml-1 font-medium text-brand hover:text-brand-hi"
                    >
                      直接登录
                    </button>
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <footer className="px-5 pb-5 text-center text-[12px] leading-relaxed text-mist-dim lg:px-8">
          登录状态保留 14 天 · 修改密码后其他设备会退出 · 候选人数据仅企业成员可见
        </footer>
      </main>
    </div>
  );
}
