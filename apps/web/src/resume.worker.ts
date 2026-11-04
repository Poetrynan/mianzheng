import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { readResumeFile } from './resumeFile';

self.onmessage = async (event: MessageEvent<{ name: string; bytes: ArrayBuffer }>) => {
  try {
    const { name, bytes } = event.data;
    const result = await readResumeFile({ name, size: bytes.byteLength, arrayBuffer: async () => bytes }, { workerSrc, assetBase: new URL('/pdfjs/', self.location.origin).href });
    self.postMessage({ type: 'resume:result', ok: true, result });
  } catch (error) {
    self.postMessage({ type: 'resume:result', ok: false, message: error instanceof Error && error.message ? error.message : '没能读取简历，请重试。' });
  }
};
