import { beforeEach, describe, expect, it } from 'vitest';
import { MianYanApp } from '../app.js';
import type { FixedClock } from '../clock.js';
import { humanActor } from '../services/context.js';
import { applySpeakerMap, detectSpeakers, parseMeetingExport } from '../ai/asr.js';
import { defaultAppDeps, RESUME_TEXT, seedConfirmedStandard, seedTeam, type SeededTeam } from './fixtures.js';

const FEISHU_EXPORT = [
  '周航  00:04:10',
  '订单拆分以后，库存一致性你们怎么保证？',
  '',
  '林嘉禾  00:04:18',
  '先把扣库存改成预占，',
  '下单和支付分两步，超时自动释放，对账每 5 分钟跑一次。',
  '',
  '周航  00:07:20',
  '你们约的上线时间是几点？',
  '',
  '林嘉禾  00:07:26',
  '定在晚上',
  '22:00',
].join('\n');

let app: MianYanApp;
let clock: FixedClock;
let team: SeededTeam;

beforeEach(async () => {
  const deps = defaultAppDeps();
  clock = deps.clock;
  app = await MianYanApp.open({ dbPath: ':memory:', clock, llm: deps.llm, asr: deps.asr });
  team = seedTeam(app);
});

function scheduleWithConsent(decision: 'granted' | 'refused') {
  seedConfirmedStandard(app, team);
  const candidate = app.addCandidate(team.orgId, team.jobId, '林嘉禾', RESUME_TEXT);
  const interview = app.flow.schedule(humanActor(team.hr), {
    jobId: team.jobId,
    candidateId: candidate.id,
    interviewerIds: [team.interviewer.id],
    scheduledAt: clock.now().toISOString(),
    channel: 'video',
    round: 1,
  });
  const prompt = app.flow.presentConsent(interview.id);
  app.flow.answerConsent(humanActor(team.hr), interview.id, decision, prompt.presentedAt);
  return { interview, candidate };
}

describe('会议软件导出稿解析', () => {
  it('飞书妙记 / 钉钉听记的「说话人 时间」抬头格式：正文可以跨行，单独一行的时刻不会被当成抬头', () => {
    const segs = parseMeetingExport(FEISHU_EXPORT);
    expect(segs.map((s) => s.speakerLabel)).toEqual(['周航', '林嘉禾', '周航', '林嘉禾']);
    expect(segs[0]?.startMs).toBe(250_000);
    expect(segs[1]?.text).toBe('先把扣库存改成预占，下单和支付分两步，超时自动释放，对账每 5 分钟跑一次。');
    expect(segs[3]?.text).toBe('定在晚上22:00');
    expect(segs.every((s) => s.speaker === 'unknown')).toBe(true);
    for (let i = 0; i < segs.length - 1; i += 1) {
      expect(segs[i]!.endMs).toBeLessThanOrEqual(segs[i + 1]!.startMs);
    }
  });

  it('钉钉「发言人 1」这类带编号的匿名标签保留编号', () => {
    const segs = parseMeetingExport('发言人 1  00:00:05\n请先介绍一下最近的项目。\n发言人 2  00:00:12\n我负责订单系统重构。');
    expect(segs.map((s) => s.speakerLabel)).toEqual(['发言人 1', '发言人 2']);
  });

  it('腾讯会议「张三(00:01:23)：……」单行格式', () => {
    const segs = parseMeetingExport('张三(00:01:23)：你好，先做个自我介绍吧。\n李四（00:01:30）：好的，我叫李四。');
    expect(segs.map((s) => [s.speakerLabel, s.startMs, s.text])).toEqual([
      ['张三', 83_000, '你好，先做个自我介绍吧。'],
      ['李四', 90_000, '好的，我叫李四。'],
    ]);
  });

  it('不认识的格式退回逐行解析，「候选人：」前缀直接识别为候选人', () => {
    const segs = parseMeetingExport('[00:01:20] 面试官：讲讲缓存改造。\n[00:01:45] 候选人：我们把单机缓存做成了分片集群。');
    expect(segs.map((s) => s.speaker)).toEqual(['interviewer', 'candidate']);
  });

  it('两个匿名发言人时，说得多的一方先猜作候选人；用户的对应关系覆盖猜测', () => {
    const segs = parseMeetingExport(FEISHU_EXPORT);
    const speakers = detectSpeakers(segs);
    expect(speakers.find((s) => s.label === '林嘉禾')?.guess).toBe('candidate');
    expect(speakers.find((s) => s.label === '周航')?.guess).toBe('interviewer');

    const mapped = applySpeakerMap(segs, { 周航: 'candidate', 林嘉禾: 'interviewer' });
    expect(mapped.filter((s) => s.speaker === 'candidate').map((s) => s.speakerLabel)).toEqual(['周航', '周航']);
  });

  it('发言人名字里带「面试官」时，剩下那一位猜成候选人', () => {
    const segs = parseMeetingExport(
      ['王面试官  00:20:05', '具体怎么验证的？', '', '张伟  00:20:14', '做了全链路压测，读库先到瓶颈。', '', '王面试官  00:21:02', '上线后出过问题吗？'].join('\n'),
    );
    const speakers = detectSpeakers(segs);
    expect(speakers.find((s) => s.label === '王面试官')?.guess).toBe('interviewer');
    expect(speakers.find((s) => s.label === '张伟')?.guess).toBe('candidate');
  });
});

describe('导入转写是第一版的主路径', () => {
  it('面试结束后仍可导入，候选人原话挂到候选人名下并留审计', () => {
    const { interview, candidate } = scheduleWithConsent('granted');
    app.flow.start(humanActor(team.interviewer), interview.id);
    app.flow.finish(humanActor(team.interviewer), interview.id);

    const segs = applySpeakerMap(parseMeetingExport(FEISHU_EXPORT), { 林嘉禾: 'candidate', 周航: 'interviewer' });
    const res = app.flow.importTranscript(humanActor(team.interviewer), interview.id, segs, 'feishu');

    expect(res.saved).toHaveLength(4);
    const stored = app.store.listSegments(interview.id);
    expect(stored.filter((s) => s.speaker === 'candidate').every((s) => s.speakerId === candidate.id)).toBe(true);
    const audit = app.store.listAuditByOrg(team.orgId).find((a) => a.action === 'transcript.import');
    expect(audit).toBeDefined();
  });

  it('负向：候选人拒绝记录时不能导入', () => {
    const { interview } = scheduleWithConsent('refused');
    app.flow.start(humanActor(team.interviewer), interview.id);
    const segs = applySpeakerMap(parseMeetingExport(FEISHU_EXPORT), { 林嘉禾: 'candidate' });
    expect(() => app.flow.importTranscript(humanActor(team.interviewer), interview.id, segs, 'feishu')).toThrowError(
      expect.objectContaining({ code: 'consent_refused_no_transcript' }),
    );
    expect(app.store.listSegments(interview.id)).toHaveLength(0);
  });

  it('负向：没指定候选人就不导入，草稿只能引用候选人的原话', () => {
    const { interview } = scheduleWithConsent('granted');
    app.flow.start(humanActor(team.interviewer), interview.id);
    const segs = parseMeetingExport(FEISHU_EXPORT);
    expect(() => app.flow.importTranscript(humanActor(team.interviewer), interview.id, segs, 'feishu')).toThrowError(
      expect.objectContaining({ code: 'candidate_unassigned' }),
    );
  });

  it('负向：面试还没开始不能导入', () => {
    const { interview } = scheduleWithConsent('granted');
    const segs = applySpeakerMap(parseMeetingExport(FEISHU_EXPORT), { 林嘉禾: 'candidate' });
    expect(() => app.flow.importTranscript(humanActor(team.interviewer), interview.id, segs, 'other')).toThrowError(
      expect.objectContaining({ code: 'import_wrong_state' }),
    );
  });
});
