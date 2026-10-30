/** Shown as a standalone notice before recording. Two equal buttons, never a footer link. */
export const CONSENT_NOTICE_TEXT = [
  '这次面试的对话会被转成文字（来自会议软件的转写，或面试官本机的录音），AI 用这些文字帮助面试官整理面评。',
  '我们不保存面试视频，只保留转成的文字和必要的录音；文字和录音最长保留 6 个月，到期自动删除。',
  '您有权拒绝。拒绝后，面试照常进行，面试官只做人工记录，不影响对您的评价。',
  '记录期间，您可以随时要求暂停、查看或删除本次记录。',
  'AI 只整理面试官问过的内容和原话，不替人打分，也不会单独决定录用结果。您有权申请免费人工复核。',
].join('\n');

export const APPEAL_CHANNEL = {
  label: '人工复核与申诉',
  contact: '在「隐私与记录」页提交申请，或联系招聘负责人',
  responseDeadlineDays: 15,
};

export const AI_LABEL = {
  cardBadge: 'AI 生成的草稿，需面试官确认',
  exportFooter: '这份面评由 AI 起草，面试官已逐条确认；评分与结论由人作出。',
} as const;

/** A purely automated decision may not be the basis of the hiring outcome. */
export const REFERENCE_ONLY_DISCLAIMER = 'AI 只整理原话和草稿，评分与结论由人作出，仅供参考；候选人有权要求人工复核。';

export function aiBadgeText(hasHumanRevision: boolean): string {
  return hasHumanRevision ? `${AI_LABEL.cardBadge} · 已由面试官修订` : AI_LABEL.cardBadge;
}
