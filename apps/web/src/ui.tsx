import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { AlertTriangle, Check as CheckIcon, Info, Inbox, type LucideIcon } from 'lucide-react';
import type {
  BoardLight,
  CandidateStatus,
  DimensionCheckStatus,
  DraftStatus,
  InterviewStatus,
  ReminderLevel,
  ScoreLevel,
} from './api/types';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/**
 * A scrolling region that stops in the middle of a line reads as a broken render. This watches the
 * region and reports whether there is still something below, so the caller can soften the edge.
 * The region can mount long after the data arrives (a tab that opens later), so every render checks
 * again instead of trusting the first measurement.
 */
export function useBottomFade<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [more, setMore] = useState(false);

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);

  useEffect(sync);

  return { ref, more, sync };
}

/**
 * Server enums never reach the screen verbatim; these maps are the only place a status is translated.
 * Add a status to the type and TypeScript forces a label here.
 */
export const INTERVIEW_LABEL: Record<InterviewStatus, string> = {
  scheduled: '已排期',
  in_progress: '面试中',
  audio_done: '等待面评',
  eval_pending: '待面评',
  expired: '已超期',
  eval_submitted: '已面评',
};

export const DRAFT_LABEL: Record<DraftStatus, string> = {
  ai_draft: 'AI 草稿',
  human_revising: '修改中',
  submitted: '已提交',
  archived: '已归档',
};

export const STANDARD_LABEL: Record<'draft' | 'confirmed' | 'archived', string> = {
  draft: '草案',
  confirmed: '已定稿',
  archived: '已归档',
};

export const CHECK_LABEL: Record<DimensionCheckStatus, string> = {
  auto_filled: 'AI 填写',
  human_revised: '人已修改',
  resubmitted: '已重新提交',
};

export const REMINDER_STATUS_LABEL: Record<'queued' | 'sent' | 'acknowledged', string> = {
  queued: '待发送',
  sent: '已发送',
  acknowledged: '已知悉',
};

export const REMINDER_LEVEL_LABEL: Record<ReminderLevel, string> = {
  24: '24 小时提醒',
};

export const CANDIDATE_LABEL: Record<CandidateStatus, string> = {
  new: '新投递',
  screening: '初筛',
  interview: '面试中',
  offer: '录用意向',
  hired: '已入职',
  rejected: '不合适',
};

export const CHANNEL_LABEL: Record<'video' | 'phone' | 'onsite', string> = {
  video: '视频面',
  phone: '电话面',
  onsite: '现场面',
};

export const ROLE_LABEL: Record<'hr' | 'interviewer' | 'hiring_manager' | 'candidate', string> = {
  hr: '招聘负责人',
  interviewer: '面试官',
  hiring_manager: '用人经理',
  candidate: '候选人',
};

export const ACTOR_LABEL: Record<'human' | 'ai' | 'system', string> = {
  human: '人的操作',
  ai: 'AI 生成',
  system: '系统自动',
};

export const PROTECTED_LABEL: Record<string, string> = {
  gender: '性别',
  age: '年龄',
  marital_or_fertility: '婚育',
  ethnicity_or_religion: '民族与宗教',
  region_or_hukou: '籍贯与户籍',
  appearance: '外貌身形',
  disability: '残障',
  sexual_orientation: '性取向',
};

export const CLAIM_REASON_LABEL: Record<'no_evidence' | 'quote_not_in_transcript' | 'unknown_segment', string> = {
  no_evidence: '没有原文支撑',
  quote_not_in_transcript: '引文与原文对不上',
  unknown_segment: '引用的片段已不存在',
};

const AUDIT_LABEL: Record<string, string> = {
  'standard.intake': '岗位信息入库',
  'standard.answer': '记录一轮访谈回答',
  'standard.propose': 'AI 起草考察维度',
  'standard.from_template': '套用维度模板',
  'standard.conflict_resolved': '裁定维度冲突',
  'standard.revise_dimension': '修订考察维度',
  'standard.confirm_dimension': '逐项确认维度',
  'standard.finalize': '金标准定稿',
  'resume.submit': '简历提交并解析',
  'prep_pack.build': '生成面试准备包',
  'prep_pack.add_question': '补充追问',
  'prep_pack.veto_question': '否决一条追问',
  'interview.schedule': '排定面试',
  'interview.start': '面试开始',
  'interview.finish': '面试结束',
  'interview.restart': '重启面试',
  'interview.expire': '面评超期',
  'interview.pause_ai': '暂停记录',
  'interview.resume_ai': '恢复记录',
  'consent.answered': '候选人回应知情同意',
  'transcript.append': '写入转写内容',
  'transcript.correct': '人工修正转写',
  'draft.generate': 'AI 起草面评',
  'draft.revise_check': '人工修订维度评价',
  'draft.set_recommendation': '保存推荐意见',
  'draft.submit': '面评提交',
  'reminder.queue': '排定催办阶梯',
  'reminder.acknowledge': '面试官已知悉催办',
  'reminder.suspend': '挂起催办',
  'reminder.resume': '恢复催办计时',
  'reminder.disable': '关闭催办',
  'reminder.delay_cadence': '放宽某位面试官的催办节奏',
  'candidate.deletion_requested': '登记候选人删除请求',
  'candidate.hardened': '删除请求到期处理',
  'compliance.retention_sweep': '执行到期清理',
  'evaluation.human_review_requested': '建立人工复核',
  'standard.sign.hiring_manager': '用人经理确认标准',
  'standard.sign.hr': 'HR 确认标准',
  'prep_pack.agent_repair': '补齐一页纸',
  'draft.agent_assemble': 'AI 起草面评',
  'draft.gap_disposition': '处理证据缺口',
  'transcript.import': '导入转写内容',
  'agent.run.start': '开始生成',
  'agent.run.ask': '等你回答',
  'agent.run.answer': '记录你的回答',
  'agent.run.finish': '生成完成',
  'agent.run.stop': '停止生成',
};

const AUDIT_SCOPE: Record<string, string> = {
  standard: '金标准',
  prep_pack: '准备包',
  interview: '面试',
  transcript: '转写',
  consent: '知情同意',
  draft: '面评',
  reminder: '催办',
  candidate: '候选人',
  compliance: '合规',
  evaluation: '面评',
  agent: '助手',
};

const ENUM_LABELS: Record<string, string> = {
  ...INTERVIEW_LABEL,
  ...DRAFT_LABEL,
  ...STANDARD_LABEL,
  ...CANDIDATE_LABEL,
  ...REMINDER_STATUS_LABEL,
  ...CHECK_LABEL,
  ...CHANNEL_LABEL,
  ...PROTECTED_LABEL,
};

/**
 * Last line of defence between server prose and the screen: identifiers and leftover enum tokens are
 * the two ways engineering vocabulary still slips into a message, and neither belongs in front of HR.
 */
export function plainText(message: string): string {
  const stripped = message
    .replace(/[（(]\s*(?:当前|状态)?\s*([a-z][a-z0-9_]{2,})\s*[）)]/g, (_, token: string) => `（${ENUM_LABELS[token] ?? ''}）`)
    .replace(/\b[a-z]{2,14}_?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[a-z]{2,14}_[0-9a-f]{8,}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b([a-z][a-z0-9_]{2,})\b/g, (token) => ENUM_LABELS[token] ?? token)
    .replace(/([一-鿿]{2,})\((\1)\)/g, '$1')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/([　-〿一-鿿＀-￯])\s+(?=[一-鿿])/g, '$1')
    .replace(/ {2,}|(\S) +([，。；、）])/g, '$1$2')
    .replace(/^\s+|[ \t]+\n/g, '');
  return stripped;
}

/** 审计列表是人读的。已知动作给中文名；未知动作也不把机器码端到界面上。 */
export function describeAudit(action: string): string {
  const exact = AUDIT_LABEL[action];
  if (exact) return exact;
  const send = /^reminder\.send\.(\d+)h$/.exec(action);
  if (send?.[1]) return `发送 ${send[1]} 小时催办`;
  const scope = AUDIT_SCOPE[action.split('.')[0] ?? ''];
  return scope ? `${scope}操作` : '其他操作';
}

/** `2026-10-21T09:14:33.120Z` reads as noise; board and audit rows need a scannable timestamp. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LIGHT: Record<BoardLight, { dot: string; label: string; tone: Tone }> = {
  idle: { dot: 'bg-mist-dim', label: '未开始', tone: 'idle' },
  waiting: { dot: 'bg-ok', label: '进行中', tone: 'ok' },
  attention: { dot: 'bg-warn', label: '已到时限', tone: 'warn' },
  overdue: { dot: 'bg-bad', label: '已标记失效', tone: 'bad' },
  done: { dot: 'bg-brand', label: '已面评', tone: 'ai' },
};

export function Light({ light }: { light: BoardLight }) {
  const cfg = LIGHT[light];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-paper" title={cfg.label}>
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', cfg.dot, cfg.tone === 'bad' && 'animate-pulse')} />
      {cfg.label}
    </span>
  );
}

type Tone = 'ai' | 'human' | 'ok' | 'warn' | 'bad' | 'idle' | 'info';

const BADGE_TONE: Record<Tone, string> = {
  ai: 'bg-brand/12 text-tint-brand border-brand/25',
  human: 'bg-human/12 text-tint-human border-human/25',
  ok: 'bg-ok/12 text-tint-ok border-ok/25',
  warn: 'bg-warn/12 text-tint-warn border-warn/25',
  bad: 'bg-bad/12 text-tint-bad border-bad/25',
  idle: 'bg-raise-soft text-mist border-line',
  info: 'bg-raise text-paper/85 border-line',
};

/** A panel's tone lives in its surface, not in a stripe down the left edge. */
const PANEL_TONE: Record<string, string> = {
  default: '',
  ai: '',
  human: '',
  danger: 'tone-danger',
  warn: 'tone-warn',
};

const ICON_TINT: Record<string, string> = {
  default: 'bg-raise text-mist',
  ai: 'bg-brand/12 text-tint-brand',
  human: 'bg-human/12 text-tint-human',
  danger: 'bg-bad/12 text-tint-bad',
  warn: 'bg-warn/12 text-tint-warn',
};

export function Panel({
  title,
  subtitle,
  icon: Icon,
  right,
  children,
  tone = 'default',
  headingLevel = 2,
  className,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  right?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'ai' | 'human' | 'danger' | 'warn';
  /** 2 for a top-level panel, 3 when the panel sits inside another titled block. */
  headingLevel?: 2 | 3;
  className?: string;
}) {
  return (
    <section className={cx('surface-2 p-5', PANEL_TONE[tone], className)}>
      <header className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {Icon ? (
              <span className={cx('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', ICON_TINT[tone])}>
                <Icon className="h-4 w-4" strokeWidth={1.9} aria-hidden />
              </span>
            ) : null}
            <div className="min-w-0">
              {headingLevel === 3 ? (
                <h3 className="text-[14px] leading-snug text-paper">{title}</h3>
              ) : (
                <h2 className="text-[15px] leading-snug text-paper">{title}</h2>
              )}
            </div>
          </div>
          {right ? <div className="shrink-0">{right}</div> : null}
        </div>
        {subtitle ? (
          <p className={cx('mt-1 text-[12px] leading-relaxed text-mist', Icon && 'pl-10')}>{subtitle}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function Badge({ tone = 'info', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full border px-2 py-[3px] text-[12px] font-medium leading-none whitespace-nowrap',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function InterviewPill({ status }: { status: InterviewStatus }) {
  const tone: Tone = status === 'expired' ? 'bad' : status === 'eval_submitted' ? 'ai' : status === 'eval_pending' ? 'warn' : 'idle';
  return <Badge tone={tone}>{INTERVIEW_LABEL[status]}</Badge>;
}

/** Selectable pill used for jobs, interviewers and drafts — one place owns the selected/hover states. */
export function Chip({
  children,
  selected,
  onClick,
  disabled,
  right,
}: {
  children: ReactNode;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  right?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cx(
        'press flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-[13px] disabled:pointer-events-none disabled:opacity-40',
        selected
          ? 'border-brand/55 bg-brand/12 text-paper shadow-[var(--hair)]'
          : 'border-line bg-raise-soft text-mist hover:border-line-hi hover:bg-raise hover:text-paper',
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {right ? <span className="flex shrink-0 items-center gap-1.5">{right}</span> : null}
    </button>
  );
}

export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2 text-[13px] leading-relaxed text-mist hover:text-paper', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-brand"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * A heading for a block inside a panel. It replaces the old decorative kicker: the heading carries
 * the weight itself, so no smaller label sits above it saying the same thing.
 */
export function Subhead({
  children,
  icon: Icon,
  as = 3,
  className,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  as?: 3 | 4;
  className?: string;
}) {
  const Tag = as === 4 ? 'h4' : 'h3';
  return (
    <Tag className={cx('flex items-center gap-1.5 text-[14px] font-semibold leading-snug text-paper', as === 4 && 'text-[13px]', className)}>
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-mist-dim" strokeWidth={1.9} aria-hidden /> : null}
      {children}
    </Tag>
  );
}

/** A plain label naming a group of controls or a list. It is not a heading and sits below one. */
export function Label({ children, icon: Icon, className }: { children: ReactNode; icon?: LucideIcon; className?: string }) {
  return (
    <p className={cx('flex items-center gap-1.5 text-[12px] font-medium text-mist', className)}>
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-mist-dim" strokeWidth={1.9} aria-hidden /> : null}
      {children}
    </p>
  );
}

export function Btn({
  children,
  onClick,
  variant = 'secondary',
  icon: Icon,
  disabled,
  type = 'button',
  full,
  className,
  busy,
  busyLabel,
  title,
  disabledReason,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  icon?: LucideIcon;
  disabled?: boolean;
  type?: 'button' | 'submit';
  full?: boolean;
  className?: string;
  busy?: boolean;
  /** 进行中的文案。给出后按钮宽度按两条文案里较长的那条锁定，切换时旁边的控件不会跟着挪。 */
  busyLabel?: ReactNode;
  title?: string;
  /** 按钮不可用时，把原因写进提示，别让人对着一个灰按钮猜。 */
  disabledReason?: string;
}) {
  const styles =
    variant === 'primary'
      ? 'border border-transparent bg-brand text-on-brand font-semibold shadow-[var(--btn-accent-shadow)] hover:bg-brand-hi'
      : variant === 'danger'
        ? 'border border-bad/30 bg-bad/10 text-tint-bad hover:bg-bad/[0.18]'
        : variant === 'quiet'
          ? 'border border-transparent text-mist hover:bg-raise hover:text-paper'
          : 'border border-line bg-raise text-paper hover:border-line-hi hover:bg-raise-hi';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title ?? (disabled ? disabledReason : undefined)}
      aria-busy={busy || undefined}
      className={cx(
        'press inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium whitespace-nowrap',
        'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none',
        full && 'w-full',
        styles,
        className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> : null}
      {busyLabel === undefined ? (
        children
      ) : (
        <span className="lock-slot">
          <span className={cx(busy && 'invisible')}>{children}</span>
          <span className={cx(!busy && 'invisible')}>{busyLabel}</span>
        </span>
      )}
    </button>
  );
}

/**
 * A labelled field. The label is a real <label> for the control, and a message — an error first,
 * then the hint — is wired to that control through aria-describedby, so a screen reader says why
 * the field is not accepted instead of only saying that something is wrong.
 */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  hint,
  error,
  required,
  disabled,
  type = 'text',
  rows = 4,
  id,
  trailing,
  inputClassName,
  inputRef,
  autoComplete,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  rows?: number;
  id?: string;
  /** A control that lives inside the field's right edge — the eye toggle on a password box. */
  trailing?: ReactNode;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'numeric' | 'tel' | 'url' | 'search';
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const errorId = error ? `${fieldId}-error` : null;
  const hintId = hint ? `${fieldId}-hint` : null;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const input = (
    <input
      id={fieldId}
      ref={inputRef as Ref<HTMLInputElement>}
      type={type}
      className={cx('field-base text-[13px]', inputClassName)}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      autoComplete={autoComplete}
      inputMode={inputMode}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  const control = multiline ? (
    <textarea
      id={fieldId}
      ref={inputRef as Ref<HTMLTextAreaElement>}
      rows={rows}
      className="field-base resize-y text-[13px] leading-relaxed"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    />
  ) : trailing ? (
    <span className="relative block">
      {input}
      {trailing}
    </span>
  ) : (
    input
  );

  return (
    <label htmlFor={fieldId} className={cx('block', disabled && 'opacity-60')}>
      <span className="mb-1.5 block text-[12px] font-medium text-mist">
        {label}
        {required ? <span className="ml-1 text-tint-bad">必填</span> : null}
      </span>
      {control}
      {error ? (
        <span id={errorId ?? undefined} className="mt-1.5 block text-[12px] leading-relaxed text-tint-bad">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={hintId ?? undefined} className="mt-1.5 block text-[12px] leading-relaxed text-mist-dim">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Select({
  label,
  value,
  onChange,
  children,
  error,
  hint,
  required,
  disabled,
  id,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  children: ReactNode;
  error?: string | null;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const errorId = error ? `${fieldId}-error` : null;
  const hintId = hint ? `${fieldId}-hint` : null;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <label htmlFor={fieldId} className={cx('block', disabled && 'opacity-60')}>
      {label ? (
        <span className="mb-1.5 block text-[12px] font-medium text-mist">
          {label}
          {required ? <span className="ml-1 text-tint-bad">必填</span> : null}
        </span>
      ) : null}
      <select
        id={fieldId}
        className="field-base text-[13px]"
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      {error ? (
        <span id={errorId ?? undefined} className="mt-1.5 block text-[12px] leading-relaxed text-tint-bad">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={hintId ?? undefined} className="mt-1.5 block text-[12px] leading-relaxed text-mist-dim">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

const NOTE_TONE: Record<'bad' | 'ok' | 'info', { wrap: string; icon: LucideIcon }> = {
  bad: { wrap: 'border-bad/25 bg-bad/[0.08] text-tint-bad', icon: AlertTriangle },
  ok: { wrap: 'border-ok/25 bg-ok/[0.07] text-tint-ok', icon: CheckIcon },
  info: { wrap: 'border-line bg-raise-soft text-mist', icon: Info },
};

/**
 * Server rejections sometimes carry a machine prefix (`gate_code · 人话说明`). Only the sentence
 * belongs on screen; the code remains in logs and API responses where support can quote it.
 */
function Note({ message, kind }: { message: string | null; kind: 'bad' | 'ok' | 'info' }) {
  if (!message) return null;
  const cfg = NOTE_TONE[kind];
  const split = /^([a-z][a-z0-9_]{2,}) · ([\s\S]*)$/.exec(message);
  const text = plainText(split?.[2] ?? message);
  const Icon = cfg.icon;
  return (
    <div className={cx('mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed', cfg.wrap)}>
      <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  return <Note message={message} kind="bad" />;
}

export function OkNote({ message }: { message: string | null }) {
  return <Note message={message} kind="ok" />;
}

export function InfoNote({ message }: { message: string | null }) {
  return <Note message={message} kind="info" />;
}

function Metric({ label, value, hint, tone = 'default' }: { label: string; value: string | number; hint?: string; tone?: 'default' | 'bad' | 'warn' | 'ok' }) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-paper';
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-mist">{label}</p>
      <p className={cx('num mt-1 text-[20px] font-semibold leading-none', color)}>{value}</p>
      {hint ? <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">{hint}</p> : null}
    </div>
  );
}

/**
 * A row of figures on one baseline, separated by whitespace and a single hairline — not four
 * cards of the same size pretending to be a row.
 */
export function StatStrip({
  items,
  className,
}: {
  items: Array<{ label: string; value: string | number; hint?: string; tone?: 'default' | 'bad' | 'warn' | 'ok' }>;
  className?: string;
}) {
  return (
    <dl className={cx('grid grid-cols-2 gap-x-6 gap-y-4 border-y border-line-soft py-4', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <Metric {...item} />
        </div>
      ))}
    </dl>
  );
}

export function Empty({ text, icon: Icon = Inbox }: { text: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <Icon className="h-5 w-5 text-mist-dim" strokeWidth={1.6} aria-hidden />
      <p className="text-[12px] leading-relaxed text-mist-dim">{text}</p>
    </div>
  );
}

/** Waiting for data is not the same as having none: this shows the shape of what is coming. */
export function Loading({ label = '正在加载', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-raise-soft p-4" role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cx('skeleton h-3 rounded', i === 0 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  );
}

/** Timestamps in the transcript are milliseconds from session start. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const SCORE_LABEL: Record<ScoreLevel, string> = { high: '达标', medium: '部分达标', low: '不达标' };

const scoreTone = (s: ScoreLevel | null): Tone => (s === null ? 'idle' : s === 'high' ? 'ok' : s === 'medium' ? 'warn' : 'bad');

/** AI 初评 uses the cool accent, 我的终评 uses the warm human accent — the two columns never look interchangeable. */
export function ScoreRow({ ai, final }: { ai: ScoreLevel | null; final: ScoreLevel | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[12px] text-mist-dim">AI 初评</span>
      <Badge tone={scoreTone(ai)} className="min-w-[88px]">{ai ? SCORE_LABEL[ai] : '没有原话支撑'}</Badge>
      <span className="mx-1 h-3.5 w-px bg-line" aria-hidden />
      <span className="text-[12px] text-mist-dim">我的终评</span>
      <Badge tone={final ? 'human' : 'idle'} className="min-w-[88px]">{final ? SCORE_LABEL[final] : '待你确认'}</Badge>
    </div>
  );
}

/**
 * One control for choosing between a small set of options. The three score buttons used to be three
 * unrelated buttons; as a radio group they say what they are, and the arrow keys move between them.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  disabledReason,
  full,
  className,
}: {
  options: Array<{ id: T; label: string; badge?: string | number; icon?: LucideIcon }>;
  value: T | null;
  onChange: (id: T) => void;
  /** The group's name for screen readers: 「考察维度」「这一页纸的可选说明」. */
  label?: string;
  disabled?: boolean;
  /** 整组不可用时，把原因写进提示，别让人对着一排灰按钮猜。 */
  disabledReason?: string;
  full?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (event: KeyboardEvent, index: number) => {
    const total = options.length;
    if (total === 0) return;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % total;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + total) % total;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = total - 1;
    else return;
    event.preventDefault();
    onChange(options[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      title={disabled ? disabledReason : undefined}
      className={cx(
        'inline-flex flex-wrap items-center gap-1 rounded-xl border border-line/80 bg-ink-1000/60 p-1',
        !full && 'w-fit',
        full && 'flex w-full',
        className,
      )}
    >
      {options.map((option, index) => {
        const on = option.id === value;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (value === null && index === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => move(event, index)}
            className={cx(
              'press flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-medium transition',
              full && 'flex-1',
              on
                ? 'bg-brand font-semibold text-on-brand'
                : 'text-mist hover:bg-raise-soft hover:text-paper',
              disabled && 'pointer-events-none opacity-40',
            )}
          >
            {Icon ? <Icon className={cx('h-3.5 w-3.5', on ? 'text-on-brand' : 'text-mist-dim')} strokeWidth={2} aria-hidden /> : null}
            <span>{option.label}</span>
            {option.badge !== undefined ? (
              <span
                className={cx(
                  'num rounded-full px-1.5 py-0.2 text-[11px]',
                  on ? 'bg-on-brand/15 text-on-brand' : 'bg-raise-hi text-mist-dim',
                )}
              >
                {option.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Animated speech / sound visualizer for live recording */
export function AudioWaveVisualizer({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-[3px] px-2 py-1" title={active ? '正在记录并转写' : '记录已暂停'}>
      <span className={cx('w-[3px] rounded-full bg-brand', active ? 'wave-bar wave-bar-1' : 'h-1 opacity-35')} />
      <span className={cx('w-[3px] rounded-full bg-brand', active ? 'wave-bar wave-bar-2' : 'h-1 opacity-35')} />
      <span className={cx('w-[3px] rounded-full bg-brand', active ? 'wave-bar wave-bar-3' : 'h-1 opacity-35')} />
      <span className={cx('w-[3px] rounded-full bg-brand', active ? 'wave-bar wave-bar-4' : 'h-1 opacity-35')} />
      <span className={cx('w-[3px] rounded-full bg-brand', active ? 'wave-bar wave-bar-5' : 'h-1 opacity-35')} />
    </div>
  );
}

/** Visual workflow stepper for multi-step processes */
export function WorkflowStepper({
  steps,
  current,
  onSelect,
}: {
  steps: Array<{ index: number; label: string; desc?: string; done?: boolean }>;
  current: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-4">
      {steps.map((s) => {
        const on = s.index === current;
        const done = s.done ?? s.index < current;
        return (
          <div key={s.index} className="flex items-center gap-2">
            {s.index > 1 ? <span className="text-[11px] text-mist-dim">→</span> : null}
            <button
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(s.index)}
              className={cx(
                'press flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]',
                on
                  ? 'border border-brand/50 bg-brand/15 text-paper font-semibold'
                  : done
                    ? 'border border-ok/30 bg-ok/[0.08] text-tint-ok'
                    : 'border border-line/60 bg-raise-soft text-mist-dim',
              )}
            >
              <span
                className={cx(
                  'num grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                  on
                    ? 'bg-brand text-on-brand'
                    : done
                      ? 'bg-ok text-on-brand'
                      : 'bg-raise text-mist',
                )}
              >
                {done ? '✓' : s.index}
              </span>
              <span>{s.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
