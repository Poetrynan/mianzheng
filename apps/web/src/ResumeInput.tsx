import { useEffect, useRef, useState } from 'react';
import { FileCheck2, FileUp, Loader2, X } from 'lucide-react';
import { Btn, ErrorNote, Field, Segmented, cx } from './ui';
import { validateResumeFile, type ResumeImportResult } from './resumeFile';

async function readInWorker(file: File, signal: AbortSignal): Promise<ResumeImportResult> {
  validateResumeFile(file);
  const bytes = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  const worker = new Worker(new URL('./resume.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const dispose = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { dispose(); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { dispose(); reject(new Error('读取超时，请精简文件、重新导出，或使用粘贴文本。')); }, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ type?: string; ok: boolean; result: ResumeImportResult; message: string }>) => {
      // PDF.js also emits worker protocol messages during initialization.
      if (event.data?.type !== 'resume:result') return;
      dispose();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = () => { dispose(); reject(new Error('文件读取器未能启动，请刷新页面重试，或使用粘贴文本。')); };
    try { worker.postMessage({ name: file.name, bytes }, [bytes]); } catch (error) { dispose(); reject(error); }
  });
}

export function ResumeInput({ value, onChange, onNameSuggested, onBusyChange, disabled = false }: {
  value: string; onChange: (text: string) => void; onNameSuggested: (name: string) => void;
  onBusyChange: (busy: boolean) => void; disabled?: boolean;
}) {
  const [mode, setMode] = useState<'file' | 'text'>(value ? 'text' : 'file');
  const [fileName, setFileName] = useState('');
  const [busyName, setBusyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    return () => { revision.current++; controller.current?.abort(); onBusyChange(false); };
  }, [onBusyChange]);

  const importFile = async (file: File) => {
    if (disabled) return;
    controller.current?.abort();
    const current = ++revision.current;
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setBusyName(file.name);
    onBusyChange(true);
    try {
      const result = await readInWorker(file, abort.signal);
      if (current !== revision.current) return;
      onChange(result.text);
      onNameSuggested(result.suggestedName);
      setFileName(result.fileName);
    } catch (err) {
      if (current !== revision.current || (err instanceof Error && err.name === 'AbortError')) return;
      setError((err instanceof Error && err.message ? err.message : '没能读取这份简历，请重新选择文件。') + (value ? ' 当前已有简历内容未改动。' : ''));
    } finally {
      if (current === revision.current) { setBusyName(''); onBusyChange(false); }
    }
  };

  return (
    <div className="mt-4">
      <Segmented options={[{ id: 'file', label: '上传 CV 文件' }, { id: 'text', label: '粘贴文本' }]} value={mode}
        onChange={(next) => { setMode(next); setError(null); }} label="简历录入方式" disabled={Boolean(busyName) || disabled} />
      <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="CV 文件" accept=".pdf,.docx,.txt" disabled={disabled || Boolean(busyName)}
        onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); }} />
      {mode === 'file' ? (
        <div className="mt-3">
          <div className={cx('rounded-xl border border-dashed p-5 text-center transition-colors', dragging ? 'border-brand bg-brand/10' : 'border-line-field bg-raise-soft')}
            onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false);
              if (disabled) return;
              if (e.dataTransfer.files.length !== 1) { setError('每次请选择一份简历。'); return; }
              const file = e.dataTransfer.files[0]; if (file) void importFile(file);
            }}>
            {busyName ? <Loader2 className="mx-auto h-7 w-7 animate-spin text-mist" aria-hidden /> : <FileUp className="mx-auto h-7 w-7 text-mist" strokeWidth={1.5} aria-hidden />}
            <p className="mt-3 text-[14px] font-medium text-paper">{busyName ? '正在读取简历…' : '拖入 CV，或选择文件'}</p>
            <p className="mt-1 break-all text-[12px] leading-relaxed text-mist">{busyName || '支持 PDF、DOCX、TXT，单份不超过 5 MB'}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Btn key="choose-file" variant="primary" onClick={() => { if (input.current) { input.current.value = ''; input.current.click(); } }} disabled={disabled || Boolean(busyName)}>
                {busyName ? '正在读取…' : '选择 CV 文件'}
              </Btn>
              {busyName ? <Btn key="cancel-read" variant="quiet" onClick={() => controller.current?.abort()}>取消读取</Btn> : null}
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-mist-dim">在浏览器中读取原件，仅在你添加候选人时保存提取的文字。扫描图片型 PDF 请先转为可选中文字的文档。</p>
          {fileName && value ? (
            <div className="mt-3 rounded-xl border border-line bg-raise-soft p-3">
              <div className="flex items-start gap-2">
                <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-tint-ok" aria-hidden />
                <div className="min-w-0 flex-1"><p className="break-all text-[13px] font-medium text-paper">{fileName}</p><p className="mt-1 text-[12px] text-mist">已提取 {value.length.toLocaleString()} 字，姓名和正文均可修改。</p></div>
                <button type="button" aria-label="移除已读取的 CV" disabled={disabled || Boolean(busyName)} onClick={() => { setFileName(''); onChange(''); setError(null); }} className="press rounded-md p-1 text-mist hover:bg-raise"><X className="h-4 w-4" /></button>
              </div>
              <details className="mt-3"><summary className="cursor-pointer text-[12px] text-mist">查看并修改提取的正文</summary><div className="mt-3"><Field label="简历正文" multiline rows={8} value={value} onChange={onChange} disabled={disabled || Boolean(busyName)} /></div></details>
            </div>
          ) : null}
        </div>
      ) : <div className="mt-3"><Field label="简历正文" multiline rows={8} value={value} onChange={onChange} disabled={disabled} placeholder="也可以直接粘贴已有的简历文字。" /></div>}
      <div aria-live="polite"><ErrorNote message={error} /></div>
    </div>
  );
}
