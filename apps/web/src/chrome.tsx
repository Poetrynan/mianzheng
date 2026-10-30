import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { applyTheme, currentTheme, type Theme } from './theme';
import { cx } from './ui';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <img
        src="/mark-on-light.png"
        alt=""
        aria-hidden="true"
        className={cx('mark-for-light shrink-0', compact ? 'h-7 w-7' : 'h-8 w-8')}
      />
      <img
        src="/mark-on-dark.png"
        alt=""
        aria-hidden="true"
        className={cx('mark-for-dark shrink-0', compact ? 'h-7 w-7' : 'h-8 w-8')}
      />
      <span className="min-w-0">
        <span
          className={cx(
            'block font-serif font-bold leading-tight tracking-[0.03em] text-paper',
            compact ? 'text-[15px]' : 'text-[17px]',
          )}
        >
          面证
        </span>
        <span className="block text-[11px] leading-tight text-mist">面试官副驾</span>
      </span>
    </div>
  );
}

export function ThemeToggle({ className, showLabel = false }: { className?: string; showLabel?: boolean }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const isLight = theme === 'light';
  const next: Theme = isLight ? 'dark' : 'light';
  const label = isLight ? '切换为深色模式' : '切换为浅色模式';
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      title={label}
      aria-label={label}
      className={cx(
        'press flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-mist hover:bg-raise hover:text-paper',
        className,
      )}
    >
      {isLight ? <Sun className="h-3.5 w-3.5 shrink-0" strokeWidth={2} /> : <Moon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
      {showLabel ? <span>{isLight ? '浅色' : '深色'}</span> : null}
    </button>
  );
}
