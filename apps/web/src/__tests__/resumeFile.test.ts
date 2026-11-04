import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readResumeFile, suggestCandidateName, validateResumeFile } from '../resumeFile';

const fixture = (name: string) => new File([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))], name);

describe('CV file import', () => {
  it('extracts actual PDF text, not the file name', async () => {
    const result = await readResumeFile(fixture('Alex-Chen.pdf'));
    expect(result.text).toContain('Backend Engineer');
    expect(result.text).toContain('Led a payments migration');
    expect(result.suggestedName).toBe('Alex Chen');
  });
  it('extracts Chinese text from an actual DOCX file', async () => {
    const result = await readResumeFile(fixture('sample.docx'));
    expect(result.text).toContain('推动五个团队完成接口改造');
    expect(result.suggestedName).toBe('张伟');
  });
  it('reads a text CV and preserves its lines', async () => {
    const result = await readResumeFile(new File(['姓名：李雪\n六年前端经验\n负责组件库与微前端迁移，推动多个团队统一发布流程。'], 'CV.txt'));
    expect(result.text).toContain('\n');
    expect(result.suggestedName).toBe('李雪');
  });
  it('reports a PDF without extractable text instead of importing an empty CV', async () => {
    await expect(readResumeFile(fixture('scan.pdf'))).rejects.toThrow(/扫描|文字/);
  });
  it('rejects a disguised PDF', async () => {
    await expect(readResumeFile(new File(['This is not a PDF document'], 'wrong.pdf'))).rejects.toThrow(/内容|损坏/);
  });
  it('rejects unsupported legacy Word files with a conversion instruction', () => {
    expect(() => validateResumeFile({ name: 'resume.doc', size: 300 })).toThrow(/DOCX/);
  });
  it('rejects empty and oversized files before reading them', () => {
    expect(() => validateResumeFile({ name: 'empty.pdf', size: 0 })).toThrow(/空/);
    expect(() => validateResumeFile({ name: 'large.pdf', size: 6 * 1024 * 1024 })).toThrow(/5 MB/);
  });
  it('rejects binary text files', async () => {
    await expect(readResumeFile(new File([new Uint8Array([0, 1, 2, 3, 0, 0])], 'binary.txt'))).rejects.toThrow(/文字|文本/);
  });
  it('honours cancellation without returning a partial CV', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(readResumeFile(fixture('sample.docx'), { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects overly long text instead of silently truncating it', async () => {
    await expect(readResumeFile(new File(['工作经历'.repeat(16000)], 'long.txt'))).rejects.toThrow(/过长/);
  });
  it('never uses a section heading as a person name', () => {
    expect(suggestCandidateName('个人简历\n工作经历\n高级后端工程师', '个人简历.pdf')).toBe('');
  });
});
