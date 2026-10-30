import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Clock3,
  Edit3,
  FileText,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Shield,
  Square,
  Volume2,
} from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useDirectory, useLoader, useSession } from '../session';
import type { ConsentPrompt, TranscriptSegment } from '../api/types';
import { useInterviewRecorder, type Speaker } from '../recorder';
import { TranscriptImport } from './TranscriptImport';
import {
  AudioWaveVisualizer,
  Badge,
  Btn,
  Chip,
  Empty,
  ErrorNote,
  InfoNote,
  InterviewPill,
  OkNote,
  Panel,
  Segmented,
  clock,
  cx,
  useBottomFade,
} from '../ui';

const SPEAKER_META: Record<string, { label: string; tone: 'ai' | 'human' | 'idle' }> = {
  candidate: { label: '候选人', tone: 'ai' },
  interviewer: { label: '面试官', tone: 'human' },
  unknown: { label: '发言人', tone: 'idle' },
};

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function LiveScreen({
  interviewId,
  onPickInterview,
  onGoDraft,
}: {
  interviewId: string;
  onPickInterview: (id: string) => void;
  onGoDraft?: () => void;
}) {
  const { org, interviews } = useSession();
  const orgId = org?.id ?? '';
  const dir = useDirectory(orgId);
  const interview = useLoader(interviewId ? () => api.getInterview(interviewId) : async () => null, [interviewId]);
  const transcript = useLoader(
    interviewId ? () => api.getTranscript(interviewId) : async () => ({ segments: [] as TranscriptSegment[] }),
    [interviewId],
  );

  const [prompt, setPrompt] = useState<ConsentPrompt | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const it = interview.data;
  const rec = useInterviewRecorder({
    interviewId,
    interviewStartedAt: it?.startedAt ?? null,
    onSaved: () => transcript.reload(),
  });

  const refreshAll = () => {
    interview.reload();
    transcript.reload();
    interviews.reload();
  };

  const guard = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setPending(label);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
      refreshAll();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    if (!it || it.status !== 'scheduled' || it.consentId) {
      setPrompt(null);
      return;
    }
    api
      .presentConsent(it.id)
      .then(setPrompt)
      .catch(() => setPrompt(null));
  }, [it]);

  if (!interviewId) {
    const list = interviews.data ?? [];
    return (
      <Panel title="选择一场面试" subtitle="候选人同意后，才能导入这场面试的转写或录音。" icon={Mic}>
        <div className="flex flex-col gap-1.5">
          {list.length === 0 ? <Empty text="还没有排好的面试，先去「岗位与面试」安排一场。" /> : null}
          {list.map((x) => (
            <Chip key={x.id} selected={false} onClick={() => onPickInterview(x.id)} right={<InterviewPill status={x.status} />}>
              {dir.labelOf(x)}
            </Chip>
          ))}
        </div>
      </Panel>
    );
  }

  const live = rec.status === 'recording';
  const paused = rec.status === 'paused' || Boolean(it?.pausedAt && it?.status === 'in_progress');
  const transcriptCount = transcript.data?.segments.length ?? 0;
  const { ref: transcriptRef, more: transcriptMoreBelow, sync: syncTranscriptFade } = useBottomFade<HTMLDivElement>();
  const recordingAllowed = Boolean(it?.aiRecordingActive);
  const consentLine = recordingAllowed
    ? '候选人已同意本次记录'
    : it?.status === 'in_progress'
      ? '候选人选择只做人工笔记'
      : it?.consentId
        ? '候选人已完成选择，面试开始后生效'
        : '等待候选人选择';
  const speaker = rec.speaker;

  const chooseSpeaker = (next: Speaker) => rec.setSpeaker(next);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      {prompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm">
          <div className="surface-2 w-full max-w-lg p-6 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/12 text-brand">
                <Shield className="h-4.5 w-4.5" />
              </span>
              <div>
                <h2 className="text-[17px] font-semibold text-paper">开始前，请候选人自己选择</h2>
                <p className="mt-0.5 text-[12px] text-mist">这段说明只用于本场面试，不会默认勾选。</p>
              </div>
            </div>

            <div className="inset mt-4 max-h-64 overflow-y-auto p-4 text-[13px] leading-[1.85] text-paper [scrollbar-gutter:stable]">
              <p className="whitespace-pre-wrap">{prompt.noticeText}</p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {prompt.buttons.map((b) => {
                const grant = b.decision === 'granted';
                return (
                  <button
                    key={b.decision}
                    type="button"
                    onClick={() =>
                      void guard(
                        '知情同意',
                        async () => {
                          await api.answerConsent(prompt.interviewId, b.decision, prompt.presentedAt);
                          setPrompt(null);
                        },
                        grant ? '候选人已同意记录。点击「开始面试」后，可以导入会议转写或用本机录音。' : '已按候选人的选择关闭记录，面试将只做人工笔记。',
                      )
                    }
                    className={cx(
                      'press rounded-xl border px-4 py-3 text-[13px] font-medium',
                      grant
                        ? 'border-brand/40 bg-brand/10 text-paper hover:bg-brand/15'
                        : 'border-line bg-raise-soft text-paper hover:border-line-hi hover:bg-raise',
                    )}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-center text-[12px] leading-relaxed text-mist-dim">
              两个选项同等有效。拒绝记录不会影响面试进行，也不会影响对候选人的评价。
            </p>
            <ErrorNote message={error} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Panel
          title="这场面试"
          subtitle="面试照常在会议软件里进行。没有会议软件时，可以用本机录音，敏感话题随时暂停。"
          icon={Mic}
          right={<InterviewPill status={it?.status ?? 'scheduled'} />}
        >
          <div className="inset p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-medium text-mist">已记录</p>
                <p className="num mt-1 text-[32px] font-semibold leading-none tracking-[-0.02em] text-paper">
                  {duration(rec.elapsedMs)}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Badge tone={live ? 'ok' : paused ? 'warn' : 'idle'}>
                    {live ? '正在记录' : paused ? '记录已暂停' : rec.status === 'requesting' ? '正在打开麦克风' : rec.status === 'stopping' ? '正在保存' : '未在记录'}
                  </Badge>
                  {live ? <AudioWaveVisualizer active /> : null}
                </div>
              </div>
              <div className="text-right">
                <p className="text-[12px] font-medium text-mist">转写</p>
                <p className="num mt-1 text-[20px] font-semibold leading-none text-paper">{transcriptCount} 段</p>
                <p className="mt-1.5 text-[12px] text-mist-dim">
                  {rec.pending > 0 ? `正在转写 ${rec.pending} 段` : rec.failed > 0 ? `${rec.failed} 段待重试` : '已全部保存'}
                </p>
              </div>
            </div>

            <div className="mt-5">
              <p className="mb-1.5 text-[12px] font-medium text-mist">现在是谁在说</p>
              <Segmented<Speaker>
                options={[
                  { id: 'candidate', label: '候选人' },
                  { id: 'interviewer', label: '面试官（我）' },
                ]}
                value={speaker}
                onChange={chooseSpeaker}
                label="当前说话人"
                full
              />
              <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">
                切换后，接下来的一段会记到另一个人名下。已经录好的内容不会变。
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {it?.status === 'scheduled' ? (
                <Btn
                  variant="primary"
                  icon={Play}
                  busy={pending === '开始面试'}
                  busyLabel="正在开始…"
                  disabled={pending !== null || Boolean(prompt)}
                  onClick={() =>
                    void guard(
                      '开始面试',
                      async () => {
                        await api.start(interviewId);
                      },
                      '面试已开始。结束后把会议转写导入下方，或现在打开本机录音。',
                    )
                  }
                >
                  开始面试
                </Btn>
              ) : null}

              {it?.status === 'in_progress' && rec.status === 'idle' ? (
                <Btn
                  icon={Mic}
                  busy={pending === '开始记录'}
                  busyLabel="正在打开麦克风…"
                  disabled={pending !== null || !recordingAllowed}
                  onClick={() =>
                    void guard(
                      '开始记录',
                      async () => {
                        if (paused) await api.setPaused(interviewId, false);
                        await rec.start();
                      },
                      '已请求打开麦克风。',
                    )
                  }
                >
                  {paused ? '继续本机录音' : '用本机录音'}
                </Btn>
              ) : null}

              {it?.status === 'in_progress' && (live || rec.status === 'requesting') ? (
                <Btn
                  icon={Pause}
                  disabled={pending !== null || !live}
                  onClick={() =>
                    void guard(
                      '暂停记录',
                      async () => {
                        await api.setPaused(interviewId, true);
                        rec.pause();
                      },
                      '记录已暂停，麦克风已关闭。继续时点「继续记录」。',
                    )
                  }
                >
                  暂停记录
                </Btn>
              ) : null}

              {it?.status === 'in_progress' && rec.status === 'paused' ? (
                <Btn
                  variant="primary"
                  icon={Play}
                  busy={pending === '继续记录'}
                  busyLabel="正在恢复…"
                  disabled={pending !== null}
                  onClick={() =>
                    void guard(
                      '继续记录',
                      async () => {
                        await api.setPaused(interviewId, false);
                        rec.resume();
                      },
                      '记录已恢复。',
                    )
                  }
                >
                  继续记录
                </Btn>
              ) : null}

              {it?.status === 'in_progress' ? (
                <Btn
                  variant="danger"
                  icon={Square}
                  busy={pending === '结束面试'}
                  busyLabel="正在保存…"
                  disabled={pending !== null}
                  onClick={() =>
                    void guard(
                      '结束面试',
                      async () => {
                        await rec.stop();
                        await api.finish(interviewId);
                      },
                      transcriptCount > 0
                        ? '面试已结束，对话都保存好了，接下来可以去写面评。'
                        : '面试已结束。把会议转写导入下方，就可以去写面评。',
                    )
                  }
                >
                  结束面试
                </Btn>
              ) : null}

              {it?.status === 'audio_done' || it?.status === 'eval_pending' ? (
                <Btn variant="primary" icon={FileText} onClick={onGoDraft}>
                  去写面评
                </Btn>
              ) : null}
            </div>

            {rec.lastError ? (
              <div className="callout callout-bad mt-3 px-3 py-2 text-[13px] leading-relaxed text-tint-bad">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                  <div className="flex-1">
                    <p>{rec.lastError}</p>
                    {rec.failed > 0 ? (
                      <button type="button" onClick={rec.retryFailed} className="mt-1.5 inline-flex items-center gap-1 font-medium underline underline-offset-2">
                        <RefreshCw className="h-3 w-3" /> 重试上传
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            <ErrorNote message={error} />
            <OkNote message={ok} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-mist-dim">
            <span className="inline-flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              {consentLine}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" />
              录音与文字最长保留 6 个月
            </span>
          </div>
        </Panel>

        <TranscriptImport interviewId={interviewId} status={it?.status ?? null} onImported={refreshAll} />

        <Panel title="面试之外，不要记录" subtitle="聊到薪资、家庭、健康等私人话题时，先暂停会议转写或本机录音。" icon={Shield}>
          <p className="text-[13px] leading-relaxed text-mist">
            导入前，可以先在会议软件里删掉与岗位无关的段落；导入后，右侧每一段都能校对。候选人也可以随时要求查看或删除本次记录。
          </p>
        </Panel>
      </div>

      <Panel
        title="对话原话"
        subtitle="每一段都带时间和说话人，写面评时可以直接引用。"
        icon={Volume2}
        right={<Badge tone="idle">{transcriptCount} 段</Badge>}
      >
        <div className="relative">
          <div
            ref={transcriptRef}
            onScroll={syncTranscriptFade}
            className="flex max-h-[560px] flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
          >
          {(transcript.data?.segments ?? []).length === 0 ? (
            <Empty text="还没有对话。导入会议转写或打开本机录音后，原话会出现在这里。" icon={Volume2} />
          ) : null}

          {(transcript.data?.segments ?? []).map((seg) => {
            const meta = SPEAKER_META[seg.speaker] ?? SPEAKER_META.unknown!;
            const unsure = seg.confidence < 0.7;
            return (
              <div key={seg.id} className={cx('p-3', unsure ? 'callout callout-warn' : 'inset')}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="num text-[12px] tabular-nums text-mist-dim">{clock(seg.startMs)}</span>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {seg.correctedBy ? <Badge tone="ok">已校对</Badge> : null}
                    {unsure ? <Badge tone="warn">识别不确定</Badge> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditing({ id: seg.id, text: seg.text })}
                    className="press inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-mist hover:bg-raise hover:text-paper"
                  >
                    <Edit3 className="h-3 w-3" /> 校对
                  </button>
                </div>

                {editing?.id === seg.id ? (
                  <div className="mt-2">
                    <textarea
                      className="field-base border-brand/50 text-[13px] leading-relaxed"
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    />
                    <div className="mt-2 flex gap-2">
                      <Btn
                        variant="primary"
                        disabled={pending !== null || editing.text.trim().length === 0}
                        onClick={() =>
                          void guard(
                            '校对',
                            async () => {
                              await api.correctSegment(editing.id, editing.text.trim());
                              setEditing(null);
                            },
                            '这段原话已经按你的修改保存。',
                          )
                        }
                      >
                        保存
                      </Btn>
                      <Btn onClick={() => setEditing(null)}>取消</Btn>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1.5 text-[13px] leading-[1.75] text-paper">{seg.text}</p>
                )}
              </div>
            );
          })}
          </div>
          {transcriptMoreBelow ? <div className="fade-below" aria-hidden /> : null}
        </div>

        <InfoNote message={it && !it.aiRecordingActive && it.status === 'in_progress' ? '候选人选择了只做人工笔记，这场面试不导入转写，也不录音。' : null} />
        <InfoNote message={it?.status === 'eval_pending' ? '面试已经结束。已保存的对话仍可校对，提交面评前也可以继续导入转写。' : null} />
      </Panel>
    </div>
  );
}
