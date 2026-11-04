import type {
  AssistantObservation,
  AssistantProposalDraft,
  AssistantStepDecision,
  AssistantStepRequest,
  NextStepChoice,
  NextStepRequest,
} from './llm.js';

/**
 * 样例模式下的「模型」：没有接真实模型时，用确定的规则走完同一条 计划 → 调工具 → 看结果 → 再决定 的循环。
 * 它只用工具真实返回的数据组织回答，查不到就说查不到；界面会标明这是样例推理，不冒充模型。
 */

const DEFAULT_REASON: Record<string, string> = {
  read_segments: '已经找到候选人的原话，先读完再决定要不要换词',
  draft_dimension: '读过的原话已经能支撑一个判断，先起一稿；起不出来再换角度',
  search_transcript: '还有没试过的检索词，先换个说法再找，不急着标缺口',
  compose_question: '访谈里还缺具体例子，再问一个问题比现在就整理更稳',
};

export function mockChooseNextStep(req: NextStepRequest): NextStepChoice {
  const first = req.options[0];
  if (!first) return { optionId: 'opt1', reason: '只有一个可选动作' };
  const others = req.options.slice(1).map((o) => `「${o.label}」`).join('、');
  const why = DEFAULT_REASON[first.tool] ?? `先「${first.label}」`;
  return { optionId: first.id, reason: others ? `${why}（没选：${others}）` : why };
}

type Intent = 'pending' | 'gaps' | 'prep' | 'search' | 'review' | 'help';

function intentOf(text: string): Intent {
  if (/没交|未提交|没提交|催|逾期|待提交|谁还|拖/.test(text)) return 'pending';
  if (/追问|下一轮|二面|三面|准备|问什么|怎么问|一页纸/.test(text)) return 'prep';
  if (/说过|提到|讲过|聊到|原话里|有没有说|有没有讲|「|“/.test(text)) return 'search';
  if (/缺口|没问清|证据不足|缺什么|哪几维|哪几个维度|哪些维度|没证据|没有证据|没原话|没有原话|还缺|没核实/.test(text)) return 'gaps';
  if (/面评|评分|打分|终评|结论|进度/.test(text)) return 'review';
  return 'help';
}

function searchTerm(text: string): string | null {
  const quoted = text.match(/[「“"『]([^」”"』]{2,12})[」”"』]/);
  if (quoted?.[1]) return quoted[1].trim();
  const after = text.match(/(?:说过|提到|讲过|聊到|有没有说|有没有讲)(?:过)?([^，。？?！!、\s]{2,12})/);
  return after?.[1]?.replace(/(吗|没有|没|呢)$/, '').trim() || null;
}

interface InterviewRow {
  interviewId: string;
  candidateId: string;
  candidate: string;
  job: string;
  round: number;
  status: string;
  statusLabel: string;
}

function obs(req: AssistantStepRequest, tool: string): AssistantObservation | undefined {
  return [...req.observations].reverse().find((o) => o.tool === tool);
}

function rows(req: AssistantStepRequest): InterviewRow[] {
  const result = obs(req, 'find_interviews')?.result as { interviews?: InterviewRow[] } | undefined;
  return result?.interviews ?? [];
}

function pickCandidate(req: AssistantStepRequest, list: InterviewRow[]): string | null {
  const text = `${req.message} ${req.history.filter((h) => h.role === 'user').slice(-1)[0]?.text ?? ''}`;
  const names = [...new Set(list.map((r) => r.candidate))].sort((a, b) => b.length - a.length);
  const named = names.find((n) => req.message.includes(n)) ?? names.find((n) => text.includes(n));
  if (named) return list.find((r) => r.candidate === named)?.candidateId ?? null;
  const focus = list.find((r) => r.interviewId === req.context.focusInterviewId);
  return focus?.candidateId ?? null;
}

const tool = (name: string, args: Record<string, unknown>, thought: string): AssistantStepDecision => ({
  type: 'tool',
  tool: name,
  args,
  thought,
});

const answer = (text: string, proposals: AssistantProposalDraft[] = []): AssistantStepDecision => ({
  type: 'answer',
  text,
  proposals,
});

const HELP = [
  '我可以帮你查这些（只读，不会改任何记录）：',
  '· 某位候选人哪几个维度还没有原话支撑，例如「张伟一面哪几维没证据？」',
  '· 下一轮该先追问什么，例如「帮我准备张伟二面的追问」',
  '· 候选人有没有说过某件事，例如「张伟提到过「预占」吗？」',
  '· 谁的面评还没交，例如「还有谁的面评没交？」',
].join('\n');

export function mockAssistantStep(req: AssistantStepRequest): AssistantStepDecision {
  const intent = intentOf(req.message);
  if (intent === 'help') return answer(HELP);

  if (intent === 'pending') {
    const seen = obs(req, 'pending_reviews');
    if (!seen) return tool('pending_reviews', {}, '这是在问交付进度，直接查待提交清单');
    const list = ((seen.result as { rows?: Array<{ candidate: string; round: number; interviewers: string[]; waitingHours: number }> })?.rows) ?? [];
    if (list.length === 0) return answer('现在没有等待提交的面评，已结束的面试都交了。', [{ kind: 'open_board' }]);
    const lines = list.map((r) => `· ${r.candidate}第 ${r.round} 轮 · ${r.interviewers.join('、')} · 已等 ${r.waitingHours} 小时`);
    return answer([`有 ${list.length} 份面评还没交：`, ...lines, '', '要提醒的话，在交付看板里由招聘负责人发一次提醒。'].join('\n'), [{ kind: 'open_board' }]);
  }

  // 其余意图都要先知道说的是哪位候选人、哪一场。
  if (!obs(req, 'find_interviews')) {
    return tool('find_interviews', {}, '先看看工作区里有哪些面试，确认你说的是哪位候选人、哪一场');
  }
  const list = rows(req);
  const candidateId = pickCandidate(req, list);
  if (!candidateId) {
    const names = [...new Set(list.map((r) => r.candidate))];
    return answer(names.length === 0 ? '工作区里还没有面试记录。' : `你说的是哪位候选人？工作区里有：${names.join('、')}。`);
  }
  const mine = list.filter((r) => r.candidateId === candidateId).sort((a, b) => a.round - b.round);
  const name = mine[0]?.candidate ?? '这位候选人';
  const done = mine.filter((r) => r.status === 'eval_submitted' || r.status === 'eval_pending');
  const latestDone = done[done.length - 1];
  const upcoming = mine.find((r) => r.status === 'scheduled' || r.status === 'in_progress');

  if (intent === 'search') {
    const term = searchTerm(req.message);
    if (!term) return answer(`想在${name}的转写里找什么？把关键词放进「」里，比如「${name}提到过「预占」吗？」`);
    if (!latestDone) return answer(`${name}还没有结束的面试，没有转写可以查。`);
    const seen = obs(req, 'search_transcript');
    if (!seen) return tool('search_transcript', { interviewId: latestDone.interviewId, query: term }, `在${name}第 ${latestDone.round} 轮的转写里找候选人原话`);
    const hits = ((seen.result as { hits?: Array<{ at: string; text: string }> })?.hits) ?? [];
    if (hits.length === 0) {
      return answer(
        `在${name}第 ${latestDone.round} 轮的转写里，没有找到候选人说过「${term}」。我不会替他补一句；如果这件事重要，可以放进下一轮追问。`,
        upcoming ? [{ kind: 'open_prep', interviewId: upcoming.interviewId }] : [],
      );
    }
    const lines = hits.map((h) => `· ${h.at}「${h.text}」`);
    return answer([`找到了，${name}第 ${latestDone.round} 轮里有 ${hits.length} 段原话提到「${term}」：`, ...lines].join('\n'), [{ kind: 'open_draft', interviewId: latestDone.interviewId }]);
  }

  if (intent === 'review') {
    if (!latestDone) return answer(`${name}还没有结束的面试，没有面评可看。`);
    const seen = obs(req, 'review_status');
    if (!seen) return tool('review_status', { interviewId: latestDone.interviewId }, `看${name}第 ${latestDone.round} 轮的面评进度`);
    const drafts = ((seen.result as { drafts?: Array<{ interviewer: string; status: string; dims: Array<{ name: string; final: string | null; quotes: number }> }> })?.drafts) ?? [];
    if (drafts.length === 0) return answer(`${name}第 ${latestDone.round} 轮还没有面评草稿。`, [{ kind: 'open_draft', interviewId: latestDone.interviewId }]);
    const lines = drafts.map((d) => {
      const scored = d.dims.filter((x) => x.final).length;
      const bare = d.dims.filter((x) => !x.final).map((x) => x.name);
      return `· ${d.interviewer}：${d.status === 'submitted' ? '已提交' : '还在改'}，${scored}/${d.dims.length} 维已终评${bare.length ? `，没终评：${bare.join('、')}` : ''}`;
    });
    return answer([`${name}第 ${latestDone.round} 轮的面评：`, ...lines].join('\n'), [{ kind: 'open_draft', interviewId: latestDone.interviewId }]);
  }

  // gaps / prep 都从证据账本开始
  const ledger = obs(req, 'evidence_gaps');
  if (!ledger) return tool('evidence_gaps', { candidateId }, `翻${name}的证据账本，看哪些维度还没有原话支撑`);
  const entries = ((ledger.result as { entries?: Array<{ dimension: string; status: string; statusLabel: string; fromRound: number; carryOver: boolean }> })?.entries) ?? [];
  const open = entries.filter((e) => e.status !== 'covered');

  if (intent === 'gaps') {
    if (entries.length === 0) return answer(`${name}还没有提交过的面评，账本是空的，暂时谈不上缺口。`);
    if (open.length === 0) return answer(`${name}已提交的面评里，${entries.length} 个维度都有原话、也都终评了。`);
    const lines = open.map((e) => `· ${e.dimension}：第 ${e.fromRound} 轮${e.statusLabel}${e.carryOver ? '，会带到下一轮' : '，只留在那一轮'}`);
    return answer(
      [`${name}有 ${open.length} 个维度还没核实：`, ...lines, '', '证据不足只表示还没问到，不代表能力不达标。'].join('\n'),
      upcoming ? [{ kind: 'open_prep', interviewId: upcoming.interviewId }] : [{ kind: 'open_results' }],
    );
  }

  // prep
  if (!upcoming) {
    return answer(`${name}目前没有排好的下一轮。缺口有：${open.map((e) => e.dimension).join('、') || '无'}，排期后可以生成一页纸。`, [{ kind: 'open_results' }]);
  }
  const pack = obs(req, 'prep_questions');
  if (!pack) return tool('prep_questions', { interviewId: upcoming.interviewId }, `看看${name}第 ${upcoming.round} 轮的一页纸里已经准备了哪些追问`);
  const packData = pack.result as { exists?: boolean; questions?: Array<{ text: string; dimension: string }> };
  const carried = open.filter((e) => e.carryOver);
  const head =
    carried.length > 0
      ? `${name}第 ${upcoming.round} 轮建议先补上一轮没问清的 ${carried.length} 个维度：${carried.map((e) => e.dimension).join('、')}。`
      : `${name}上一轮没有带过来的缺口，第 ${upcoming.round} 轮按考察标准正常推进。`;
  if (!packData?.exists) {
    return answer(`${head}\n这一场还没有一页纸，要我按这些缺口生成一份吗？生成前你可以先看一眼。`, [{ kind: 'run_prep', interviewId: upcoming.interviewId }]);
  }
  const targeted = (packData.questions ?? []).filter((q) => carried.some((c) => c.dimension === q.dimension));
  const pickList = (targeted.length > 0 ? targeted : packData.questions ?? []).slice(0, 3);
  const lines = pickList.map((q, i) => `${i + 1}. ${q.text}（${q.dimension}）`);
  return answer([head, '一页纸里已经有对应的追问：', ...lines].join('\n'), [{ kind: 'open_prep', interviewId: upcoming.interviewId }]);
}
