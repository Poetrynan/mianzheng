import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AsrSegment {
  speaker: 'candidate' | 'interviewer' | 'unknown';
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}

export interface AsrRequest {
  /** Opaque handle to stored audio; the provider never receives a public URL. */
  audioId?: string;
  mime?: string;
  durationMs?: number;
  language?: 'zh' | 'en';
  /** Milliseconds from the start of the interview; chunked uploads add this back. */
  offsetMs?: number;
  speaker?: AsrSegment['speaker'];
  /** Fallback when there is no audio: caller supplies the raw text of the session. */
  inlineTranscript?: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  transcribe(req: AsrRequest): Promise<AsrSegment[]>;
}

export class AsrProviderError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AsrProviderError';
  }
}

function msFromClock(clock: string): number | null {
  const parts = clock.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => Number.isNaN(p))) return null;
  const [a = 0, b = 0, c = 0] = parts;
  if (parts.length === 2) return a * 60_000 + b * 1000;
  if (parts.length === 3) return a * 3_600_000 + b * 60_000 + c * 1000;
  return null;
}

function speakerOf(label: string): AsrSegment['speaker'] {
  const l = label.toLowerCase();
  if (/候选|候选人|candidate|求职者/.test(l)) return 'candidate';
  if (/面试官|用人经理|interviewer|hiring|hr/.test(l)) return 'interviewer';
  return 'unknown';
}

const LINE_RE = /^\s*(?:\[([0-9:]+)\]|\((\d+)ms\)|(\d+)\s*分钟)?\s*(?:【([^】]+)】|([A-Za-z\u4e00-\u9fa5]{2,6}[:：]))?\s*(.+)$/;

/**
 * Handed over text transcripts ("[00:03:12] 候选人：……") still work as a secondary path.
 * Missing timestamps are reconstructed at a fixed cadence so evidence keeps a monotonic clock.
 */
export function parseInlineTranscript(text: string): AsrSegment[] {
  const out: AsrSegment[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let cursorMs = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const clock = m[1] ?? m[2] ?? null;
    const minute = m[3] ? Number(m[3]) : null;
    const label = m[4] ?? m[5] ?? null;
    const body = (m[6] ?? '').trim();
    if (body.length === 0) continue;
    let startMs = cursorMs;
    if (clock && clock.includes(':')) {
      const parsed = msFromClock(clock);
      if (parsed !== null) startMs = parsed;
    } else if (clock) {
      startMs = Number(clock);
    } else if (minute !== null) {
      startMs = minute * 60_000;
    }
    cursorMs = startMs + Math.max(4_000, Math.min(45_000, body.length * 260));
    out.push({
      speaker: label ? speakerOf(label) : out.length % 2 === 0 ? 'interviewer' : 'candidate',
      speakerLabel: label,
      startMs,
      endMs: cursorMs,
      text: body,
      confidence: 1,
    });
  }
  return out;
}

export type TranscriptSource = 'dingtalk' | 'feishu' | 'tencent' | 'other';

export interface DetectedSpeaker {
  label: string;
  guess: AsrSegment['speaker'];
  segments: number;
  chars: number;
  sample: string;
}

const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
/** 「张三 00:01:23」「发言人1（01:23）」：会议软件导出稿里独占一行的说话人抬头。 */
const LABEL = String.raw`[^\s\d\[\]【】:：()（）][^\s\[\]【】:：()（）]{0,19}?(?:\s?\d{1,2})?`;
const HEADER_RE = new RegExp(String.raw`^\s*(${LABEL})\s*[(（]?\s*(${CLOCK})\s*[)）]?\s*$`);
/** 「张三(00:01:23)：……」「发言人1 01:23：……」：说话人、时间和正文写在同一行。 */
const INLINE_HEADER_RE = new RegExp(String.raw`^\s*(${LABEL})\s*[(（]?\s*(${CLOCK})\s*[)）]?\s*[:：]\s*(.+)$`);

function fixedEnd(startMs: number, text: string): number {
  return startMs + Math.max(4_000, Math.min(45_000, text.length * 260));
}

/**
 * Text exported from DingTalk AI 听记, Feishu 妙记 or Tencent Meeting. Those exports name real
 * people ("张三", "发言人2"), so the speaker stays `unknown` unless the label itself says who it is;
 * the caller maps labels to candidate / interviewer before anything is stored.
 */
export function parseMeetingExport(text: string): AsrSegment[] {
  const lines = text.split(/\r?\n/);
  const headers = lines.filter((l) => HEADER_RE.test(l)).length;
  const inlineHeaders = lines.filter((l) => INLINE_HEADER_RE.test(l)).length;

  if (headers >= 2 && headers >= inlineHeaders) {
    const out: AsrSegment[] = [];
    let current: { label: string; startMs: number; body: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const body = current.body.join('').trim();
      if (body.length > 0) {
        out.push({
          speaker: speakerOf(current.label),
          speakerLabel: current.label,
          startMs: current.startMs,
          endMs: fixedEnd(current.startMs, body),
          text: body,
          confidence: 1,
        });
      }
      current = null;
    };
    for (const line of lines) {
      const m = line.match(HEADER_RE);
      if (m) {
        flush();
        current = { label: (m[1] ?? '').trim(), startMs: msFromClock(m[2] ?? '') ?? 0, body: [] };
      } else if (current && line.trim().length > 0) {
        current.body.push(line.trim());
      }
    }
    flush();
    return closeGaps(out);
  }

  if (inlineHeaders >= 2) {
    const out: AsrSegment[] = [];
    for (const line of lines) {
      const m = line.match(INLINE_HEADER_RE);
      if (!m) continue;
      const label = (m[1] ?? '').trim();
      const startMs = msFromClock(m[2] ?? '') ?? 0;
      const body = (m[3] ?? '').trim();
      if (body.length === 0) continue;
      out.push({ speaker: speakerOf(label), speakerLabel: label, startMs, endMs: fixedEnd(startMs, body), text: body, confidence: 1 });
    }
    return closeGaps(out);
  }

  return parseInlineTranscript(text);
}

/** An utterance ends where the next one starts, so evidence clocks never overlap. */
function closeGaps(segments: AsrSegment[]): AsrSegment[] {
  return segments.map((s, i) => {
    const next = segments[i + 1];
    return next && next.startMs > s.startMs ? { ...s, endMs: Math.min(s.endMs, next.startMs) } : s;
  });
}

export function detectSpeakers(segments: AsrSegment[]): DetectedSpeaker[] {
  const byLabel = new Map<string, DetectedSpeaker>();
  for (const s of segments) {
    const label = s.speakerLabel ?? (s.speaker === 'candidate' ? '候选人' : s.speaker === 'interviewer' ? '面试官' : '发言人');
    const hit = byLabel.get(label);
    if (hit) {
      hit.segments += 1;
      hit.chars += s.text.length;
    } else {
      byLabel.set(label, { label, guess: s.speaker, segments: 1, chars: s.text.length, sample: s.text.slice(0, 60) });
    }
  }
  const list = [...byLabel.values()];
  /** The candidate usually talks the most; only guess when the split is unambiguous. */
  const unknown = list.filter((d) => d.guess === 'unknown');
  const hasInterviewer = list.some((d) => d.guess === 'interviewer');
  if (!list.some((d) => d.guess === 'candidate')) {
    if (unknown.length === 2 && !hasInterviewer) {
      const [a, b] = unknown as [DetectedSpeaker, DetectedSpeaker];
      const talker = a.chars >= b.chars ? a : b;
      talker.guess = 'candidate';
      (talker === a ? b : a).guess = 'interviewer';
    } else if (unknown.length === 1 && hasInterviewer) {
      unknown[0]!.guess = 'candidate';
    }
  }
  return list.sort((x, y) => y.chars - x.chars);
}

export function applySpeakerMap(segments: AsrSegment[], map: Record<string, AsrSegment['speaker']>): AsrSegment[] {
  return segments.map((s) => {
    const label = s.speakerLabel ?? '';
    const mapped = map[label];
    return mapped ? { ...s, speaker: mapped } : s;
  });
}

/** Deterministic fixture for unit tests; never selected by the product runtime. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'mock';
  constructor(private readonly sample?: string) {}

  async transcribe(req: AsrRequest): Promise<AsrSegment[]> {
    const source = req.inlineTranscript ?? this.sample;
    if (!source) {
      throw new Error('MockTranscriptionProvider 需要 inlineTranscript 或构造时提供样本');
    }
    return parseInlineTranscript(source);
  }
}

export interface AsrCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Pulls stored bytes; injected so the provider stays independent of the storage layer. */
  loadAudio: (audioId: string) => Promise<{ bytes: ArrayBuffer; mime: string; filename: string }>;
}

interface RawSegment {
  start?: number;
  end?: number;
  text?: string;
  speaker?: string | number;
}

/** OpenAI-compatible /audio/transcriptions (whisper-style, verbose_json). */
export class OpenAiCompatTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai-compatible';
  constructor(private readonly opts: AsrCompatOptions) {}

  async transcribe(req: AsrRequest): Promise<AsrSegment[]> {
    if (!req.audioId) {
      if (req.inlineTranscript) return parseInlineTranscript(req.inlineTranscript);
      throw new AsrProviderError('ASR provider 需要 audioId');
    }
    const audio = await this.opts.loadAudio(req.audioId);
    const form = new FormData();
    form.append('file', new Blob([audio.bytes], { type: audio.mime }), audio.filename);
    form.append('model', this.opts.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const doFetch = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await doFetch(this.opts.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new AsrProviderError(`ASR 调用失败 (${res.status})`, await res.text().catch(() => ''));
    const json = (await res.json()) as { segments?: RawSegment[]; text?: string };
    const offset = req.offsetMs ?? 0;
    const speaker = req.speaker ?? 'unknown';
    const segments = json.segments ?? [];
    return segments.map((s, i) => {
      const label = typeof s.speaker === 'string' || typeof s.speaker === 'number' ? String(s.speaker) : null;
      return {
        speaker: label ? speakerOf(label) : speaker,
        speakerLabel: label,
        startMs: offset + Math.round((s.start ?? i) * 1000),
        endMs: offset + Math.round((s.end ?? i + 1) * 1000),
        text: (s.text ?? '').trim(),
        confidence: 0.85,
      } satisfies AsrSegment;
    });
  }
}

export interface SherpaOnnxOptions {
  binPath: string;
  modelPath: string;
  tokensPath: string;
  ffmpegPath?: string;
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  numThreads?: number;
  timeoutMs?: number;
  loadAudio: (audioId: string) => Promise<{ bytes: ArrayBuffer; mime: string; filename: string }>;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

interface SenseVoiceJson {
  text?: string;
  tokens?: string[];
  timestamps?: number[];
  durations?: number[];
}

/**
 * Groups character-level SenseVoice output into readable utterances. A pause of 650ms,
 * 42 characters, or 18 seconds closes the current segment.
 */
export function senseVoiceSegments(json: SenseVoiceJson, offsetMs: number, speaker: AsrSegment['speaker'], speakerLabel: string | null): AsrSegment[] {
  const tokens = json.tokens ?? [];
  const times = json.timestamps ?? [];
  const durations = json.durations ?? [];
  const out: AsrSegment[] = [];
  let text = '';
  let startSec: number | null = null;
  let endSec = 0;
  let previousEnd = 0;

  const flush = (): void => {
    if (startSec === null || text.trim().length === 0) {
      text = '';
      startSec = null;
      endSec = 0;
      return;
    }
    out.push({
      speaker,
      speakerLabel,
      startMs: offsetMs + Math.round(startSec * 1000),
      endMs: offsetMs + Math.round(Math.max(endSec, startSec + 0.2) * 1000),
      text: text.trim(),
      confidence: 0.9,
    });
    text = '';
    startSec = null;
    endSec = 0;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const start = times[i] ?? previousEnd;
    const end = durations[i] ? start + durations[i]! : (times[i + 1] ?? start + 0.24);
    const gap = startSec === null ? 0 : start - previousEnd;
    if (startSec !== null && (gap >= 0.65 || text.length >= 42 || start - startSec >= 18)) flush();
    if (startSec === null) startSec = start;
    text += token;
    endSec = end;
    previousEnd = end;
  }
  flush();

  if (out.length === 0 && (json.text ?? '').trim().length > 0) {
    const raw = json.text!.trim();
    out.push({
      speaker,
      speakerLabel,
      startMs: offsetMs,
      endMs: offsetMs + Math.max(2000, raw.length * 220),
      text: raw,
      confidence: 0.9,
    });
  }
  return out;
}

function extensionFor(mime: string, filename: string): string {
  const fromName = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  if (['webm', 'ogg', 'wav', 'mp4', 'm4a', 'mp3', 'flac', 'bin'].includes(fromName)) return fromName;
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  return 'bin';
}

/**
 * Local, on-device transcription: ffmpeg normalises the recording, then the bundled
 * sherpa-onnx binary runs the SenseVoice int8 model. No audio or text leaves the machine.
 */
export class SherpaOnnxTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'local-sensevoice';

  constructor(private readonly opts: SherpaOnnxOptions) {}

  async transcribe(req: AsrRequest): Promise<AsrSegment[]> {
    if (!req.audioId) {
      if (req.inlineTranscript) return parseInlineTranscript(req.inlineTranscript);
      throw new AsrProviderError('本地语音识别需要音频或文字转写');
    }
    const audio = await this.opts.loadAudio(req.audioId);
    const workDir = mkdtempSync(join(tmpdir(), 'mianyan-asr-'));
    const inputPath = join(workDir, `input.${extensionFor(audio.mime, audio.filename)}`);
    const wavPath = join(workDir, 'audio.wav');
    try {
      writeFileSync(inputPath, Buffer.from(audio.bytes));
      const ffmpeg = await runCommand(
        this.opts.ffmpegPath ?? 'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
        Math.max(30_000, this.opts.timeoutMs ?? 180_000),
      );
      if (ffmpeg.code !== 0) {
        throw new AsrProviderError(
          '音频转码失败，请确认本机 ffmpeg 可用',
          (ffmpeg.stderr || ffmpeg.stdout).slice(-800),
        );
      }

      const args = [
        `--tokens=${this.opts.tokensPath}`,
        `--sense-voice-model=${this.opts.modelPath}`,
        `--sense-voice-language=${req.language ?? this.opts.language ?? 'auto'}`,
        '--sense-voice-use-itn=true',
        `--num-threads=${this.opts.numThreads ?? 4}`,
        wavPath,
      ];
      const result = await runCommand(this.opts.binPath, args, this.opts.timeoutMs ?? 180_000);
      if (result.timedOut) throw new AsrProviderError('语音识别超时，请缩短音频片段后重试');
      if (result.code !== 0) {
        throw new AsrProviderError('语音识别失败', (result.stderr || result.stdout).slice(-800));
      }

      const json = parseSenseVoiceOutput(result.stdout);
      if (!json) throw new AsrProviderError('语音识别没有返回可读文本', result.stdout.slice(-800));
      const speaker = req.speaker ?? 'unknown';
      const label = speaker === 'candidate' ? '候选人' : speaker === 'interviewer' ? '面试官' : null;
      return senseVoiceSegments(json, req.offsetMs ?? 0, speaker, label);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function parseSenseVoiceOutput(stdout: string): SenseVoiceJson | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as SenseVoiceJson;
      if (typeof parsed.text === 'string') return parsed;
    } catch {
      /* sherpa prints diagnostics on stderr; a non-JSON stdout line is not fatal */
    }
  }
  return null;
}
