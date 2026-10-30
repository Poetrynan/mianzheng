import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import type { FixedClock } from '../clock.js';
import { humanActor } from '../services/context.js';
import {
  FIXTURE_DIMENSIONS,
  TRANSCRIPT_TEXT,
  closeInterview,
  defaultAppDeps,
  openInterview,
  seedConfirmedStandard,
  seedTeam,
  type SeededTeam,
} from './fixtures.js';

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

const iv = () => humanActor(team.interviewer);
const hr = () => humanActor(team.hr);

/** 排一场新的面试并走完同意、转写、结束，返回面试 id。 */
async function runInterview(candidateId: string, round: number): Promise<string> {
  const interview = app.flow.schedule(hr(), {
    jobId: team.jobId,
    candidateId,
    interviewerIds: [team.interviewer.id],
    scheduledAt: clock.now().toISOString(),
    channel: 'video',
    round,
  });
  const prompt = app.flow.presentConsent(interview.id);
  app.flow.answerConsent(hr(), interview.id, 'granted', prompt.presentedAt);
  app.flow.start(iv(), interview.id);
  const raw = await app.ctx.asr.transcribe({ inlineTranscript: TRANSCRIPT_TEXT });
  app.flow.appendSegments(iv(), interview.id, raw);
  app.flow.finish(iv(), interview.id);
  return interview.id;
}

/** 起草、给指定维度一个由面试官落下的终评、提交（其余维度显式确认留空）。 */
async function submitDraft(interviewId: string, patch: { dimensionId: string; level: 'high' | 'medium' | 'low' }) {
  const { draft } = await app.evaluation.generateDraft(iv(), interviewId, team.interviewer.id);
  const target = draft.checks.find((c) => c.dimensionId === patch.dimensionId);
  if (!target) throw new Error('fixture dimension missing');
  app.evaluation.reviseCheck(iv(), draft.id, target.id, {
    finalScore: patch.level,
    finalSummary: '按原话记录。',
    addEvidenceSegmentIds: target.aiEvidence.map((e) => e.segmentId),
  });
  app.evaluation.setRecommendation(iv(), draft.id, '建议进入下一轮，先补这一轮没拿到原话的维度。');
  return app.evaluation.submit(iv(), draft.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: true });
}

function rowOf(candidateId: string) {
  const res = app.board.candidateResults(team.orgId, team.jobId);
  const row = res.candidates.find((c) => c.candidateId === candidateId);
  if (!row) throw new Error('candidate missing from results');
  return row;
}

describe('候选人结果矩阵：轴按岗位标准，取值只认面试官终评', () => {
  it('AI 起评分不进矩阵：只有面试官落下的终评和挂上的原话才算数', async () => {
    const std = seedConfirmedStandard(app, team);
    const { interview, candidateId } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    const { draft } = await app.evaluation.generateDraft(iv(), interview.id, team.interviewer.id);
    const withQuote = draft.checks.find((c) => c.aiEvidence.length > 0);
    if (!withQuote) throw new Error('fixture evidence missing');

    /** 草稿还没提交，矩阵就该是空的：AI 的起评分不构成结果。 */
    expect(rowOf(candidateId).submittedRounds).toBe(0);
    expect(rowOf(candidateId).cells.every((c) => c.level === null)).toBe(true);

    app.evaluation.reviseCheck(iv(), draft.id, withQuote.id, {
      finalScore: 'high',
      finalSummary: '原话里讲清了取舍。',
      addEvidenceSegmentIds: withQuote.aiEvidence.map((e) => e.segmentId),
    });
    /** 第二维只落判断、不挂原话：矩阵要把它算作缺口，而不是当成已经考察过。 */
    const bare = draft.checks.find((c) => c.id !== withQuote.id);
    if (!bare) throw new Error('fixture second dimension missing');
    app.evaluation.reviseCheck(iv(), draft.id, bare.id, { finalScore: 'low', finalSummary: '判断给了，但没留原话。' });
    app.evaluation.setRecommendation(iv(), draft.id, '建议进入下一轮。');
    app.evaluation.submit(iv(), draft.id, { fillUnscored: true, agreeUsedForDecision: true, anonymizeName: true });

    const row = rowOf(candidateId);
    expect(row.cells.map((c) => c.dimensionName)).toEqual(FIXTURE_DIMENSIONS);
    expect(row.submittedRounds).toBe(1);
    const scored = row.cells.find((c) => c.dimensionId === withQuote.dimensionId);
    expect(scored?.level).toBe('high');
    expect(scored?.evidenceCount).toBe(withQuote.aiEvidence.length);
    expect(scored?.evidence.length).toBe(withQuote.aiEvidence.length);
    expect(scored?.evidence.every((item) => item.quote.length > 0 && Number.isFinite(item.startMs))).toBe(true);
    expect(scored?.interviewerName).toBe(team.interviewer.name);
    expect(scored?.summary).toBe('原话里讲清了取舍。');
    const unbacked = row.cells.find((c) => c.dimensionId === bare.dimensionId);
    expect(unbacked?.level).toBe('low');
    expect(unbacked?.evidenceCount).toBe(0);
    /** 判断挂了但没有原话：点开这一维时一句都拿不出来，不是拿别人的话凑数。 */
    expect(unbacked?.evidence).toEqual([]);
    /** 其余维度面试官没评：即使 AI 起过评分，也仍然是缺口。 */
    expect(row.scored).toBe(2);
    expect(row.gaps).toBe(std.dimensions.length - 1);
    expect(row.cells.filter((c) => c.dimensionId !== withQuote.dimensionId && c.dimensionId !== bare.dimensionId).every((c) => c.level === null)).toBe(true);
  });

  it('后面的轮次覆盖前面的轮次，轴上留的是最近一次终评', async () => {
    const std = seedConfirmedStandard(app, team);
    const dim = std.dimensions[0];
    if (!dim) throw new Error('fixture dimension missing');
    const { candidateId } = await openInterview(app, team);
    await submitDraft(await runInterview(candidateId, 1), { dimensionId: dim.id, level: 'high' });
    expect(rowOf(candidateId).cells.find((c) => c.dimensionId === dim.id)?.level).toBe('high');

    await submitDraft(await runInterview(candidateId, 2), { dimensionId: dim.id, level: 'low' });

    const row = rowOf(candidateId);
    const cell = row.cells.find((c) => c.dimensionId === dim.id);
    expect(cell?.level).toBe('low');
    expect(cell?.round).toBe(2);
    expect(row.submittedRounds).toBe(2);
    expect(row.recommendation).toContain('下一轮');
  });

  it('一场面评都没提交时整条矩阵留空，不编出一个形状', async () => {
    seedConfirmedStandard(app, team);
    const { interview, candidateId } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(iv(), interview.id, team.interviewer.id);

    const row = rowOf(candidateId);
    expect(row.rounds).toBe(1);
    expect(row.submittedRounds).toBe(0);
    expect(row.cells.every((c) => c.level === null && c.evidenceCount === 0)).toBe(true);
    expect(row.gaps).toBe(row.cells.length);
    expect(row.lastSubmittedAt).toBeNull();
  });

  it('标准还没定稿时不返回维度轴', () => {
    const res = app.board.candidateResults(team.orgId, team.jobId);
    expect(res.standard).toBeNull();
    expect(res.candidates).toEqual([]);
  });
});
