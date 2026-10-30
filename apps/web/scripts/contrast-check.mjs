/*
 * Reads the two token blocks (dark in `@theme`, light in `html[data-theme='light']`) and checks
 * every text/background pair the UI actually paints against WCAG 2.1 relative luminance.
 * Run: npm run contrast
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function block(src, opener) {
  const start = src.indexOf(opener);
  if (start < 0) throw new Error(`token block not found: ${opener}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i + 1;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(from, i);
}

function tokens(text) {
  const map = new Map();
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    map.set(m[1].replace(/^color-/, ''), m[2]);
  }
  return map;
}

function load(cssPath, darkOpener, lightOpener) {
  const src = readFileSync(cssPath, 'utf8');
  const dark = tokens(block(src, darkOpener));
  const light = new Map(dark);
  for (const [k, v] of tokens(block(src, lightOpener))) light.set(k, v);
  return { dark, light };
}

const themes = {
  app: load(path.join(ROOT, 'apps/web/src/styles.css'), '@theme', "html[data-theme='light']"),
  landing: load(path.join(ROOT, 'apps/web/landing.html'), ':root {', ":root[data-theme='light']"),
};

const PAIRS = [
  ['正文 / 页面底色', 'paper', 'ink-950', 4.5],
  ['正文 / 卡片底色', 'paper', 'ink-900', 4.5],
  ['次要文字 / 页面底色', 'mist', 'ink-950', 4.5],
  ['次要文字 / 卡片底色', 'mist', 'ink-900', 4.5],
  ['三级文字 / 页面底色', 'mist-dim', 'ink-950', 4.5],
  ['三级文字 / 卡片底色', 'mist-dim', 'ink-900', 4.5],
  ['主按钮文字 / 主按钮底色', 'on-brand', 'brand', 4.5],
  ['强调文字 / 卡片底色', 'brand', 'ink-900', 4.5],
  ['人工色文字 / 卡片底色', 'human', 'ink-900', 4.5],
  ['状态·通过 / 卡片底色', 'ok', 'ink-900', 4.5],
  ['状态·提醒 / 卡片底色', 'warn', 'ink-900', 4.5],
  ['状态·不通过 / 卡片底色', 'bad', 'ink-900', 4.5],
  ['大字号数字 / 页面底色', 'brand', 'ink-950', 3.0],
  ['输入框描边 / 页面底色', 'line-field', 'ink-950', 3.0],
];

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const lines = [];
let failures = 0;
for (const [surface, theme] of Object.entries(themes)) {
  for (const mode of ['dark', 'light']) {
    const map = theme[mode];
    lines.push('', `## ${surface} · ${mode === 'dark' ? '深色' : '浅色'}`);
    for (const [label, fg, bg, min] of PAIRS) {
      const f = map.get(fg);
      const b = map.get(bg);
      if (!f) {
        lines.push(`SKIP   ------  ≥${min}  ${label}  ${surface} 没有定义 ${fg}，这个界面用不到它`);
        continue;
      }
      if (!b) {
        lines.push(`FAIL   MISSING  ${label}  底色令牌 ${bg} 不存在`);
        failures += 1;
        continue;
      }
      const r = ratio(f, b);
      const ok = r >= min;
      if (!ok) failures += 1;
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}  ≥${min}  ${label}  ${f} on ${b}`);
    }
  }
}

const report = [`对比度实测（WCAG 2.1 相对亮度）`, `失败项：${failures}`, ...lines].join('\n');
writeFileSync(path.join(ROOT, '.tsbuild/contrast-report.txt'), report + '\n');
console.log(report);
process.exit(failures === 0 ? 0 : 1);
