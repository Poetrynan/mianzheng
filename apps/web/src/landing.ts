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
  steps.forEach((button, i) => button.setAttribute('aria-pressed', String(i + 1 === stage)));
};
steps.forEach((button, i) => button.addEventListener('click', () => applyStage(i + 1)));
applyStage(4);

const featureTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-product-tab]'));
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
