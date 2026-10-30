import { DomainError } from '../errors.js';
import type { InterviewAnswer, Job, JobIntake, JobStandard } from '../types.js';
import type { Actor, ServiceContext } from '../services/context.js';
import type { GoldenStandardService } from '../services/goldenStandard.js';
import {
  type AgentAction,
  type AgentAnswerOutcome,
  type AgentDriver,
  type AgentToolOutcome,
  dataNumber,
  dataString,
  failedCount,
  stepOf,
  stepsOf,
  succeeded,
} from './runtime.js';
import type { AgentQuestion, AgentRun } from './types.js';

interface Facet {
  key: string;
  label: string;
  lex: string[];
  question: (intake: JobIntake) => string;
}

function painTokens(intake: JobIntake): string[] {
  return intake.painPoints
    .split(/[、，,。；;/\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 5);
}

function painShort(intake: JobIntake): string {
  const p = intake.painPoints.trim();
  return p.length > 40 ? `${p.slice(0, 40)}…` : p;
}

const FACETS: Facet[] = [
  {
    key: 'mission',
    label: '要解决的核心问题',
    lex: ['核心问题', '为什么', '业务', '最需要'],
    question: (intake) =>
      painShort(intake)
        ? `这个岗位现在最需要解决的是「${painShort(intake)}」。如果这件事做不好，业务上会先出什么问题？`
        : '这个岗位现在最需要解决的核心问题是什么？为什么非补这个人不可？',
  },
  {
    key: 'outcome',
    label: '做到什么算好',
    lex: ['60 分', '90 分', '结果', '标准', '交付', '产出', '指标', '提升', '降低', '做到'],
    question: () => '在这个岗位上，「做到 60 分」和「做到 90 分」的人，交付结果上会差在哪？',
  },
  {
    key: 'example',
    label: '一个具体例子',
    lex: ['比如', '当时', '去年', '那次', '有一次', '例如', '例子'],
    question: () => '最近一次让你觉得「这就是我们要的人」的具体例子是什么？当时他做了什么？',
  },
  {
    key: 'redflag',
    label: '必须警惕的信号',
    lex: ['警惕', '不行', '一票否决', '减分', '不放心', '拒绝', '不能接受', '红线'],
    question: () => '哪些表现会让你直接警惕、甚至一票否决？哪怕简历看起来很漂亮。',
  },
  {
    key: 'tradeoff',
    label: '取舍与判断',
    lex: ['取舍', '权衡', '优先', '放弃', '第二方案', '判断', '选择'],
    question: () => '这个人做判断时，你希望他优先保什么、可以放弃什么？',
  },
  {
    key: 'team',
    label: '和谁协作',
    lex: ['团队', '跨部门', '协作', '上下游', '联动', '沟通', '配合'],
    question: () => '这个岗位每天要打交道的上下游是谁？最容易卡在哪？',
  },
];

export interface IntakeCoverage {
  covered: string[];
  missing: string[];
}

/** Which sides of the role the hiring manager has actually described, judged from their answers only. */
export function analyzeIntakeAnswers(intake: JobIntake, answers: InterviewAnswer[]): IntakeCoverage {
  const text = answers.map((a) => a.answer).join('\n').toLowerCase();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const facet of FACETS) {
    const lex = facet.key === 'mission' ? [...facet.lex, ...painTokens(intake)] : facet.lex;
    const hit = lex.some((term) => term.length > 0 && text.includes(term.toLowerCase()));
    (hit ? covered : missing).push(facet.key);
  }
  return { covered, missing };
}

export interface ComposedQuestion {
  question: string;
  facet: string;
  basis: string;
}

/**
 * The next question depends on what the answers already contain, not on a fixed index.
 * When every side is covered, the agent stops asking instead of exhausting a script.
 */
export function composeAdaptiveQuestion(intake: JobIntake, answers: InterviewAnswer[]): ComposedQuestion | null {
  const asked = new Set(answers.map((a) => a.question));
  const coverage = analyzeIntakeAnswers(intake, answers);
  for (const facet of FACETS) {
    if (coverage.covered.includes(facet.key)) continue;
    const question = facet.question(intake);
    if (asked.has(question)) continue;
    return { question, facet: facet.key, basis: `还没听到「${facet.label}」，这是判断标准里最缺的一块` };
  }
  const followUp = '能再讲一个最近的具体例子吗？当时的情况、候选人做的事、最后的结果分别是什么？';
  if (!asked.has(followUp) && answers.length < 6) {
    return { question: followUp, facet: 'example', basis: '现在多是抽象评价，还需要具体事实' };
  }
  return null;
}

/**
 * 定标 agent: reads the intake, reviews what has been said, asks only the missing side,
 * and stops once the standard can be drafted. Dimension confirmation and signatures stay human.
 */
export class StandardAgentDriver implements AgentDriver {
  readonly maxSteps = 32;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly goldenStandard: GoldenStandardService,
    private readonly actor: Actor,
  ) {}

  private locale(run: AgentRun): { std: JobStandard; job: Job } {
    const standardId = run.subject.standardId;
    if (!standardId) throw new DomainError('standard_required', '这次访谈还没关联岗位标准');
    const std = this.ctx.store.findStandard(standardId);
    if (!std) throw new DomainError('standard_not_found', '这次访谈对应的标准不存在');
    const job = this.ctx.store.findJob(std.jobId);
    if (!job) throw new DomainError('job_not_found', '这个岗位不存在');
    if (!std.intake) throw new DomainError('intake_required', '请先完成岗位填表');
    return { std, job };
  }

  next(run: AgentRun): AgentAction {
    const { std } = this.locale(run);
    const answers = std.answers.length;

    if (std.dimensions.length > 0) {
      return {
        type: 'final',
        summary: `草稿好了：${std.dimensions.length} 个考察维度。接下来请你逐项确认，HR 和用人经理都签过才会定稿。`,
        result: { standardId: std.id },
      };
    }

    if (!succeeded(run, 'read_intake')) {
      return { type: 'tool', tool: 'read_intake', label: '看清这个岗位要解决什么问题', kind: 'read' };
    }

    if (failedCount(run, 'build_standard_draft') >= 2) {
      return {
        type: 'stop',
        reason: '两次都没能整理出可用的维度，先停下',
      };
    }

    const coverage = analyzeIntakeAnswers(std.intake as JobIntake, std.answers);
    const lastBuild = stepOf(run, 'build_standard_draft');
    const answersAfterBuild = lastBuild
      ? run.steps.filter((s) => s.kind === 'answer' && s.index > lastBuild.index).length
      : answers;
    /** Do not spend the last steps on another question: hand over a draft instead of a dead end. */
    const used = run.steps.filter((s) => s.kind !== 'stop').length;
    const remaining = run.budget.maxSteps - used;
    if (remaining <= 2 && answers >= 2) {
      return { type: 'tool', tool: 'build_standard_draft', label: '把访谈整理成考察维度草稿', kind: 'draft' };
    }
    const ready = answers >= 6 || (answers >= 4 && coverage.covered.length >= 4);
    if (ready && (!lastBuild || lastBuild.ok || answersAfterBuild >= 1)) {
      return { type: 'tool', tool: 'build_standard_draft', label: '把访谈整理成考察维度草稿', kind: 'draft' };
    }

    const review = stepOf(run, 'review_answers');
    if (dataNumber(review, 'answers') !== answers) {
      return { type: 'tool', tool: 'review_answers', label: '把已经听到的内容对一遍', kind: 'verify' };
    }

    const composed = stepOf(run, 'compose_question');
    if (composed?.ok && dataNumber(composed, 'forAnswers') === answers) {
      const question = dataString(composed, 'question');
      if (question) {
        return {
          type: 'ask',
          question: {
            question,
            detail: dataString(composed, 'basis'),
            freeText: true,
          },
        };
      }
      if (answers >= 2) {
        return { type: 'tool', tool: 'build_standard_draft', label: '把访谈整理成考察维度草稿', kind: 'draft' };
      }
      return {
        type: 'stop',
        reason: '能问的面都问完了，但有效回答还不够',
      };
    }

    return { type: 'tool', tool: 'compose_question', label: '挑下一个最该问的问题', kind: 'plan' };
  }

  async act(run: AgentRun, tool: string): Promise<AgentToolOutcome> {
    const { std, job } = this.locale(run);
    const intake = std.intake as JobIntake;
    switch (tool) {
      case 'read_intake': {
        return {
          kind: 'read',
          label: '看清这个岗位要解决什么问题',
          detail: `${intake.jobTitle} · ${intake.painPoints || '还没填关键痛点'}`,
          data: { jobTitle: intake.jobTitle, painPoints: intake.painPoints, facets: FACETS.map((f) => f.label) },
        };
      }
      case 'review_answers': {
        const coverage = analyzeIntakeAnswers(intake, std.answers);
        const missingLabels = FACETS.filter((f) => coverage.missing.includes(f.key)).map((f) => f.label);
        return {
          kind: 'verify',
          label: '把已经听到的内容对一遍',
          detail:
            std.answers.length === 0
              ? '还没有回答'
              : missingLabels.length === 0
                ? `已经记下 ${std.answers.length} 轮，六个面都听到了`
                : `已经记下 ${std.answers.length} 轮，还差：${missingLabels.join('、')}`,
          data: { answers: std.answers.length, covered: coverage.covered, missing: coverage.missing },
        };
      }
      case 'compose_question': {
        const picked = composeAdaptiveQuestion(intake, std.answers);
        return {
          kind: 'plan',
          label: '挑下一个最该问的问题',
          detail: picked?.question ?? '能问的面都问到了，可以整理草稿',
          data: {
            question: picked?.question ?? null,
            facet: picked?.facet ?? null,
            basis: picked?.basis ?? null,
            forAnswers: std.answers.length,
          },
        };
      }
      case 'build_standard_draft': {
        const result = await this.goldenStandard.proposeDraft(this.actor, std.id);
        const names = result.standard.dimensions.map((d) => d.name);
        return {
          kind: 'draft',
          label: '把访谈整理成考察维度草稿',
          detail: `提取到 ${names.length} 个维度：${names.join('、')}`,
          data: { dimensionIds: result.standard.dimensions.map((d) => d.id), names, version: result.standard.version },
        };
      }
      default:
        throw new DomainError('unknown_tool', `不认识的工具：${tool}`);
    }
  }

  applyAnswer(run: AgentRun, question: AgentQuestion, answer: string): AgentAnswerOutcome {
    const { std } = this.locale(run);
    const { standard } = this.goldenStandard.recordAnswer(this.actor, std.id, question.question, answer);
    return {
      label: `你回答：${answer.length > 36 ? `${answer.slice(0, 36)}…` : answer}`,
      detail: `已记进岗位访谈记录，第 ${standard.answers.length} 轮`,
    };
  }
}
