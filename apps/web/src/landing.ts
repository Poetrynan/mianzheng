/** Public examples are local illustrations of the workflow, never real candidate data. */
export {};
const root = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');
const syncThemeLabel = () => themeToggle?.setAttribute('aria-label', root.dataset.theme === 'dark' ? '切换为浅色模式' : '切换为深色模式');
syncThemeLabel();
themeToggle?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('mianzheng.theme.v1', next); } catch { /* Theme still works without storage. */ }
  syncThemeLabel();
});

const menuButton = document.getElementById('nav-toggle');
const menu = document.getElementById('nav-menu');
const closeMenu = (focus = false) => {
  if (!menu || !menuButton) return;
  menu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', '打开导航菜单');
  if (focus) menuButton.focus();
};
menuButton?.addEventListener('click', () => {
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
});
menu?.addEventListener('click', (e) => { if ((e.target as Element).closest('a')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu && !menu.hidden) closeMenu(true); });
document.addEventListener('click', (e) => {
  if (menu && !menu.hidden && !menu.contains(e.target as Node) && !menuButton?.contains(e.target as Node)) closeMenu();
});
const desktop = matchMedia('(min-width: 1024px)');
desktop.addEventListener('change', () => { if (desktop.matches) closeMenu(); });

const demo = document.getElementById('demo');
const steps = Array.from(demo?.querySelectorAll<HTMLButtonElement>('.demo-steps button') ?? []);
const applyStage = (stage: number) => {
  if (!demo) return;
  demo.dataset.stage = String(stage);
  for (const [selector, show] of [
    ['[data-in]', (el: HTMLElement) => stage >= Number(el.dataset.in)],
    ['[data-only]', (el: HTMLElement) => stage === Number(el.dataset.only)],
    ['[data-upto]', (el: HTMLElement) => stage <= Number(el.dataset.upto)],
  ] as const) {
    demo.querySelectorAll<HTMLElement>(selector).forEach((el) => { el.hidden = !show(el); });
  }
  demo.querySelectorAll('[data-mark]').forEach((el) => el.classList.toggle('mark', stage >= 2));
  demo.querySelectorAll('[data-pick]').forEach((el) => el.classList.toggle('on', stage >= 4));
  steps.forEach((button, i) => {
    button.setAttribute('aria-pressed', String(i + 1 === stage));
    button.toggleAttribute('data-done', i + 1 < stage);
  });
};

/**
 * 版面锁定：把四步依次套一遍，取最高的那一步作为固定高度。
 * 只读布局、不经过绘制，所以用户看不到这次试排；字体加载完和窗口变化时重算。
 */
const panes = demo?.querySelector<HTMLElement>('.demo-panes');
const bar = demo?.querySelector<HTMLElement>('.demo-bar');
const think = demo?.querySelector<HTMLElement>('.demo-think');
let stage = 1;
const lockLayout = () => {
  if (!demo || !panes || !bar) return;
  demo.style.removeProperty('--demo-panes-h');
  demo.style.removeProperty('--demo-bar-h');
  demo.style.removeProperty('--demo-think-h');
  let paneH = 0;
  let barH = 0;
  let thinkH = 0;
  for (let s = 1; s <= steps.length; s++) {
    applyStage(s);
    paneH = Math.max(paneH, panes.scrollHeight);
    barH = Math.max(barH, bar.offsetHeight);
    thinkH = Math.max(thinkH, think?.offsetHeight ?? 0);
  }
  applyStage(stage);
  demo.style.setProperty('--demo-panes-h', `${Math.ceil(paneH)}px`);
  demo.style.setProperty('--demo-bar-h', `${Math.ceil(barH)}px`);
  if (think) demo.style.setProperty('--demo-think-h', `${Math.ceil(thinkH)}px`);
};

/**
 * 自动播放：当前步的进度条走满（animationend）就进入下一步，最后一步走满后从头再来。
 * 进度条和画面由同一个动画驱动，暂停时两者一起停：鼠标停在演示上、键盘焦点在里面、
 * 演示滚出视口或页面切到后台时都会暂停。系统要求减少动效时不自动播放，停在最后一步。
 */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const holds = new Set<string>();
const setHold = (reason: string, on: boolean) => {
  if (on) holds.add(reason); else holds.delete(reason);
  demo?.toggleAttribute('data-paused', holds.size > 0);
};
const goTo = (next: number) => {
  stage = next;
  const active = steps[next - 1];
  // 重复点同一步时，先取消选中再选中，让进度条从头开始。
  active?.setAttribute('aria-pressed', 'false');
  void active?.offsetWidth;
  applyStage(next);
};

if (demo) {
  steps.forEach((button, i) => {
    button.addEventListener('click', () => goTo(i + 1));
    button.querySelector('.bar i')?.addEventListener('animationend', () => {
      if (stage === i + 1 && !reduceMotion.matches) goTo(stage % steps.length + 1);
    });
  });

  demo.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') setHold('hover', true); });
  demo.addEventListener('pointerleave', () => setHold('hover', false));
  demo.addEventListener('focusin', () => setHold('focus', true));
  demo.addEventListener('focusout', (e) => { if (!demo.contains(e.relatedTarget as Node)) setHold('focus', false); });
  document.addEventListener('visibilitychange', () => setHold('hidden', document.hidden));
  new IntersectionObserver(([entry]) => setHold('offscreen', !entry?.isIntersecting), { threshold: 0.25 }).observe(demo);

  stage = reduceMotion.matches ? steps.length : 1;
  lockLayout();
  void document.fonts?.ready.then(lockLayout);
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(lockLayout, 150);
  });
}

/** 导航滚动后加阴影；分区内容进入视口时依次浮现（同一组里按顺序错开 80ms）。 */
const nav = document.querySelector<HTMLElement>('.nav');
const syncNav = () => nav?.toggleAttribute('data-scrolled', scrollY > 8);
syncNav();
addEventListener('scroll', syncNav, { passive: true });

const revealables = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
if (revealables.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  root.classList.add('js-reveal');
  const groups = new Map<Element | null, number>();
  for (const el of revealables) {
    const n = groups.get(el.parentElement) ?? 0;
    groups.set(el.parentElement, n + 1);
    el.style.setProperty('--rd', `${Math.min(n, 5) * 80}ms`);
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  revealables.forEach((el) => io.observe(el));
}

const featureTabs =Array.from(document.querySelectorAll<HTMLButtonElement>('[data-product-tab]'));
const featurePanels = Array.from(document.querySelectorAll<HTMLElement>('[data-product-panel]'));
const selectFeature = (index: number, focus = false) => {
  featureTabs.forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === index));
    button.tabIndex = i === index ? 0 : -1;
    if (focus && i === index) button.focus();
  });
  featurePanels.forEach((panel, i) => { panel.hidden = i !== index; });
};
featureTabs.forEach((button, i) => {
  button.addEventListener('click', () => selectFeature(i));
  button.addEventListener('keydown', (e) => {
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % featureTabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + featureTabs.length) % featureTabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = featureTabs.length - 1;
    else return;
    e.preventDefault();
    selectFeature(next, true);
  });
});
selectFeature(0);
