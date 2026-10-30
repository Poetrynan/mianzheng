import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { messageOf } from './session';

export type Speaker = 'candidate' | 'interviewer';

export interface RecorderApi {
  status: 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping';
  elapsedMs: number;
  pending: number;
  failed: number;
  saved: number;
  lastError: string | null;
  speaker: Speaker;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  setSpeaker: (speaker: Speaker) => void;
  retryFailed: () => void;
}

interface Chunk {
  blob: Blob;
  offsetMs: number;
  speaker: Speaker;
}

/** 12s keeps each upload small enough for a slow interview-room uplink. */
const CHUNK_MS = 12_000;

function preferredMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('录音读取失败'));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('录音读取失败'));
    reader.readAsDataURL(blob);
  });
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '浏览器没有拿到麦克风权限。允许后重试，或改用文字记录。';
  if (name === 'NotFoundError') return '没有找到可用的麦克风，请检查设备后重试。';
  return '麦克风没能打开，请检查浏览器权限后重试。';
}

/**
 * Records in short chunks, uploads them in order, and asks the server to transcribe each one.
 * The speaker is captured per chunk, so flipping the toggle never relabels earlier audio.
 */
export function useInterviewRecorder(opts: {
  interviewId: string;
  interviewStartedAt: string | null;
  onSaved: () => void;
}): RecorderApi {
  const interviewIdRef = useRef(opts.interviewId);
  const startedAtRef = useRef(opts.interviewStartedAt);
  const onSavedRef = useRef(opts.onSaved);
  interviewIdRef.current = opts.interviewId;
  startedAtRef.current = opts.interviewStartedAt;
  onSavedRef.current = opts.onSaved;

  const [status, setStatus] = useState<RecorderApi['status']>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [saved, setSaved] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [speaker, setSpeakerState] = useState<Speaker>('candidate');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakerRef = useRef<Speaker>('candidate');
  const mountedRef = useRef(true);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const failedChunksRef = useRef<Chunk[]>([]);
  const stopResolveRef = useRef<(() => void) | null>(null);

  const offsetBaseRef = useRef(0);
  const chunkStartRef = useRef(0);
  const uiAccumRef = useRef(0);
  const uiResumedAtRef = useRef(0);

  const uiElapsed = useCallback((): number => {
    const rec = recorderRef.current;
    return uiAccumRef.current + (rec && rec.state === 'recording' ? Date.now() - uiResumedAtRef.current : 0);
  }, []);

  const upload = useCallback(async (chunk: Chunk): Promise<void> => {
    const mime = chunk.blob.type || 'audio/webm';
    const base64 = await blobToBase64(chunk.blob);
    const res = await api.uploadAudio(interviewIdRef.current, {
      base64,
      mime,
      filename: `chunk-${chunk.offsetMs}.${mime.includes('mp4') ? 'm4a' : 'webm'}`,
      speaker: chunk.speaker,
      offsetMs: chunk.offsetMs,
    });
    if (!mountedRef.current) return;
    setSaved(res.saved.length);
    onSavedRef.current();
  }, []);

  const enqueue = useCallback(
    (chunk: Chunk) => {
      setPending((n) => n + 1);
      setLastError(null);
      queueRef.current = queueRef.current.then(async () => {
        let detail: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await upload(chunk);
            if (mountedRef.current) setPending((n) => Math.max(0, n - 1));
            return;
          } catch (err) {
            detail = err;
          }
        }
        failedChunksRef.current.push(chunk);
        if (mountedRef.current) {
          setPending((n) => Math.max(0, n - 1));
          setFailed((n) => n + 1);
          setLastError(`有一段录音没能保存：${messageOf(detail)}。录音还在本页，可以重试。`);
        }
      });
    },
    [upload],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        recorderRef.current?.stop();
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = window.setInterval(() => setElapsedMs(uiElapsed()), 1000);
    return () => window.clearInterval(timer);
  }, [status, uiElapsed]);

  const start = useCallback(async (): Promise<void> => {
    if (status !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setLastError('这个浏览器不支持录音，请换用最新版 Chrome 或 Edge，或改用文字记录。');
      return;
    }
    setStatus('requesting');
    setLastError(null);
    setFailed(0);
    failedChunksRef.current = [];
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = preferredMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const now = Date.now();
      const startedAt = Date.parse(startedAtRef.current ?? '');
      offsetBaseRef.current = Number.isNaN(startedAt) ? now : startedAt;
      chunkStartRef.current = now;
      uiAccumRef.current = 0;
      uiResumedAtRef.current = now;
      speakerRef.current = speaker;
      setElapsedMs(0);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data.size) return;
        const chunk: Chunk = {
          blob: event.data,
          offsetMs: Math.max(0, chunkStartRef.current - offsetBaseRef.current),
          speaker: speakerRef.current,
        };
        chunkStartRef.current = Date.now();
        if (mountedRef.current) enqueue(chunk);
      };
      recorder.onerror = () => {
        if (mountedRef.current) setLastError('录音中断了。已经录好的部分会保留，请重新开始。');
      };
      recorder.onstop = () => {
        uiAccumRef.current = uiElapsed();
        if (mountedRef.current) {
          setElapsedMs(uiAccumRef.current);
          setStatus('idle');
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        stopResolveRef.current?.();
        stopResolveRef.current = null;
      };

      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start(CHUNK_MS);
      setStatus('recording');
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setStatus('idle');
      setLastError(micError(err));
    }
  }, [enqueue, speaker, status]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'recording') return;
    uiAccumRef.current = uiElapsed();
    rec.pause();
    setElapsedMs(uiAccumRef.current);
    setStatus('paused');
  }, [uiElapsed]);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'paused') return;
    rec.resume();
    uiResumedAtRef.current = Date.now();
    chunkStartRef.current = Date.now();
    setStatus('recording');
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      setStatus('idle');
      return;
    }
    setStatus('stopping');
    if (rec.state === 'recording') {
      uiAccumRef.current = uiElapsed();
      setElapsedMs(uiAccumRef.current);
    }
    await new Promise<void>((resolve) => {
      stopResolveRef.current = resolve;
      rec.stop();
    });
    await queueRef.current;
  }, []);

  const setSpeaker = useCallback((next: Speaker) => {
    speakerRef.current = next;
    setSpeakerState(next);
    const rec = recorderRef.current;
    if (rec?.state === 'recording') rec.requestData();
  }, []);

  const retryFailed = useCallback(() => {
    const chunks = failedChunksRef.current;
    if (chunks.length === 0) return;
    failedChunksRef.current = [];
    setFailed(0);
    setLastError(null);
    for (const chunk of chunks) enqueue(chunk);
  }, [enqueue]);

  return { status, elapsedMs, pending, failed, saved, lastError, speaker, start, stop, pause, resume, setSpeaker, retryFailed };
}
