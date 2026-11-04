export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_RESUME_PAGES = 20;
const MAX_TEXT = 60_000;
export type ResumeFormat = 'pdf' | 'docx' | 'txt';
export interface ResumeImportResult { text: string; suggestedName: string; fileName: string; format: ResumeFormat }
type ResumeInput = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

class ResumeImportError extends Error {}
const aborted = () => new DOMException('已取消读取', 'AbortError');

export function validateResumeFile(file: Pick<File, 'name' | 'size'>): ResumeFormat {
  if (file.size === 0) throw new ResumeImportError('文件为空，请重新选择简历。');
  if (file.size > MAX_RESUME_BYTES) throw new ResumeImportError('简历不能超过 5 MB，请压缩后重试。');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'doc') throw new ResumeImportError('请将旧版 Word 另存为 DOCX 或 PDF 后导入。');
  if (extension !== 'pdf' && extension !== 'docx' && extension !== 'txt') {
    throw new ResumeImportError('支持 PDF、DOCX 和 TXT 简历，请选择对应文件。');
  }
  return extension;
}

export function suggestCandidateName(text: string, fileName: string): string {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const invalid = /简历|履历|个人|工作|教育|项目|经历|工程师|经理|专家|大学|学院|resume|curriculum|experience|education|profile|engineer|skills/i;
  const cleanName = (value: string) => {
    const name = value.trim().split(/[|｜/，,\t]/)[0]?.trim() ?? '';
    return !invalid.test(name) && (/^[\p{Script=Han}·]{2,6}$/u.test(name) || /^[a-z]+(?:[ '-][a-z]+){1,3}$/i.test(name)) ? name : '';
  };
  for (const line of lines) {
    const explicit = /^(?:姓名|name)\s*[:：]\s*(.+)$/i.exec(line);
    if (explicit) { const name = cleanName(explicit[1] ?? ''); if (name) return name; }
  }
  for (const line of lines.slice(0, 3)) { const name = cleanName(line); if (name) return name; }
  for (const part of fileName.replace(/\.[^.]+$/, '').split(/[_\-（）()]/)) {
    const name = cleanName(part); if (name) return name;
  }
  return '';
}

function checkDocx(bytes: Uint8Array) {
  if (bytes[0] !== 80 || bytes[1] !== 75) throw new ResumeImportError('文件内容与 DOCX 格式不符，或文件已损坏、加密。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  let documentFound = false;
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const length = view.getUint16(i + 28, true);
    const end = i + 46 + length;
    if (end > bytes.length) throw new ResumeImportError('Word 文件已损坏，请重新导出。');
    total += view.getUint32(i + 24, true);
    if (total > 20 * 1024 * 1024) throw new ResumeImportError('Word 解压后内容过大，请移除内嵌图片或另存为 PDF。');
    const name = new TextDecoder().decode(bytes.subarray(i + 46, end));
    if (name === 'word/document.xml') documentFound = true;
    i = end + view.getUint16(i + 30, true) + view.getUint16(i + 32, true) - 1;
  }
  if (!documentFound) throw new ResumeImportError('文件中没有可读取的 Word 文档，请重新另存为 DOCX。');
}

export async function readResumeFile(file: ResumeInput, options: { signal?: AbortSignal; workerSrc?: string; assetBase?: string } = {}): Promise<ResumeImportResult> {
  const { signal } = options;
  if (signal?.aborted) throw aborted();
  const format = validateResumeFile(file);
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw aborted();
  const bytes = new Uint8Array(buffer);
  let text = '';
  try {
    if (format === 'pdf') {
      if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new ResumeImportError('文件内容与 PDF 格式不符，或文件已损坏。');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (options.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
      const loading = pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false,
        ...(options.assetBase ? { cMapUrl: options.assetBase + 'cmaps/', cMapPacked: true, standardFontDataUrl: options.assetBase + 'standard_fonts/' } : {}),
      });
      const cancel = () => { void loading.destroy(); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const pdf = await loading.promise;
        if (pdf.numPages > MAX_RESUME_PAGES) throw new ResumeImportError('简历最多支持 20 页，请保留简历相关页面后重试。');
        const pages: string[] = [];
        for (let index = 1; index <= pdf.numPages; index++) {
          if (signal?.aborted) throw aborted();
          const page = await pdf.getPage(index);
          const content = await page.getTextContent();
          const parts = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '');
          pages.push(parts.join(''));
          page.cleanup();
          if (pages.reduce((n, p) => n + p.length, 0) > MAX_TEXT) throw new ResumeImportError('简历正文过长，请精简后导入。');
        }
        text = pages.join('\n\n');
      } finally {
        signal?.removeEventListener('abort', cancel);
        await loading.destroy();
      }
    } else if (format === 'docx') {
      checkDocx(bytes);
      const mammoth = (await import('mammoth/mammoth.browser')).default;
      text = (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
    } else {
      let encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new ResumeImportError('文件不是可读取的简历文本，请选择 PDF、DOCX 或纯文本文件。');
    }
    if (signal?.aborted) throw aborted();
    text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 20) throw new ResumeImportError(format === 'pdf' ? '没有读取到足够文字，可能是扫描版 PDF。请上传可选中文字的 PDF、DOCX，或使用粘贴文本。' : '没有读取到足够的简历文字，请检查文档内容。');
    if (text.length > MAX_TEXT) throw new ResumeImportError('简历正文过长，请精简后导入。');
    return { text, suggestedName: suggestCandidateName(text, file.name), fileName: file.name, format };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw aborted();
    if (error instanceof ResumeImportError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') throw new ResumeImportError('PDF 已加密，请先解除密码后再导入。');
    throw new ResumeImportError('没能读取这份简历，请确认文件未损坏、未加密，或重新导出为 PDF / DOCX。');
  }
}
