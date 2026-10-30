import { mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '@mianyan/core';
import type { AudioBlobMeta } from '@mianyan/core';

interface Sidecar {
  mime: string;
  interviewId: string;
  createdAtMs: number;
  filename: string;
}

/**
 * Audio bytes never enter the database: the record kept there is metadata only, so the
 * retention sweep can prove the six-month lifetime promise without a blob column. Files
 * live on the local disk of the deploying company (PRD 6.4, data does not leave the country).
 */
export class FileAudioStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private safeId(id: string): string {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) throw new DomainError('bad_audio_id', '这段音频的编号无法识别');
    return id;
  }

  private binPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }
  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  put(interviewId: string, audioId: string, base64: string, mime: string, filename: string | undefined, createdAtMs: number): AudioBlobMeta {
    const id = this.safeId(audioId);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new DomainError('empty_audio', '音频内容为空');
    const sidecar: Sidecar = {
      mime,
      interviewId,
      createdAtMs,
      filename: filename ?? `${id}.${mime.includes('webm') ? 'webm' : 'bin'}`,
    };
    writeFileSync(this.binPath(id), bytes);
    writeFileSync(this.metaPath(id), JSON.stringify(sidecar));
    return { id, interviewId, createdAtMs, mime, bytes: bytes.length };
  }

  meta(audioId: string): Sidecar | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(this.safeId(audioId)), 'utf8')) as Sidecar;
    } catch {
      return null;
    }
  }

  /** Adapter handed to the ASR provider so it can pull bytes without knowing about storage. */
  load = async (audioId: string): Promise<{ bytes: ArrayBuffer; mime: string; filename: string }> => {
    const sidecar = this.meta(audioId);
    if (!sidecar) throw new DomainError('audio_not_found', '这段录音已经找不到了（可能按留存期到点清理）');
    const buf = readFileSync(this.binPath(this.safeId(audioId)));
    const bytes = new ArrayBuffer(buf.length);
    new Uint8Array(bytes).set(buf);
    return { bytes, mime: sidecar.mime, filename: sidecar.filename };
  };

  list(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /** Deleting the file is the point of the sweep; metadata alone would be a hollow compliance claim. */
  purgeOlderThan(cutoffMs: number): number {
    let removed = 0;
    for (const id of this.list()) {
      const sidecar = this.meta(id);
      const createdAt = sidecar?.createdAtMs ?? 0;
      if (createdAt === 0 || createdAt >= cutoffMs) continue;
      try {
        unlinkSync(this.binPath(id));
        unlinkSync(this.metaPath(id));
        removed += 1;
      } catch {
        /* a file another process already removed is the desired end state */
      }
    }
    return removed;
  }
}
