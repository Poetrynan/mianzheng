import type { CandidateResultCell } from './api/types';
import { SCORE_LABEL } from './ui';

const LEVEL_RADIUS: Record<string, number> = { high: 1, medium: 0.66, low: 0.34 };

function shortLabel(name: string): string {
  const chars = [...name];
  return chars.length <= 7 ? name : `${chars.slice(0, 6).join('')}…`;
}

/** 轴标签是画在 SVG 里的，超出 viewBox 就会被裁掉，所以先按最长标签留出边带。 */
function labelExtent(name: string): number {
  return Math.min([...shortLabel(name)].length, 7) * 11 + 6;
}

/**
 * 一条轴一个考察维度，形状只连「面试官终评过、并且挂了原话」的那几维。
 * 有判断但没原话的维度画成空心圈留在原位，但不进形状；没终评的维度连圈都不画。
 * 一份全是「达标」却没有一句原话的面评，因此显示成一个塌到中心的形状，而不是一个饱满的六边形。
 */
export function DimensionRadar({
  cells,
  size = 300,
  caption = '',
}: {
  cells: CandidateResultCell[];
  size?: number;
  caption?: string;
}) {
  const axes = cells.length;
  if (axes < 3) {
    return <p className="text-[12px] text-mist-dim">这个岗位的标准维度少于三条，画不成矩阵，请在下方按条目查看。</p>;
  }

  const rad = size / 2 - 46;
  const band = 16 + Math.max(40, ...cells.map((c) => labelExtent(c.dimensionName)));
  const box = 2 * (rad + band);
  const center = box / 2;
  const angleAt = (i: number) => (Math.PI * 2 * i) / axes - Math.PI / 2;
  const at = (i: number, radius: number) => {
    const a = angleAt(i);
    return { x: center + Math.cos(a) * radius, y: center + Math.sin(a) * radius };
  };
  const ringPoints = (fraction: number) =>
    Array.from({ length: axes }, (_, i) => {
      const p = at(i, rad * fraction);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ');

  const stateOf = (cell: CandidateResultCell) => {
    const levelRadius = cell.level ? (LEVEL_RADIUS[cell.level] ?? 0) : 0;
    return { levelRadius, backed: cell.level !== null && cell.evidenceCount > 0 };
  };
  const shapePoints = cells
    .map((cell, i) => {
      const s = stateOf(cell);
      const p = at(i, s.backed ? Math.max(rad * s.levelRadius, rad * 0.12) : 0);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');

  const described = cells
    .map((c) => {
      const s = stateOf(c);
      return `${c.dimensionName}：${c.level === null ? '没有终评' : s.backed ? SCORE_LABEL[c.level] : `${SCORE_LABEL[c.level]}，但没有原话支撑`}`;
    })
    .join('；');
  const anyBacked = cells.some((c) => stateOf(c).backed);

  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <svg
        viewBox={`0 0 ${box} ${box}`}
        width={box}
        height={box}
        role="img"
        aria-label={caption ? `${caption}的考察维度矩阵。${described}` : described}
        style={{ maxWidth: '100%', height: 'auto' }}
      >
        {[1, 2 / 3, 1 / 3].map((fraction) => (
          <polygon
            key={fraction}
            points={ringPoints(fraction)}
            fill="none"
            stroke="var(--color-line-soft)"
            strokeWidth={fraction === 1 ? 1.2 : 1}
          />
        ))}
        {cells.map((cell, i) => {
          const outer = at(i, rad);
          return (
            <line
              key={`axis-${cell.dimensionId}`}
              x1={center}
              y1={center}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--color-line-soft)"
              strokeWidth={1}
            />
          );
        })}
        {anyBacked ? (
          <polygon points={shapePoints} fill="var(--color-human)" fillOpacity={0.16} stroke="var(--color-human)" strokeWidth={1.8} strokeLinejoin="round" />
        ) : null}
        {cells.map((cell, i) => {
          const s = stateOf(cell);
          if (cell.level === null) return null;
          const p = at(i, Math.max(rad * s.levelRadius, rad * 0.12));
          return s.backed ? (
            <circle key={`dot-${cell.dimensionId}`} cx={p.x} cy={p.y} r={3.6} fill="var(--color-human)" />
          ) : (
            <circle
              key={`dot-${cell.dimensionId}`}
              cx={p.x}
              cy={p.y}
              r={4.4}
              fill="none"
              stroke="var(--color-mist-dim)"
              strokeWidth={1.4}
              strokeDasharray="2 2"
            />
          );
        })}
        {cells.map((cell, i) => {
          const a = angleAt(i);
          const p = at(i, rad + 16);
          const cos = Math.cos(a);
          const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
          const dim = !stateOf(cell).backed;
          return (
            <text
              key={`label-${cell.dimensionId}`}
              x={p.x}
              y={p.y + (Math.abs(cos) < 0.25 ? (Math.sin(a) < 0 ? -2 : 8) : 4)}
              textAnchor={anchor}
              fontSize={11}
              fill={dim ? 'var(--color-mist-dim)' : 'var(--color-mist)'}
            >
              <title>{cell.dimensionName}</title>
              {shortLabel(cell.dimensionName)}
            </text>
          );
        })}
      </svg>
      <figcaption className="text-[11px] leading-relaxed text-mist-dim">
        形状只连你终评过、且挂了原话的维度；空心圈是有判断但还没原话，不进形状。
      </figcaption>
    </figure>
  );
}
