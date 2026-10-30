import { ComplianceError } from '../errors.js';

export type ProtectedCategory =
  | 'gender'
  | 'age'
  | 'marital_or_fertility'
  | 'ethnicity_or_religion'
  | 'region_or_hukou'
  | 'appearance'
  | 'disability'
  | 'sexual_orientation';

interface Rule {
  category: ProtectedCategory;
  terms: string[];
}

/**
 * v1 scoring inputs must not carry these variables (PRD 6.3). Matching is deliberately
 * conservative: it flags a term and lets a human decide, rather than silently dropping text.
 */
const RULES: Rule[] = [
  { category: 'gender', terms: ['性别', '男性', '女性', '男生', '女生', '男找', '女找', '男优先', '女优先', '限男性', '限女性', '只要男', '只要女', 'gender', 'male', 'female', 'sexist'] },
  {
    category: 'age',
    terms: ['年龄', '岁以内', '岁以下', '岁以', '出生年', '90后', '95后', '00后', 'age limit', 'too old', '年轻一点', '年纪'],
  },
  {
    category: 'marital_or_fertility',
    terms: ['已婚', '未婚', '离婚', '婚恋', '恋爱', '结婚计划', '生育', '生孩子', '要孩子', '孩子', '二胎', '三胎', '备孕', '怀孕', '孕期', '产假', '计划生育', '婚育', 'marital status', 'pregnant', 'family planning'],
  },
  {
    category: 'ethnicity_or_religion',
    terms: ['民族', '汉族', '维吾尔', '藏族', '回族', '族人', '种族', '少数民族', '宗教', '信仰', '清真', '基督徒', '佛教徒', 'ethnicity', 'religion', 'religious'],
  },
  { category: 'region_or_hukou', terms: ['籍贯', '户籍', '本地人', '外地人', '省份优先', '只招', '北方人', '南方人', 'hukou', 'native place'] },
  { category: 'appearance', terms: ['外貌', '长相', '颜值', '形象气质佳', '身高', '体型', '体重', 'attractive', 'facial', 'height requirement'] },
  { category: 'disability', terms: ['残疾', '残障', '色盲', '听力障碍', 'disability', 'handicap'] },
  { category: 'sexual_orientation', terms: ['性取向', '同性恋', 'lesbian', 'gay', 'sexual orientation'] },
];

export interface ProtectedHit {
  category: ProtectedCategory;
  term: string;
  field: string;
  excerpt: string;
}

function excerptAround(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12));
}

interface CandidateHit extends ProtectedHit {
  start: number;
  end: number;
}

/**
 * Overlapping terms ("岁以下" vs "岁以") must count once: the longest match wins, and a match
 * that starts inside an already-counted span is dropped.
 */
function scanText(field: string, text: string): ProtectedHit[] {
  const lower = text.toLowerCase();
  const candidates: CandidateHit[] = [];
  for (const rule of RULES) {
    for (const term of rule.terms) {
      const needle = term.toLowerCase();
      let from = 0;
      while (needle.length > 0) {
        const start = lower.indexOf(needle, from);
        if (start < 0) break;
        const end = start + needle.length;
        candidates.push({
          category: rule.category,
          term,
          field,
          excerpt: excerptAround(text, start, end),
          start,
          end,
        });
        from = end;
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const hits: ProtectedHit[] = [];
  let coveredUntil = -1;
  for (const c of candidates) {
    if (c.start < coveredUntil) continue;
    hits.push({ category: c.category, term: c.term, field: c.field, excerpt: c.excerpt });
    coveredUntil = c.end;
  }
  return hits;
}

export function scanForProtectedAttributes(input: Record<string, unknown>): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  const visit = (field: string, value: unknown): void => {
    if (typeof value === 'string') {
      hits.push(...scanText(field, value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(`${field}[${i}]`, item));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(`${field}.${k}`, v);
    }
  };
  for (const [k, v] of Object.entries(input)) visit(k, v);
  return hits;
}

export interface GuardResult {
  ok: boolean;
  hits: ProtectedHit[];
  /** Present when an HR forced a draft through; every override is auditable. */
  overrideReason?: string;
}

/**
 * Default behaviour blocks the write. An override is allowed only with a reason and is
 * marked so the quarterly bias audit picks it up (PRD 6.3 "标准化歧视检测").
 */
export function assertNoProtectedAttributes(
  subject: string,
  input: Record<string, unknown>,
  overrideReason?: string,
): GuardResult {
  const hits = scanForProtectedAttributes(input);
  if (hits.length === 0) return { ok: true, hits };
  if (overrideReason && overrideReason.trim().length >= 4) {
    return { ok: true, hits, overrideReason: overrideReason.trim() };
  }
  throw new ComplianceError(
    'protected_attribute_detected',
    `${subject}含有与岗位无关的受保护特征，不能作为评估依据：${hits.map((h) => `${h.category}(${h.term})`).join('、')}。请改写，或由 HR 给出理由后强制通过。`,
    { subject, hits },
  );
}
