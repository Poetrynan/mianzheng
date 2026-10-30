import {
  FixedClock,
  OpenAiCompatLlmProvider,
  OpenAiCompatTranscriptionProvider,
  SherpaOnnxTranscriptionProvider,
  type LlmProvider,
  type TranscriptionProvider,
} from '@mianyan/core';
import { MianYanApp } from '@mianyan/core/server';
import { loadConfig, type ServerConfig } from './config.js';
import { FileAudioStore } from './audioStore.js';

export interface BuiltServer {
  app: MianYanApp;
  audio: FileAudioStore;
  config: ServerConfig;
  providers: { llm: LlmProvider; asr: TranscriptionProvider };
  /** Present only under MIANYAN_FIXED_CLOCK_START; drives /dev/clock. */
  clock: FixedClock | null;
}

export interface ProviderOverrides {
  llm?: LlmProvider;
  asr?: TranscriptionProvider;
}

/**
 * One wiring point for the real services. Tests may inject deterministic providers, but
 * the product never silently replaces a missing service with a fake one.
 */
export async function buildServerApp(
  config: ServerConfig = loadConfig(),
  overrides: ProviderOverrides = {},
): Promise<BuiltServer> {
  if (!overrides.llm && !config.llm) {
    throw new Error(config.configErrors.join('\n') || '语言模型未配置');
  }
  if (!overrides.asr && !config.asr) {
    throw new Error(config.configErrors.join('\n') || '语音识别未配置');
  }

  const audio = new FileAudioStore(config.audioDir);
  const llmConfig = config.llm;
  const asrConfig = config.asr;
  const llm: LlmProvider =
    overrides.llm ??
    new OpenAiCompatLlmProvider(llmConfig!.model, {
      baseUrl: llmConfig!.baseUrl,
      apiKey: llmConfig!.apiKey,
      model: llmConfig!.model,
      timeoutMs: llmConfig!.timeoutMs,
    });

  let asr: TranscriptionProvider;
  if (overrides.asr) asr = overrides.asr;
  else if (asrConfig?.provider === 'local-sherpa') {
    asr = new SherpaOnnxTranscriptionProvider({
      binPath: asrConfig.binPath,
      modelPath: asrConfig.modelPath,
      tokensPath: asrConfig.tokensPath,
      ffmpegPath: asrConfig.ffmpegPath,
      language: asrConfig.language,
      numThreads: asrConfig.numThreads,
      loadAudio: audio.load,
    });
  } else if (asrConfig) {
    asr = new OpenAiCompatTranscriptionProvider({
      baseUrl: asrConfig.baseUrl,
      apiKey: asrConfig.apiKey,
      model: asrConfig.model,
      loadAudio: audio.load,
    });
  } else {
    throw new Error('语音识别未配置');
  }

  const clock = config.fixedClockStart ? new FixedClock(config.fixedClockStart) : null;

  const app = await MianYanApp.open({
    dbPath: config.dbPath,
    clock: clock ?? undefined,
    llm,
    asr,
    retention: config.retention,
  });
  return { app, audio, config, providers: { llm, asr }, clock };
}
