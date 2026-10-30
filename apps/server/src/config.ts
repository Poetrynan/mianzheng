import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RetentionPolicy } from '@mianyan/core';

export interface LlmServiceConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface SherpaAsrServiceConfig {
  provider: 'local-sherpa';
  binPath: string;
  modelPath: string;
  tokensPath: string;
  ffmpegPath: string;
  language: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  numThreads: number;
}

export interface RemoteAsrServiceConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AsrServiceConfig = SherpaAsrServiceConfig | RemoteAsrServiceConfig;

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  audioDir: string;
  retention: RetentionPolicy;
  /** Null only when configuration is incomplete; `configErrors` then explains what to fix. */
  llm: LlmServiceConfig | null;
  asr: AsrServiceConfig | null;
  configErrors: string[];
  /** Set only by tests that need to advance the clock; never in normal operation. */
  fixedClockStart: string | null;
  /** Turn on when the site is served over HTTPS so the session cookie carries Secure. */
  cookieSecure: boolean;
  /** 演示模式：语言模型与转写都用本地模拟，不联网、不需要密钥。 */
  demoMode: boolean;
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function text(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Loads `.env` when present, then reads only MIANYAN_* variables. Keys never get committed. */
export function loadConfig(startDir: string = process.cwd()): ServerConfig {
  const dotEnv = resolve(startDir, '.env');
  if (existsSync(dotEnv) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(dotEnv);
    } catch {
      /* an unreadable .env must not stop the server from booting with real env vars */
    }
  }

  const e = process.env;
  const configErrors: string[] = [];
  const demoMode = e.MIANYAN_DEMO_MODE === '1';

  const llmBaseUrl = text(e.MIANYAN_LLM_BASE_URL) || 'https://api.longcat.chat/openai/v1';
  const llmApiKey = text(e.MIANYAN_LLM_API_KEY);
  const llmModel = text(e.MIANYAN_LLM_MODEL) || 'LongCat-2.5-Preview';
  let llm: LlmServiceConfig | null = null;
  if (llmApiKey.length === 0 && !demoMode) {
    configErrors.push('语言模型未配置：请在 .env 填写 MIANYAN_LLM_API_KEY');
  } else if (llmApiKey.length > 0) {
    llm = { baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel, timeoutMs: envInt(e.MIANYAN_LLM_TIMEOUT_MS, 120_000) };
  }

  const asrProvider = text(e.MIANYAN_ASR_PROVIDER);
  const sherpaBin = text(e.MIANYAN_ASR_SHERPA_BIN);
  const sherpaModel = text(e.MIANYAN_ASR_SHERPA_MODEL);
  const sherpaTokens = text(e.MIANYAN_ASR_SHERPA_TOKENS);
  const remoteBase = text(e.MIANYAN_ASR_BASE_URL);
  const remoteModel = text(e.MIANYAN_ASR_MODEL);
  const remoteKey = text(e.MIANYAN_ASR_API_KEY);
  const languageRaw = text(e.MIANYAN_ASR_LANGUAGE) || 'auto';
  const language = (['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(languageRaw) ? languageRaw : 'auto') as SherpaAsrServiceConfig['language'];

  let asr: AsrServiceConfig | null = null;
  const useLocal = asrProvider === 'local-sherpa' || (asrProvider === '' && sherpaBin.length > 0);
  if (useLocal) {
    const missing: string[] = [];
    if (!sherpaBin) missing.push('MIANYAN_ASR_SHERPA_BIN');
    if (!sherpaModel) missing.push('MIANYAN_ASR_SHERPA_MODEL');
    if (!sherpaTokens) missing.push('MIANYAN_ASR_SHERPA_TOKENS');
    if (missing.length > 0) {
      if (!demoMode) configErrors.push(`语音识别未配置：请在 .env 填写 ${missing.join('、')}`);
    } else if (!existsSync(sherpaBin) || !existsSync(sherpaModel) || !existsSync(sherpaTokens)) {
      if (!demoMode) configErrors.push('语音识别文件不存在：请检查 .env 中 sherpa-onnx 可执行文件与模型路径');
    } else {
      asr = {
        provider: 'local-sherpa',
        binPath: sherpaBin,
        modelPath: sherpaModel,
        tokensPath: sherpaTokens,
        ffmpegPath: text(e.MIANYAN_FFMPEG_PATH) || 'ffmpeg',
        language,
        numThreads: envInt(e.MIANYAN_ASR_THREADS, 4),
      };
    }
  } else if (remoteBase && remoteModel) {
    asr = { provider: 'openai-compatible', baseUrl: remoteBase, apiKey: remoteKey, model: remoteModel };
  } else if (!demoMode) {
    configErrors.push('语音识别未配置：请设置本地 sherpa-onnx 路径，或提供 MIANYAN_ASR_BASE_URL/MODEL');
  }

  const fixedClockStart =
    e.MIANYAN_FIXED_CLOCK_START && !Number.isNaN(Date.parse(e.MIANYAN_FIXED_CLOCK_START))
      ? new Date(e.MIANYAN_FIXED_CLOCK_START).toISOString()
      : null;

  return {
    host: e.MIANYAN_HOST ?? '127.0.0.1',
    port: envInt(e.MIANYAN_PORT, envInt(e.PORT, 8787)),
    dbPath: resolve(startDir, e.MIANYAN_DB_PATH ?? 'data/mianyan.db'),
    audioDir: resolve(startDir, e.MIANYAN_AUDIO_DIR ?? 'data/audio'),
    retention: {
      audioDays: envInt(e.MIANYAN_AUDIO_RETENTION_DAYS, 180),
      consentDays: envInt(e.MIANYAN_CONSENT_RETENTION_DAYS, 730),
    },
    llm: demoMode ? null : llm,
    asr: demoMode ? null : asr,
    configErrors,
    fixedClockStart,
    cookieSecure: e.MIANYAN_COOKIE_SECURE === '1',
    demoMode,
  };
}
