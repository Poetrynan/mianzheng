import { useState } from 'react';
import { AlertTriangle, CheckCircle2, History, ScanSearch, Scale, ScrollText, Shield, Trash2, UserCheck } from 'lucide-react';
import { api } from '../api/client';
import { messageOf, useLoader, useSession } from '../session';
import type { ProtectedHit, RetentionReport } from '../api/types';
import {
  ACTOR_LABEL,
  Badge,
  Btn,
  Empty,
  ErrorNote,
  Field,
  Label,
  OkNote,
  Panel,
  PROTECTED_LABEL,
  Segmented,
  Select,
  StatStrip,
  describeAudit,
  fmtTime,
  useBottomFade,
} from '../ui';

type ComplianceTab = 'notices' | 'language' | 'appeals' | 'retention';

const EXAMPLE_TEXT = '我们希望找一位 35 岁以下、能接受高频出差的男性候选人优先。';

export function ComplianceScreen() {
  const { org, interviews } = useSession();
  const orgId = org?.id ?? '';
  const notice = useLoader(() => api.notice(), []);
  const candidates = useLoader(() => api.listCandidates(orgId), [orgId]);
  const audit = useLoader(() => api.audit(orgId, 120), [orgId]);

  const [activeTab, setActiveTab] = useState<ComplianceTab>('notices');
  const [subject, setSubject] = useState('岗位描述');
  const [text, setText] = useState('');
  const [hits, setHits] = useState<ProtectedHit[] | null>(null);
  const [interviewId, setInterviewId] = useState('');
  const [appealReason, setAppealReason] = useState('对 AI 整理的面评有疑问，希望人工重新看一遍面试原话');
  const [candidateId, setCandidateId] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [report, setReport] = useState<RetentionReport | null>(null);

  const { ref: auditRef, more: auditMoreBelow, sync: syncAuditFade } = useBottomFade<HTMLDivElement>();

  const guard = async (label: string, fn: () => Promise<unknown>, done: string | null) => {
    setPending(label);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
      audit.reload();
      candidates.reload();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(null);
    }
  };

  const nameOf = (id: string) => (candidates.data ?? []).find((c) => c.id === id)?.name ?? '候选人';

  // 改过文字后，上一轮的检查结果就不再对应当前内容，先收起来。
  const updateText = (next: string) => {
    setText(next);
    setHits(null);
  };
  const updateSubject = (next: string) => {
    setSubject(next);
    setHits(null);
  };

  return (
    <div className="grid gap-4">
      <Segmented<ComplianceTab>
        options={[
          { id: 'notices', label: '同意与告知', icon: Shield },
          { id: 'language', label: '用语检查', icon: ScanSearch },
          { id: 'appeals', label: '复核申请', icon: Scale },
          { id: 'retention', label: '留存与记录', icon: ScrollText },
        ]}
        value={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setOk(null);
          setError(null);
        }}
        label="隐私与记录"
      />

      <ErrorNote message={error ?? notice.error} />
      <OkNote message={ok} />

      {activeTab === 'notices' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="候选人会看到什么"
            subtitle="开始面试前，候选人会单独看到这段说明，并自己选择是否同意记录。"
            icon={Shield}
          >
            <div className="inset p-4">
              <p className="whitespace-pre-wrap text-[13px] leading-[1.9] text-paper">
                {notice.data?.consentText ?? '加载中…'}
              </p>
            </div>

            <div className="mt-4">
              <StatStrip
                className="sm:grid-cols-2"
                items={[
                  { label: '录音与文字保留', value: `${notice.data?.retention.audioDays ?? 180} 天` },
                  { label: '同意记录保留', value: `${notice.data?.retention.consentDays ?? 730} 天` },
                ]}
              />
            </div>

            <div className="mt-4 text-[12px] leading-relaxed text-mist">
              <p>
                <span className="text-mist-dim">申请复核：</span>
                {notice.data?.appealChannel.label} · {notice.data?.appealChannel.contact}
              </p>
              <p className="mt-0.5">
                会在 {notice.data?.appealChannel.responseDeadlineDays ?? 15} 天内答复。
              </p>
            </div>
          </Panel>

          <Panel title="AI 内容怎样标注" subtitle="草稿、导出和对外说明使用同一套文字，避免口径不一致。" icon={Shield}>
            <div className="flex flex-col gap-3">
              <div className="callout callout-warn p-4">
                <p className="text-[12px] text-mist-dim">草稿上的标识</p>
                <p className="mt-1 text-[13px] font-medium text-tint-warn">
                  {notice.data?.aiLabel.cardBadge ?? 'AI 生成的草稿，需面试官确认'}
                </p>
              </div>

              <div className="inset p-4">
                <p className="text-[12px] text-mist-dim">面评导出时的页脚</p>
                <p className="mt-1 text-[13px] leading-relaxed text-paper">
                  {notice.data?.aiLabel.exportFooter ?? '这份面评由 AI 起草，面试官已逐条确认；评分与结论由人作出。'}
                </p>
              </div>

              <div className="inset p-4">
                <p className="text-[12px] text-mist-dim">底线说明</p>
                <p className="mt-1 text-[13px] leading-relaxed text-paper">
                  {notice.data?.referenceOnly ?? 'AI 只整理原话和草稿，评分与结论由人作出，仅供参考；候选人有权要求人工复核。'}
                </p>
              </div>
            </div>
          </Panel>
        </div>
      ) : null}

      {activeTab === 'language' ? (
        <Panel
          title="用语检查"
          subtitle="检查岗位描述、面评或考察标准里，有没有和岗位无关的个人信息。"
          icon={ScanSearch}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Field label="这段文字用在哪" value={subject} onChange={updateSubject} />
              <div className="mt-3">
                <Field
                  label="文字内容"
                  multiline
                  rows={5}
                  value={text}
                  onChange={updateText}
                  placeholder="粘贴岗位描述、面评或考察标准…"
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Btn
                  variant="primary"
                  disabled={pending !== null || text.trim().length < 2}
                  onClick={() =>
                    void guard(
                      '检查',
                      async () => {
                        const res = await api.scan(subject, { [subject]: text });
                        setHits(res.hits as ProtectedHit[]);
                      },
                      null,
                    )
                  }
                  icon={ScanSearch}
                >
                  检查这段文字
                </Btn>
                <Btn onClick={() => updateText(EXAMPLE_TEXT)}>填入示例</Btn>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">
                性别、年龄、婚育、民族、籍贯、外貌等，都不应该成为招聘判断的一部分。
              </p>
            </div>

            <div className="inset p-4">
              <Label icon={Shield}>{subject}</Label>

              {hits === null ? (
                <Empty text="检查结果会显示在这里" />
              ) : hits.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-6 text-center">
                  <CheckCircle2 className="h-8 w-8 text-ok" />
                  <p className="mt-2 text-[14px] font-medium text-paper">没有发现与岗位无关的信息</p>
                  <p className="mt-1 text-[12px] text-mist-dim">这段文字只谈岗位相关的能力与经历。</p>
                </div>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="callout callout-bad flex items-center gap-2 p-3 text-[12px] text-tint-bad">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>有 {hits.length} 处内容不该写进招聘材料：</span>
                  </div>

                  {hits.map((h, i) => (
                    <div key={`${h.term}-${i}`} className="inset p-3 text-[13px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-tint-bad">{PROTECTED_LABEL[h.category] ?? h.category}</span>
                        <Badge tone="bad">包含「{h.term}」</Badge>
                      </div>
                      <p className="mt-1 leading-relaxed text-paper">{h.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      ) : null}

      {activeTab === 'appeals' ? (
        <Panel
          title="复核申请"
          subtitle="候选人对 AI 整理的内容有疑问时，可以要求人工重新看一遍，不需要付费。"
          icon={Scale}
        >
          <div className="grid max-w-xl gap-4">
            <Select label="是哪一场面试" value={interviewId} onChange={setInterviewId}>
              <option value="">选择…</option>
              {(interviews.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {nameOf(x.candidateId)} · 第 {x.round} 轮
                </option>
              ))}
            </Select>

            <Field label="候选人提出的疑问" multiline rows={4} value={appealReason} onChange={setAppealReason} />

            <div>
              <Btn
                variant="primary"
                disabled={pending !== null || !interviewId || appealReason.trim().length < 4}
                disabledReason={
                  pending !== null
                    ? '正在提交，稍等一下。'
                    : !interviewId
                      ? '先选一场面试。'
                      : appealReason.trim().length < 4
                        ? '把候选人的疑问写清楚再提交。'
                        : undefined
                }
                onClick={() =>
                  void guard(
                    '复核',
                    () => api.appeal(interviewId, appealReason.trim()),
                    '复核申请已登记，会在 15 天内答复。',
                  )
                }
                icon={UserCheck}
              >
                登记复核申请
              </Btn>
            </div>
            <p className="text-[12px] leading-relaxed text-mist-dim">
              复核会由另一位招聘负责人重新查看面试原话，不由原面试官单独回复。
            </p>
          </div>
        </Panel>
      ) : null}

      {activeTab === 'retention' ? (
        <div className="grid gap-4">
          <Panel
            title="留存与删除"
            subtitle="录音和文字最长保留 6 个月；同意记录保留 2 年备查。到期后自动清理。"
            icon={Trash2}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Select label="候选人申请删除" value={candidateId} onChange={setCandidateId}>
                <option value="">选择…</option>
                {(candidates.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.deletedAt ? '（已申请，待清理）' : ''}
                  </option>
                ))}
              </Select>
              <div className="flex flex-wrap gap-2">
                <Btn
                  variant="danger"
                  disabled={pending !== null || !candidateId}
                  disabledReason={
                    pending !== null ? '正在提交，稍等一下。' : '先选一位要清理的候选人。'
                  }
                  onClick={() =>
                    void guard(
                      '删除',
                      async () => {
                        await api.deleteCandidate(candidateId, '候选人申请删除个人资料');
                        setCandidateId('');
                      },
                      '已登记删除申请，到期后会完成清理。',
                    )
                  }
                >
                  登记删除申请
                </Btn>
                <Btn
                  disabled={pending !== null}
                  onClick={() =>
                    void guard(
                      '清理',
                      async () => {
                        const res = await api.retentionSweep();
                        setReport(res);
                      },
                      '到期数据已清理。',
                    )
                  }
                  icon={Trash2}
                >
                  清理到期数据
                </Btn>
              </div>
            </div>

            {report ? (
              <div className="mt-4">
                <StatStrip
                  className="sm:grid-cols-2 lg:grid-cols-3"
                  items={[
                    { label: '清理的转写段落', value: report.transcriptsPurged },
                    { label: '清理的录音片段', value: report.audioPurged },
                    { label: '删除的录音文件', value: report.audioFilesPurged },
                    { label: '完成删除的候选人', value: report.softDeletedCandidatesHardened },
                    { label: '清理的同意记录', value: report.consentLogsPurged, hint: '同意记录保留 2 年' },
                  ]}
                />
              </div>
            ) : null}
          </Panel>

          <Panel title="操作记录" subtitle="谁做了什么、什么时候做的，都留在这里。" icon={History}>
            <div className="relative">
              <div
                ref={auditRef}
                onScroll={syncAuditFade}
                className="max-h-96 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
              >
                {(audit.data ?? []).length === 0 ? <Empty text="还没有记录" /> : null}
                {(audit.data ?? []).map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft/70 py-2 text-[13px] last:border-0"
                  >
                    <span className="text-paper">{describeAudit(a.action)}</span>
                    <div className="flex items-center gap-2">
                      <Badge tone={a.actorType === 'ai' ? 'ai' : a.actorType === 'system' ? 'idle' : 'human'}>
                        {ACTOR_LABEL[a.actorType]}
                      </Badge>
                      <span className="num text-[11px] text-mist-dim">{fmtTime(a.at)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {auditMoreBelow ? <div className="fade-below" aria-hidden /> : null}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
