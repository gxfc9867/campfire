import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

/**
 * 生成预置头像模板（public/avatars/preset-01.svg … preset-24.svg）。
 *
 * 6 种几何图案 × 4 组配色，纯静态 SVG：
 * 不依赖任何绘图库，也不需要联网或 AI 生图——
 * 那样会让项目在「没配 key 的机器上」直接退化。
 */

const COLORS = [
  { bg: '#EA580C', ink: '#FFFFFF' }, // 炉火橙
  { bg: '#0D9488', ink: '#FFFFFF' }, // 青
  { bg: '#4F46E5', ink: '#FFFFFF' }, // 靛
  { bg: '#BE123C', ink: '#FFFFFF' }, // 胭脂
];

const PATTERNS = [
  // 1 圆环 + 圆心
  (c) =>
    `<circle cx="32" cy="32" r="19" fill="none" stroke="${c.ink}" stroke-width="5" opacity="0.85"/>` +
    `<circle cx="32" cy="32" r="7" fill="${c.ink}"/>`,

  // 2 对角弧
  (c) =>
    `<path d="M13 45 A23 23 0 0 1 51 22" fill="none" stroke="${c.ink}" stroke-width="6" stroke-linecap="round" opacity="0.9"/>` +
    `<circle cx="51" cy="22" r="5" fill="${c.ink}"/>`,

  // 3 错位方块
  (c) =>
    `<rect x="14" y="16" width="22" height="22" rx="7" fill="${c.ink}" opacity="0.9"/>` +
    `<rect x="28" y="28" width="22" height="22" rx="7" fill="${c.ink}" opacity="0.45"/>`,

  // 4 三道斜线
  (c) =>
    [0, 1, 2]
      .map(
        (i) =>
          `<line x1="${17 + i * 11}" y1="15" x2="${11 + i * 11}" y2="49" stroke="${c.ink}" stroke-width="4.5" stroke-linecap="round" opacity="${0.9 - i * 0.22}"/>`,
      )
      .join(''),

  // 5 骰子点
  (c) =>
    [
      [21, 21],
      [43, 21],
      [32, 32],
      [21, 43],
      [43, 43],
    ]
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 2 ? 5 : 3.6}" fill="${c.ink}" opacity="${i === 2 ? 1 : 0.7}"/>`)
      .join(''),

  // 6 双叶
  (c) =>
    `<path d="M32 48 C20 48 16 34 20 20 C34 20 44 30 40 44 Z" fill="${c.ink}" opacity="0.85"/>` +
    `<path d="M32 48 C44 48 48 34 44 24" fill="none" stroke="${c.ink}" stroke-width="4" stroke-linecap="round" opacity="0.45"/>`,
];

function svg(bg, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img">
<rect width="64" height="64" fill="${bg}"/>
${body}
</svg>
`;
}

const outDir = path.join(ROOT, 'public', 'avatars');
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (let p = 0; p < PATTERNS.length; p++) {
  for (let c = 0; c < COLORS.length; c++) {
    n++;
    const id = String(n).padStart(2, '0');
    const body = PATTERNS[p](COLORS[c]);
    fs.writeFileSync(path.join(outDir, `preset-${id}.svg`), svg(COLORS[c].bg, body));
  }
}

// 站点图标：一圈炉火
fs.writeFileSync(
  path.join(ROOT, 'public', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<rect width="64" height="64" rx="14" fill="#1C1917"/>
<path d="M32 14 C38 24 44 28 44 38 A12 12 0 0 1 20 38 C20 30 26 26 32 14 Z" fill="#EA580C"/>
<path d="M32 28 C35 33 37 35 37 39 A5 5 0 0 1 27 39 C27 35 29 33 32 28 Z" fill="#FDBA74"/>
</svg>
`,
);

console.log(`已生成 ${n} 个预置头像 + favicon.svg`);
