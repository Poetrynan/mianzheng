export type Theme = 'dark' | 'light';

const KEY = 'mianzheng.theme.v1';
const THEME_EVENT = 'mianzheng:theme-change';
const THEME_COLOR: Record<Theme, string> = { dark: '#0c1116', light: '#eef1f5' };

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function subscribeTheme(listener: () => void): () => void {
  window.addEventListener(THEME_EVENT, listener);
  return () => window.removeEventListener(THEME_EVENT, listener);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 浏览器禁用存储时本次仍然生效，只是回到系统偏好。
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
