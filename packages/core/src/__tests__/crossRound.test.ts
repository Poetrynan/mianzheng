import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import type { FixedClock } from '../clock.js';
import { humanActor } from '../services/context.js';
import { closeInterview, defaultAppDeps, openInterview, seedConfirmedStandard, seedTeam, type SeededTeam } from './fixtures.js';

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

async function submittedFirstRound(): Promise<{ candidateId: string; gapDimensionId: string; gapDimensionName: string; unbacked: string[] }> {
  seedConfirmedStandard(app, team);
  const { interview, candidateId } = await openInterview(app, team);
  closeInterview(app, team, interview.id);
  const { draft } = await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);
  app.evaluation.setRecommendation(humanActor(team.interviewer), draft.id, '建议进入下一轮');
  for (const c of draft.checks) {
    app.evaluation.reviseCheck(humanActor(team.interviewer), draft.id, c.id, { finalScore: 'medium' });
  }
  app.evaluation.submit(humanActor(team.interviewer), draft.id, { fillUnscored: false, agreeUsedForDecision: true, anonymizeName: false });

  const submitted = app.store.findDraft(draft.id)!;
  const gap = submitted.checks.find((c) => c.aiEvidence.length > 0 || c.finalEvidence.length > 0)!;
  const forced = submitted.checks.map((c) => (c.id === gap.id ? { ...c, aiEvidence: [], finalEvidence: [] } : c));
  app.store.saveDraft({ ...submitted, checks: forced });
  const unbacked = forced.filter((c) => c.aiEvidence.length === 0 && c.finalEvidence.length === 0).map((c) => c.dimensionId);
  return { candidateId, gapDimensionId: gap.dimensionId, gapDimensionName: gap.dimensionName, unbacked };
}

function scheduleRound(candidateId: string, round: number) {
  return app.flow.schedule(humanActor(team.hr), {
    jobId: team.jobId,
    candidateId,
    interviewerIds: [team.interviewer.id],
    scheduledAt: clock.now().toISOString(),
    channel: 'video',
    round,
  });
}

describe('跨轮次：上一轮证据不足的维度，下一轮一页纸先问', () => {
  it('二面的一页纸带上一面没找到原话的维度，并把对应追问排在最前', async () => {
    const { candidateId, gapDimensionId, gapDimensionName, unbacked } = await submittedFirstRound();
    const second = scheduleRound(candidateId, 2);
    const pack = await app.prepPack.build(humanActor(team.interviewer), second.id);

    expect(pack.carryOver?.map((c) => c.dimensionId).sort()).toEqual([...unbacked].sort());
    expect(pack.carryOver).toContainEqual({
      dimensionId: gapDimensionId,
      dimensionName: gapDimensionName,
      fromRound: 1,
      reason: '没有找到候选人的原话',
    });
    expect(unbacked).toContain(pack.questions[0]?.dimensionId);
    expect(pack.questions[0]?.why).toContain('第 1 轮');
    expect(pack.alignment.find((a) => a.dimensionId === gapDimensionId)?.mark).toBe('needs_probe');
  });

  it('上一轮的面评还没提交时不带过来：没人确认过的草稿不算证据缺口', async () => {
    seedConfirmedStandard(app, team);
    const { interview, candidateId } = await openInterview(app, team);
    closeInterview(app, team, interview.id);
    await app.evaluation.generateDraft(humanActor(team.interviewer), interview.id, team.interviewer.id);

    const second = scheduleRound(candidateId, 2);
    const pack = await app.prepPack.build(humanActor(team.interviewer), second.id);
    expect(pack.carryOver).toEqual([]);
  });

  it('一面不会继承任何东西', async () => {
    seedConfirmedStandard(app, team);
    const { interview } = await openInterview(app, team);
    const pack = await app.prepPack.build(humanActor(team.interviewer), interview.id);
    expect(pack.carryOver).toEqual([]);
  });
});
