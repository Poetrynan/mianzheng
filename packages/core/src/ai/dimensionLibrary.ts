import type { DimensionDraft } from './llm.js';

interface LibraryEntry extends DimensionDraft {
  category: string;
}

const d = (
  category: string,
  name: string,
  positiveEvidence: string[],
  redFlags: string[],
  probes: string[],
  matchKeywords: string[],
): LibraryEntry => ({ category, name, positiveEvidence, redFlags, probes, matchKeywords });

/**
 * Starter fallback library (PRD 3.1 异常兜底: 用人经理没时间时由 HR 一键取模板).
 * Deliberately small and generic — the product's real asset is the per-job standard
 * extracted in , not this list.
 */
export const DIMENSION_LIBRARY: LibraryEntry[] = [
  d(
    '技术',
    '系统设计能力',
    ['能在不熟悉的技术栈下 30 分钟内给出可工作的方案', '能讲清取舍并量化代价'],
    ['只罗列组件名词，说不清为什么这么选'],
    ['请描述你主导过的一次架构决策，当时的第二方案是什么？为什么放弃？', '如果流量涨 10 倍，这套设计先崩在哪里？'],
    ['系统设计', '架构', '微服务', '高可用', '扩容', 'sharding', '缓存'],
  ),
  d(
    '技术',
    '代码与工程质量',
    ['有可复查的代码产出', '测试与回滚方案设计完整'],
    ['把质量归给"测试同学"'],
    ['你最近一次线上问题是怎么发现的？如何保证不再发生？'],
    ['代码', '单测', '测试覆盖', 'ci', '发布', '回滚', '重构'],
  ),
  d(
    '技术',
    '技术深度',
    ['能下钻到原理层解释现象'],
    ['停留在框架 API 使用层面'],
    ['挑一个你用过的中间件，讲讲它内部为什么这么设计？'],
    ['源码', '原理', '性能', '优化', '剖析', 'profiling', '底层'],
  ),
  d(
    '业务',
    '业务理解与结果导向',
    ['能说清自己工作对业务指标的影响'],
    ['全程只讲动作不讲结果'],
    ['你做的事情最终改变了哪个数字？'],
    ['营收', '转化率', 'gmv', '成本', '指标', 'roi', '留存', '增长'],
  ),
  d(
    '业务',
    '数据驱动',
    ['用数据定义问题、验证方案'],
    ['用"感觉"描述决策依据'],
    ['这个结论是怎么被数据验证的？'],
    ['数据', 'ab 测试', '实验', '看板', '归因', '埋点'],
  ),
  d(
    '协作',
    '跨部门推动力',
    ['能在没有汇报线的前提下推动多个团队', '主动对齐目标与优先级'],
    ['遇到阻力直接升级给领导或放弃'],
    ['讲一次你需要说服平级团队的经历，对方最初的反对理由是什么？'],
    ['跨部门', '协作', '对齐', '推动', '合作方', '资源协调'],
  ),
  d(
    '协作',
    '冲突处理',
    ['能把分歧转化为明确决策'],
    ['回避冲突或事后抱怨'],
    ['你和同事意见最强的那次分歧，最后怎么收的？'],
    ['冲突', '分歧', '反对', '争吵', '不一致'],
  ),
  d(
    '沟通',
    '结构化表达',
    ['回答有结论、有依据、有边界'],
    ['绕三分钟听不出重点'],
    ['用一句话概括你上一份工作的核心价值。'],
    ['表达', '沟通', '汇报', '写作', '演讲'],
  ),
  d(
    '沟通',
    '客户与干系人沟通',
    ['能面对负面情绪把问题推进'],
    ['把客户投诉转述为"客户的错"'],
    ['讲一次你要向不满意的干系人交代坏消息的经历。'],
    ['客户', '需求方', '投诉', '交付', '干系人'],
  ),
  d(
    '韧性',
    '抗压稳定性',
    ['在模糊与高压下仍能交付'],
    ['把压力归因给同事或外部环境'],
    ['最近一次时间不够用的项目，你砍掉了什么？'],
    ['加班', '压力', '紧急', '突发', '故障', '救火'],
  ),
  d(
    '韧性',
    '复盘与学习',
    ['能说出自己做得不好的具体一点'],
    ['声称没有遗憾'],
    ['过去一年你最后悔的一个技术决定是什么？'],
    ['复盘', '反思', '教训', '改进', '遗憾'],
  ),
  d(
    '自驱',
    '主动性与主人翁',
    ['会主动补位、发现问题并认领'],
    ['只做被指派的事'],
    ['讲一件没人让你做、但你做了的事。'],
    ['主动', '自驱', '牵头', '负责', 'owner', '认领'],
  ),
  d(
    '自驱',
    '模糊需求下的落地',
    ['能把不清的需求拆成可执行项'],
    ['等待上游给完整定义'],
    ['需求不明确时你通常第一步做什么？举例。'],
    ['模糊', '不确定', '拆解', '需求', '定义'],
  ),
  d(
    '管理',
    '团队搭建与招聘',
    ['有可复用的面试/评估标准'],
    ['只讲"看感觉"'],
    ['你怎么判断一个候选人是否达到团队水位？'],
    ['招聘', '面试', '团队搭建', 'headcount', '用人'],
  ),
  d(
    '管理',
    '带人与辅导',
    ['能说清下属的成长路径'],
    ['把团队产出全归自己'],
    ['讲一次你辅导一个表现不佳成员的经历。'],
    ['带团队', '下属', 'mentor', '辅导', '一对一', '成长计划'],
  ),
  d(
    '管理',
    '目标管理',
    ['能拆解目标并跟踪偏差'],
    ['只讲任务清单不讲优先级'],
    ['你的季度目标是怎么定的？中途改过吗？'],
    ['okr', 'kpi', '目标', '优先级', '排期'],
  ),
  d(
    '专业',
    '领域知识',
    ['对本行业有超出岗位的系统认知'],
    ['只有本公司流程知识'],
    ['这个未来 3 年最确定的一件事是什么？'],
    ['行业', '领域', '市场', '竞品', '趋势'],
  ),
  d(
    '专业',
    '合规与风险意识',
    ['主动识别风险并留痕'],
    ['认为合规是法务的事'],
    ['你踩过或挡过的最大风险是什么？'],
    ['合规', '安全', '隐私', '风险', '审计', '权限'],
  ),
];

export function libraryByKeyword(text: string, limit: number): LibraryEntry[] {
  const t = text.toLowerCase();
  const scored = DIMENSION_LIBRARY.map((entry) => {
    let score = 0;
    for (const k of entry.matchKeywords) if (t.includes(k.toLowerCase())) score += 2;
    if (t.includes(entry.name)) score += 3;
    if (t.includes(entry.category)) score += 1;
    return { entry, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  return scored.map((s) => s.entry);
}

export function defaultDimensions(limit = 5): LibraryEntry[] {
  const picks = ['系统设计能力', '跨部门推动力', '结构化表达', '抗压稳定性', '业务理解与结果导向', '主动性与主人翁'];
  return DIMENSION_LIBRARY.filter((e) => picks.includes(e.name)).slice(0, limit);
}

export function toDraft(entry: LibraryEntry): DimensionDraft {
  return {
    name: entry.name,
    positiveEvidence: [...entry.positiveEvidence],
    redFlags: [...entry.redFlags],
    probes: [...entry.probes],
    matchKeywords: [...entry.matchKeywords],
  };
}
