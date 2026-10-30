import { useState } from 'react';
import { FileInput, ScanText } from 'lucide-react';
import { api } from '../api/client';
import { messageOf } from '../session';
import type { InterviewStatus, TranscriptImportPreview, TranscriptSource } from '../api/types';
import { Badge, Btn, ErrorNote, InfoNote, OkNote, Panel, Segmented, cx } from '../ui';

type Role = 'candidate' | 'interviewer' | 'unknown';

const SOURCES: Array<{ key: TranscriptSource; label: string; hint: string }> = [
  { key: 'dingtalk', label: '钉钉听记', hint: '打开这场面试的 AI 听记，导出或复制「原文」，整段粘贴到下面。' },
  { key: 'feishu', label: '飞书妙记', hint: '打开这场面试的妙记，导出或复制「文字记录」，整段粘贴到下面。' },
  { key: 'tencent', label: '腾讯会议', hint: '在会议记录里打开转写，导出或复制全文，整段粘贴到下面。' },
  { key: 'other', label: '其他', hint: '每行一句，可以带 [00:02:15] 这样的时间和「候选人：」这样的前缀。' },
];

const ROLES: Array<{ key: Role; label: string }> = [
  { key: 'candidate', label: '候选人' },
  { key: 'interviewer', label: '面试官' },
  { key: 'unknown', label: '其他人' },
];

const OPEN_STATUSES: InterviewStatus[] = ['in_progress', 'audio_done', 'eval_pending'];

function minutes(ms: number): string {
  return ms < 60_000 ? '不到 1 分钟' : `约 ${Math.round(ms / 60_000)} 分钟`;
}

export function TranscriptImport({
  interviewId,
  status,
  onImported,
}: {
  interviewId: string;
  status: InterviewStatus | null;
  onImported: () => void;
}) {
  const [source, setSource] = useState<TranscriptSource>('dingtalk');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<TranscriptImportPreview | null>(null);
  const [map, setMap] = useState<Record<string, Role>>({});
  const [pending, setPending] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const open = status !== null && OPEN_STATUSES.includes(status);
  const hint = SOURCES.find((s) => s.key === source)?.hint ?? '';
  const hasCandidate = Object.values(map).includes('candidate');

  const reset = (next: string) => {
    setText(next);
    setPreview(null);
    setMap({});
  };

  const runPreview = async () => {
    setPending('preview');
    setError(null);
    setOk(null);
    try {
      const p = await api.previewTranscriptImport(interviewId, text.trim());
      if (p.segments === 0) {
        setError('没有识别出对话。请确认粘贴的是带说话人的转写原文，而不是 AI 生成的摘要。');
        return;
      }
      setPreview(p);
      setMap(Object.fromEntries(p.speakers.map((s) => [s.label, s.guess])));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  const runImport = async () => {
    setPending('import');
    setError(null);
    setOk(null);
    try {
      const res = await api.importTranscript(interviewId, { inlineTranscript: text.trim(), source, speakerMap: map });
      setOk(
        status === 'in_progress'
          ? `已导入 ${res.transcribed} 段对话。右侧可以逐段校对，结束面试后就能生成面评草稿。`
          : `已导入 ${res.transcribed} 段对话。右侧可以逐段校对；到「面评」再点一次「让 AI 先起一稿」，新的原话才会进草稿。`,
      );
      reset('');
      onImported();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <Panel
      title="导入会议转写"
      subtitle="在钉钉、飞书或腾讯会议里正常开会，面试结束后把转写原文粘贴进来。"
      icon={FileInput}
    >
      {!open ? (
        <InfoNote message={status === 'scheduled' ? '先请候选人完成选择并开始面试，之后就可以导入。' : '这场面试的面评已经提交，不再接收新的转写。'} />
      ) : (
        <>
          <Segmented<TranscriptSource>
            options={SOURCES.map((s) => ({ id: s.key, label: s.label }))}
            value={source}
            onChange={setSource}
            label="转写来源"
            full
          />
          <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">{hint}</p>

          <textarea
            rows={6}
            className="field-base mt-3 resize-y text-[13px] leading-relaxed"
            value={text}
            onChange={(e) => reset(e.target.value)}
            aria-label="转写原文"
            placeholder={'周航  00:04:10\n订单拆分以后，库存一致性你们怎么保证？\n\n林嘉禾  00:04:18\n先把扣库存改成预占，下单和支付分两步……'}
          />

          {!preview ? (
            <div className="mt-2 flex justify-end">
              <Btn
                icon={ScanText}
                disabled={pending !== null || text.trim().length < 8}
                busy={pending === 'preview'}
                busyLabel="正在识别…"
                onClick={() => void runPreview()}
              >
                识别发言人
              </Btn>
            </div>
          ) : (
            <div className="inset mt-3 p-4">
              <p className="text-[13px] text-paper">
                识别出 <span className="num font-semibold">{preview.segments}</span> 段对话，{minutes(preview.durationMs)}，
                {preview.speakers.length} 位发言人。请确认谁是候选人：
              </p>
              <div className="mt-3 flex flex-col">
                {preview.speakers.map((s) => (
                  <div key={s.label} className="border-b border-line-soft/70 py-2.5 last:border-0 first:pt-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-paper">{s.label}</span>
                        <Badge tone="idle">{s.segments} 段</Badge>
                      </div>
                      <div className="flex gap-1" role="group" aria-label={`${s.label} 是谁`}>
                        {ROLES.map((r) => (
                          <button
                            key={r.key}
                            type="button"
                            aria-pressed={map[s.label] === r.key}
                            onClick={() => setMap({ ...map, [s.label]: r.key })}
                            className={cx(
                              'press rounded-md border px-2 py-1 text-[12px] font-medium',
                              map[s.label] === r.key
                                ? r.key === 'candidate'
                                  ? 'border-brand/50 bg-brand/12 text-paper'
                                  : 'border-line-hi bg-raise text-paper'
                                : 'border-line text-mist hover:text-paper',
                            )}
                          >
                            {r.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-mist">「{s.sample}」</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">
                面评草稿只引用候选人的原话。面试官和其他人的话会保留，用来还原上下文。
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <Btn variant="quiet" disabled={pending !== null} onClick={() => setPreview(null)}>
                  重新识别
                </Btn>
                <Btn
                  variant="primary"
                  disabled={pending !== null || !hasCandidate}
                  disabledReason={hasCandidate ? undefined : '这场面试还没有候选人，先在岗位页添加。'}
                  busy={pending === 'import'}
                  busyLabel="正在导入…"
                  onClick={() => void runImport()}
                >
                  导入 {preview.segments} 段
                </Btn>
              </div>
            </div>
          )}
        </>
      )}
      <ErrorNote message={error} />
      <OkNote message={ok} />
    </Panel>
  );
}
