import { z } from 'zod';
import type {
  EvaluationPlan,
  EvaluationPlanRequest,
  EvaluationRequest,
  EvaluationResult,
  LlmInfo,
  LlmProvider,
  PrepPackRequest,
  PrepPackResult,
  StandardExtractionRequest,
  StandardExtractionResult,
} from './llm.js';
import { REFERENCE_ONLY_DISCLAIMER } from '../compliance/notices.js';

const stringList = z.preprocess((value) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          for (const key of ['text', 'content', 'value', 'item', 'label']) {
            if (typeof o[key] === 'string') return [o[key] as string];
          }
        }
        return [];
      })
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((s) => s.replace(/^[-*·•\d.、)）\s]+/, '').trim())
      .filter(Boolean);
  }
  return value;
}, z.array(z.string().min(1)).default([]));

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

const DimensionDraftSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      name: pick(o, ['name', 'dimension', 'dimensionName', 'title', 'label']),
      positiveEvidence: pick(o, [
        'positiveEvidence',
        'positive_evidence',
        'positive',
        'positives',
        'positiveSignals',
        'positive_signal',
        'evidence',
        'lookFor',
        'whatGoodLooksLike',
      ]),
      redFlags: pick(o, ['redFlags', 'red_flags', 'redFlag', 'red_flag', 'risks', 'warningSigns', 'negativeSignals']),
      probes: pick(o, ['probes', 'probe', 'probeQuestions', 'probe_questions', 'questions', 'suggestedQuestions', 'followUps']),
      matchKeywords: pick(o, ['matchKeywords', 'match_keywords', 'keywords', 'keyword', 'tags', 'signals']),
    };
  },
  z
    .object({
      name: z.string().trim().min(1),
      positiveEvidence: stringList,
      redFlags: stringList,
      probes: stringList,
      matchKeywords: stringList,
    })
    .refine((d) => d.positiveEvidence.length > 0 || d.redFlags.length > 0, {
      message: '每个维度至少需要正向证据或红旗',
    }),
);

const StandardSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    const next = pick(o, ['nextQuestion', 'next_question', 'followUpQuestion', 'question']);
    return {
      nextQuestion: typeof next === 'string' && next.trim() && next.trim().toLowerCase() !== 'null' ? next.trim() : null,
      dimensions: pick(o, ['dimensions', 'competencies', 'dimensionDrafts', 'standards']) ?? [],
      rationale: pick(o, ['rationale', 'reasoning', 'reason', 'explanation']) ?? '',
      coverageNotes: pick(o, ['coverageNotes', 'coverage_notes', 'coverage', 'notes']),
    };
  },
  z.object({
    nextQuestion: z.string().nullable().default(null),
    dimensions: z.array(DimensionDraftSchema).default([]),
    rationale: z.string().default(''),
    coverageNotes: stringList,
  }),
);

const markSchema = z.preprocess((value) => {
  const s = String(value ?? '').toLowerCase();
  if (/matched|匹配|充分|已验证/.test(s)) return 'matched';
  if (/weak|不足|较弱|无证据|none/.test(s)) return 'weak';
  if (/probe|追问|验证|单薄/.test(s)) return 'needs_probe';
  return value;
}, z.enum(['matched', 'needs_probe', 'weak']));

const AlignmentSchema = z
  .object({
    dimensionId: z.string(),
    mark: markSchema.optional(),
    status: markSchema.optional(),
    rationale: z.string().default(''),
  })
  .transform((o) => ({
    dimensionId: o.dimensionId,
    mark: o.mark ?? o.status ?? 'needs_probe',
    rationale: o.rationale,
  }));

const PrepAlignmentSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      dimensionId: pick(o, ['dimensionId', 'dimension_id', 'id', 'dimension']),
      mark: pick(o, ['mark', 'status', 'level', 'match', 'coverage']),
      rationale: pick(o, ['rationale', 'reason', 'explanation', 'comment']) ?? '',
    };
  },
  AlignmentSchema,
);

const QuestionSchema = z
  .object({
    text: z.string().optional(),
    question: z.string().optional(),
    dimensionId: z.string().nullable().default(null),
    why: z.string().default(''),
  })
  .transform((o) => ({
    text: (o.text ?? o.question ?? '').trim(),
    dimensionId: o.dimensionId,
    why: o.why,
  }))
  .refine((o) => o.text.length > 0, { message: 'question text is required' });

const PrepQuestionSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      text: pick(o, ['text', 'question', 'content', 'ask']),
      dimensionId: pick(o, ['dimensionId', 'dimension_id', 'dimension', 'id']) ?? null,
      why: pick(o, ['why', 'reason', 'purpose', 'rationale']) ?? '',
    };
  },
  QuestionSchema,
);

const PrepSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      crux: pick(o, ['crux', 'keyPoints', 'key_points', 'focus', 'coreIssues']),
      alignment: pick(o, ['alignment', 'dimensions', 'coverage', 'dimensionAlignment']) ?? [],
      questions: pick(o, ['questions', 'probes', 'followUpQuestions', 'suggestedQuestions']) ?? [],
      redFlagChecks: pick(o, ['redFlagChecks', 'red_flag_checks', 'redFlags', 'riskChecks', 'checks']),
    };
  },
  z.object({
    crux: stringList,
    alignment: z.array(PrepAlignmentSchema).default([]),
    questions: z.array(PrepQuestionSchema).default([]),
    redFlagChecks: stringList,
  }),
);

const segmentIdList = z.preprocess((value) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        for (const key of ['segmentId', 'segment_id', 'id']) {
          if (typeof o[key] === 'string') return [o[key] as string];
        }
      }
      return [];
    });
  }
  if (typeof value === 'string') return [value];
  return value;
}, z.array(z.string()));

const boolish = z.preprocess((value) => {
  if (typeof value === 'string') return /^(true|yes|1|是|需要|需复核)$/i.test(value.trim());
  if (typeof value === 'number') return value !== 0;
  return value;
}, z.boolean().default(false));

const EvalDimensionSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    const score = pick(o, ['score', 'rating', 'level', 'mark', 'grade']);
    const normalizedScore =
      typeof score === 'string'
        ? /high|strong|高|优秀|强/i.test(score)
          ? 'high'
          : /low|weak|低|不足|弱/i.test(score)
            ? 'low'
            : /mid|medium|partial|中|一般|部分/i.test(score)
              ? 'medium'
              : score
        : score;
    return {
      dimensionId: pick(o, ['dimensionId', 'dimension_id', 'id', 'dimension']),
      score: normalizedScore ?? null,
      summary: pick(o, ['summary', 'comment', 'rationale', 'analysis', 'assessment', 'text']) ?? '',
      segmentIds: pick(o, ['segmentIds', 'segment_ids', 'evidenceSegmentIds', 'evidence_segment_ids', 'evidence', 'citations', 'sources']),
      redFlagHits: pick(o, ['redFlagHits', 'red_flag_hits', 'redFlags', 'risks']),
      needsHumanInput: pick(o, ['needsHumanInput', 'needs_human_input', 'needsReview', 'uncertain']) ?? false,
    };
  },
  z.object({
    dimensionId: z.string(),
    score: z.enum(['high', 'medium', 'low']).nullable().default(null),
    summary: z.string(),
    segmentIds: segmentIdList,
    redFlagHits: stringList,
    needsHumanInput: boolish,
  }),
);

const EvalHighlightSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      text: pick(o, ['text', 'quote', 'content', 'summary', 'point']) ?? '',
      segmentIds: pick(o, ['segmentIds', 'segment_ids', 'evidenceSegmentIds', 'evidence', 'citations']),
    };
  },
  z.object({ text: z.string(), segmentIds: segmentIdList }),
);

const EvalSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      dimensions: pick(o, ['dimensions', 'checks', 'dimensionChecks', 'assessments']) ?? [],
      highlights: pick(o, ['highlights', 'keyPoints', 'positives', 'strengths']),
      redFlags: pick(o, ['redFlags', 'red_flags', 'concerns', 'risks']),
    };
  },
  z.object({
    dimensions: z.array(EvalDimensionSchema).default([]),
    highlights: z.array(EvalHighlightSchema).default([]),
    redFlags: z.array(EvalHighlightSchema).default([]),
  }),
);

const PlanSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    return {
      order: pick(o, ['order', 'dimensionOrder', 'dimension_order', 'sequence']) ?? [],
      queries: pick(o, ['queries', 'searchQueries', 'search_queries', 'queriesByDimension', 'queries_by_dimension']) ?? {},
      rationale: pick(o, ['rationale', 'reasoning', 'reason']) ?? '',
    };
  },
  z.object({
    order: stringList,
    queries: z.record(z.string(), stringList),
    rationale: z.string().default(''),
  }),
);

const COMMON_RULES = [
  '你是招聘面试助手，服务对象是面试官，不是候选人。',
  '禁止推断或输出性别、年龄、婚育、民族、宗教、籍贯、外貌、身高、残障、性取向等与职务无关的特征。',
  '不得给出录用或淘汰结论；所有判断仅供参考。' + REFERENCE_ONLY_DISCLAIMER,
  '全部使用简体中文；除 QPS、RCA 这类行业通用缩写外，不要在中文里夹英文单词。',
  '只输出 JSON，不要输出解释性文字。',
].join('\n');

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

function buildRequest(model: string, system: string, user: string, apiKey: string, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: COMMON_RULES + '\n' + system },
        { role: 'user', content: user },
      ],
    }),
  };
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/**
 * Works against any OpenAI-compatible /chat/completions endpoint (LongCat, DeepSeek,
 * DashScope, vLLM, OpenAI). Credentials come from the environment only; nothing is persisted.
 */
export class OpenAiCompatLlmProvider implements LlmProvider {
  readonly driver = 'openai-compatible';
  constructor(
    readonly model: string,
    private readonly opts: OpenAiCompatOptions,
  ) {}

  private async complete<T extends object>(schema: z.ZodTypeAny, system: string, user: string): Promise<T> {
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const doFetch = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 90_000;
    let lastError: LlmProviderError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const init = buildRequest(
          this.opts.model,
          attempt === 0 ? system : `${system}\n上一次输出无法解析。请检查 JSON 结构，只输出一个合法 JSON 对象。`,
          user,
          this.opts.apiKey,
          timeoutMs,
        );
        const res = await doFetch(url, init);
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          if ((res.status === 429 || res.status >= 500) && attempt === 0) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          throw new LlmProviderError(`AI 服务调用失败 (${res.status})`, detail.slice(0, 1200));
        }
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = body.choices?.[0]?.message?.content;
        if (!raw) throw new LlmProviderError('AI 服务返回内容为空', JSON.stringify(body).slice(0, 1200));
        let parsed: unknown;
        try {
          parsed = JSON.parse(extractJson(raw));
        } catch (e) {
          throw new LlmProviderError('AI 返回不是合法 JSON', String((e as Error).message));
        }
        const shaped =
          parsed && typeof parsed === 'object' && 'result' in (parsed as Record<string, unknown>)
            ? (parsed as { result: unknown }).result
            : parsed;
        const checked = schema.safeParse(shaped);
        if (!checked.success) {
          throw new LlmProviderError(
            'AI 返回结构不符合约定',
            JSON.stringify({ issues: checked.error.issues.slice(0, 5), raw: raw.slice(0, 1600) }),
          );
        }
        return checked.data as T;
      } catch (err) {
        const wrapped =
          err instanceof LlmProviderError
            ? err
            : new LlmProviderError('AI 服务暂时不可用', err instanceof Error ? err.message : String(err));
        lastError = wrapped;
        if (attempt === 0 && (wrapped.message.includes('JSON') || wrapped.message.includes('结构'))) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw wrapped;
      }
    }
    throw lastError ?? new LlmProviderError('AI 服务暂时不可用');
  }

  async extractStandard(req: StandardExtractionRequest): Promise<StandardExtractionResult> {
    const data = await this.complete<Omit<StandardExtractionResult, keyof LlmInfo>>(
      StandardSchema,
      [
        '任务：从用人经理的访谈回答中提取该岗位的结构化考察标准。',
        '产出 4-7 个胜任维度。每个维度必须包含：正向证据（"你应该看到 ___"）、红旗（"应该警惕 ___"）、追问示例、匹配关键词。',
        '如果 requestDraft=false，只返回 nextQuestion（按访谈脚本继续追问，缺什么问什么），dimensions 返回空数组。',
        '如果 requestDraft=true，dimensions 给出草稿，nextQuestion 返回 null。',
        '严格使用这些字段名：dimensions[].name / positiveEvidence / redFlags / probes / matchKeywords，后四项必须是字符串数组。',
        '输出格式：{"nextQuestion":...,"dimensions":[{"name":"...","positiveEvidence":["..."],"redFlags":["..."],"probes":["..."],"matchKeywords":["..."]}],"rationale":"...","coverageNotes":["..."]}',
      ].join('\n'),
      JSON.stringify(req),
    );
    return { driver: this.driver, model: this.model, ...data };
  }

  async buildPrepPack(req: PrepPackRequest): Promise<PrepPackResult> {
    const data = await this.complete<Omit<PrepPackResult, keyof LlmInfo>>(
      PrepSchema,
      [
        '任务：生成面试官赛前 5 分钟能读完的一页纸准备包。',
        'alignment 必须覆盖入参里的每一个 dimensionId，判定规则：简历证据充分=matched；证据单薄=needs_probe；无证据=weak。',
        '证据不足时写 needs_probe 并在 rationale 中注明"该维度需要面试中重点考察"，不要猜测。',
        'questions 输出 3-5 条针对性追问，每条 dimensionId 必须指向入参维度，why 说明验证哪个维度。',
        'redFlagChecks 输出 2-3 条需要交叉确认的不一致点（时间段重叠、空窗、职级与经历不匹配等）。',
        '严格使用这些字段名：crux / alignment[].dimensionId+mark+rationale / questions[].text+dimensionId+why / redFlagChecks。',
        '输出格式：{"crux":["..."],"alignment":[{"dimensionId":"...","mark":"matched|needs_probe|weak","rationale":"..."}],"questions":[{"text":"...","dimensionId":"...","why":"..."}],"redFlagChecks":["..."]}',
      ].join('\n'),
      JSON.stringify(req),
    );
    return { driver: this.driver, model: this.model, ...data };
  }

  async planEvaluation(req: EvaluationPlanRequest): Promise<EvaluationPlan> {
    return this.complete<EvaluationPlan>(
      PlanSchema,
      [
        '任务：为一场面试面评安排调查计划。',
        '输入是考察维度（id、名称、正向证据、红旗、候选关键词）、轮次，以及上一轮带过来的缺口原因。',
        '为每个维度选 1-2 组最可能出现在候选人原话里的检索词：优先具体动作、对象、场景名词，不要用「能力」「沟通」「很好」这类泛词，每组 2-12 个字。',
        'order 用维度 id 给出调查顺序；上一轮带过来的缺口由系统固定排最前，你只排其余维度。',
        'queries 的键必须是输入里的维度 id；没有把握就少给，系统会用标准里的关键词兜底。',
        '输出格式：{"order":["dim_id"],"queries":{"dim_id":["词1","词2"]},"rationale":"一句话说明为什么这样排"}',
      ].join('\n'),
      JSON.stringify(req),
    );
  }

  async draftEvaluation(req: EvaluationRequest): Promise<EvaluationResult> {
    const data = await this.complete<Omit<EvaluationResult, keyof LlmInfo>>(
      EvalSchema,
      [
        '任务：按考察标准维度起草结构化面评。',
        '硬性规则：summary 只能描述入参 segments 中真实存在的内容，并且必须通过 segmentIds 指向这些片段的 id。',
        '绝对不要自己重写或补全候选人原话，引用文本由系统按 id 从转写库回填。',
        '某个维度没有任何片段支撑时：score=null、segmentIds=[]、needsHumanInput=true。',
        'score 是参考起评分（high/medium/low），最终评分由面试官给出，你不做录用或淘汰判断。',
        '不要输出总分、整体百分比或录用建议。',
        '输出格式：{"dimensions":[{"dimensionId","score","summary","segmentIds","redFlagHits","needsHumanInput"}],"highlights":[{"text","segmentIds"}],"redFlags":[{"text","segmentIds"}]}',
      ].join('\n'),
      JSON.stringify(req),
    );
    return { driver: this.driver, model: this.model, ...data };
  }
}
