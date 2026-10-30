import type {
  DimensionDraft,
  EvaluationDimensionDraft,
  EvaluationPlan,
  EvaluationPlanRequest,
  EvaluationRequest,
  EvaluationResult,
  InterviewAnswer,
  LlmInfo,
  LlmProvider,
  PrepPackAlignment,
  PrepPackQuestionDraft,
  PrepPackRequest,
  PrepPackResult,
  StandardExtractionRequest,
  StandardExtractionResult,
} from './llm.js';
import { defaultDimensions, libraryByKeyword, toDraft } from './dimensionLibrary.js';
import type { AlignmentMark, ScoreLevel } from '../types.js';

/** interview script: the AI interviewer's question set, asked in order until covered. */
export const STANDARD_INTERVIEW_SCRIPT: string[] = [
  '这个岗位要解决的核心问题是什么？为什么现在需要这个人？',
  '上一任（或现在承担这件事的人）做得好的地方和明显短板分别是什么？',
  '如果候选人只做到 60 分，你会从哪些具体信号上看出来？',
  '请举一个真实例子：什么样的表现会让你认为"这个人明显胜任"？',
  '哪些经历或表现会让你直接警惕、甚至一票否决？',
  '这个岗位最需要跟哪些人打交道？最容易在哪个环节卡住？',
  '你在面试里会用什么问题来验证上面这些点？',
  '未来 6-12 个月团队或业务最大的变化是什么？这对候选人额外要求什么？',
];

/** Shared by 准备包与转写: 归因外部是 PRD 3.1 明确点名的红旗信号。 */
const EXTERNAL_ATTRIBUTION_LEXICON = ['同事没', '他们不', '领导不', '公司的锅', '环境问题', '没办法', '不是我', '客观原因', '没人配合'];
const OWNERSHIP_LEXICON = ['我负责', '我推动', '我主导', '我提出', '我把', '我从零', '从 0 到 1', '提升了', '降低了', '最后我们'];

const lower = (s: string): string => s.toLowerCase();

function keywordHits(text: string, keywords: string[]): string[] {
  const t = lower(text);
  return keywords.filter((k) => k.length > 0 && t.includes(lower(k)));
}

function sentences(text: string): string[] {
  return text
    .split(/[\n。；;]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

export interface TimelineFinding {
  overlaps: string[];
  shortStints: string[];
  gaps: string[];
}

const RANGE_RE = /(19|20)\d{2}\s*[./-]\s*(0?[1-9]|1[0-2])\s*[-~–至到]\s*((19|20)\d{2}\s*[./-]\s*(0?[1-9]|1[0-2])|至今|present|now)/gi;

function toMonths(y: number, m: number): number {
  return y * 12 + m;
}

function parseRange(raw: string): { from: number; to: number; label: string } | null {
  const label = raw.trim();
  const m = label.match(/(19|20)(\d{2})\s*[./-]\s*(\d{1,2})\s*[-~–至到]\s*(?:(19|20)(\d{2})\s*[./-]\s*(\d{1,2})|至今|present|now)/i);
  if (!m) return null;
  const [, y1, m1, mm1, y2, m2, mm2] = m;
  const from = toMonths(Number(y1) * 100 + Number(m1), Number(mm1));
  const to = y2 && m2 ? toMonths(Number(y2) * 100 + Number(m2), Number(mm2)) : toMonths(2026, 1);
  return { from, to, label };
}

/**
 * Cheap consistency checks that give its "红旗排查" items without pretending to be
 * a full resume parser: overlapping stints, sub-year stints, and gaps over 12 months.
 */
export function analyzeResumeTimeline(text: string): TimelineFinding {
  const found = text.match(RANGE_RE) ?? [];
  const ranges = found.map(parseRange).filter((r): r is NonNullable<typeof r> => r !== null);
  const overlaps: string[] = [];
  const shortStints: string[] = [];
  const gaps: string[] = [];

  for (let i = 0; i < ranges.length; i += 1) {
    const a = ranges[i];
    if (!a) continue;
    if (a.to - a.from < 12) shortStints.push(a.label);
    for (let j = i + 1; j < ranges.length; j += 1) {
      const b = ranges[j];
      if (!b) continue;
      if (a.from < b.to && b.from < a.to) overlaps.push(`${a.label} 与 ${b.label}`);
    }
  }
  const sorted = [...ranges].sort((x, y) => x.from - y.from);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const gap = cur.from - prev.to;
    if (gap >= 12) gaps.push(`${prev.label} 之后约 ${gap} 个月`);
  }
  return { overlaps, shortStints, gaps };
}

function buildDimensions(intake: StandardExtractionRequest['intake'], answers: InterviewAnswer[]): DimensionDraft[] {
  const corpus = [
    intake.jobTitle,
    intake.level,
    intake.painPoints,
    intake.description,
    intake.reportsTo,
    ...answers.map((a) => `${a.question} ${a.answer}`),
  ].join(' ');
  const fromCorpus = libraryByKeyword(corpus, 7).map(toDraft);
  const picked: DimensionDraft[] = [];
  for (const dim of fromCorpus) if (!picked.some((p) => p.name === dim.name)) picked.push(dim);
  for (const dim of defaultDimensions(7).map(toDraft)) {
    if (picked.length >= 4) break;
    if (!picked.some((p) => p.name === dim.name)) picked.push(dim);
  }
  return picked.slice(0, 7);
}

function nextQuestion(answers: InterviewAnswer[]): string | null {
  const asked = new Set(answers.map((a) => a.question));
  return STANDARD_INTERVIEW_SCRIPT.find((q) => !asked.has(q)) ?? null;
}

export interface MockLlmOptions {
  /** Optional keyword hints merged into every dimension's matcher. */
  extraKeywords?: Record<string, string[]>;
}

/**
 * Deterministic, offline provider. It is not a fake "everything is great" generator: every
 * claim it makes is derived from real input text, which is exactly what lets the evidence
 * verifier and the parity tests be meaningful without an API key.
 */
export class MockLlmProvider implements LlmProvider {
  readonly driver = 'mock';
  readonly model = 'mock-deterministic-v1';

  constructor(private readonly options: MockLlmOptions = {}) {}

  get info(): LlmInfo {
    return { driver: this.driver, model: this.model };
  }

  private keywordsFor(name: string, base: string[]): string[] {
    const extra = this.options.extraKeywords?.[name] ?? [];
    return [...base, ...extra];
  }

  async extractStandard(req: StandardExtractionRequest): Promise<StandardExtractionResult> {
    const dims = req.requestDraft ? buildDimensions(req.intake, req.answers) : [];
    const q = req.requestDraft ? null : nextQuestion(req.answers);
    const coverage = STANDARD_INTERVIEW_SCRIPT.filter((s) => !req.answers.some((a) => a.question === s)).map((s) => `未覆盖：${s}`);
    return {
      ...this.info,
      nextQuestion: req.requestDraft ? null : q,
      dimensions: dims,
      rationale: req.requestDraft
        ? `从 ${req.answers.length} 轮回答与职位描述中提取 ${dims.length} 个维度，按回答中出现过的具体经验与关键词归类。`
        : '继续收集用人经理的具体例子，达到足够覆盖后再生成金标准草稿。',
      coverageNotes: req.requestDraft ? coverage.slice(0, 3) : coverage,
    };
  }

  async buildPrepPack(req: PrepPackRequest): Promise<PrepPackResult> {
    const resume = req.resumeText || '';
    const lines = sentences(resume);
    const alignment: PrepPackAlignment[] = req.dimensions.map((dim) => {
      const kws = this.keywordsFor(dim.name, dim.matchKeywords);
      const hits = keywordHits(resume, kws);
      if (req.parseFailed || resume.trim().length < 40) {
        return {
          dimensionId: dim.id,
          mark: 'needs_probe',
          rationale: `简历解析不完整，无法判断「${dim.name}」，该维度需要赛中重点考察`,
        };
      }
      let mark: AlignmentMark;
      if (hits.length >= 2) mark = 'matched';
      else if (hits.length === 1) mark = 'needs_probe';
      else mark = 'weak';
      const rationale =
        mark === 'matched'
          ? `简历中出现 ${hits.join('、')}，方向与「${dim.name}」的正向证据一致`
          : mark === 'needs_probe'
            ? `仅出现 ${hits[0] ?? '无'}，不足以判断「${dim.name}」，该维度需要赛中重点考察`
            : `简历中未见「${dim.name}」相关证据，该维度需要赛中重点考察`;
      return { dimensionId: dim.id, mark, rationale };
    });

    const priority = alignment.filter((a) => a.mark !== 'matched');
    const questions: PrepPackQuestionDraft[] = [];
    for (const row of priority) {
      const dim = req.dimensions.find((x) => x.id === row.dimensionId);
      if (!dim) continue;
      const probe = dim.probes[0] ?? `请举一个具体例子说明你具备「${dim.name}」。`;
      questions.push({ text: probe, dimensionId: dim.id, why: `验证「${dim.name}」` });
      if (questions.length >= 5) break;
    }
    if (questions.length < 3) {
      for (const dim of req.dimensions) {
        if (questions.some((qq) => qq.dimensionId === dim.id)) continue;
        const probe = dim.probes[questions.length % Math.max(1, dim.probes.length)] ?? `讲讲「${dim.name}」相关的一段亲历。`;
        questions.push({ text: probe, dimensionId: dim.id, why: `验证「${dim.name}」` });
        if (questions.length >= 4) break;
      }
    }

    const timeline = analyzeResumeTimeline(resume);
    const redFlagChecks: string[] = [];
    if (timeline.overlaps.length > 0) redFlagChecks.push(`履历时间段重叠：${timeline.overlaps[0]}，需交叉确认`);
    if (timeline.gaps.length > 0) redFlagChecks.push(`存在 12 个月以上空窗：${timeline.gaps[0]}，需确认这段时间的经历`);
    if (timeline.shortStints.length >= 2) redFlagChecks.push(`${timeline.shortStints.length} 段任职不足 12 个月，需确认离职原因`);
    const dimProbes = req.dimensions.filter((x) => x.redFlags.length > 0).slice(0, 2);
    for (const dim of dimProbes) redFlagChecks.push(`留意「${dim.name}」红旗：${dim.redFlags[0] ?? ''}`);

    const crux = [
      ...lines.filter((l) => /(负责|主导|提升|降低|从 0|上线|带团队)/.test(l)).slice(0, 3),
      ...lines.filter((l) => /(年|经验)/.test(l)).slice(0, 1),
    ].slice(0, 4);

    return {
      ...this.info,
      crux: crux.length > 0 ? crux : ['简历信息不足，建议赛前由 HR 补齐关键经历'],
      alignment,
      questions,
      redFlagChecks: redFlagChecks.slice(0, 5),
    };
  }

  async planEvaluation(req: EvaluationPlanRequest): Promise<EvaluationPlan> {
    const queries: Record<string, string[]> = {};
    for (const dim of req.dimensions) {
      const picked: string[] = [];
      for (const raw of [...dim.matchKeywords, dim.name]) {
        const q = raw.trim();
        if (q.length < 2 || picked.includes(q)) continue;
        picked.push(q);
        if (picked.length >= 3) break;
      }
      queries[dim.id] = picked.length > 0 ? picked : [dim.name];
    }
    return {
      order: req.dimensions.map((d) => d.id),
      queries,
      rationale: '按维度名和标准里的匹配关键词安排调查顺序，先查上一轮留下的缺口。',
    };
  }

  async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
    const candidateSegments = req.segments;
    const dims: EvaluationDimensionDraft[] = req.dimensions.map((dim) => {
      const kws = this.keywordsFor(dim.name, dim.matchKeywords);
      const support = candidateSegments.filter((s) => keywordHits(s.text, kws).length > 0);
      const ownership = support.filter((s) => keywordHits(s.text, OWNERSHIP_LEXICON).length > 0);
      const blame = support.filter((s) => keywordHits(s.text, EXTERNAL_ATTRIBUTION_LEXICON).length > 0);
      const redFlagTexts = dim.redFlags.filter((r) =>
        support.some((s) => keywordHits(s.text, EXTERNAL_ATTRIBUTION_LEXICON).length > 0 && r.includes('归因')),
      );

      let score: ScoreLevel | null = null;
      if (support.length === 0) {
        score = null;
      } else if (blame.length > 0 && ownership.length === 0) {
        score = 'low';
      } else if (ownership.length >= 2 || (ownership.length === 1 && support.length >= 3)) {
        score = 'high';
      } else {
        score = 'medium';
      }

      const chosen = (score === 'low' ? blame : ownership.length > 0 ? ownership : support).slice(0, 2);
      const summary =
        score === null
          ? `本场面试未出现与「${dim.name}」相关的可引用内容，需要人工补充判断`
          : `有 ${support.length} 段原话与这个维度相关，其中 ${ownership.length} 段是候选人自己主动做的事${blame.length > 0 ? `，另有 ${blame.length} 段把原因归给了外部` : ''}`;

      return {
        dimensionId: dim.id,
        score,
        summary,
        segmentIds: chosen.map((c) => c.id),
        redFlagHits: redFlagTexts,
        needsHumanInput: score === null,
      };
    });

    const highlightSegs = candidateSegments.filter((s) => keywordHits(s.text, OWNERSHIP_LEXICON).length > 0).slice(0, 3);
    const blameSegs = candidateSegments.filter((s) => keywordHits(s.text, EXTERNAL_ATTRIBUTION_LEXICON).length > 0).slice(0, 3);

    return {
      ...this.info,
      dimensions: dims,
      highlights: highlightSegs.map((s) => ({ text: s.text.slice(0, 80), segmentIds: [s.id] })),
      redFlags: blameSegs.map((s) => ({ text: s.text.slice(0, 80), segmentIds: [s.id] })),
      overall: null,
    };
  }
}
