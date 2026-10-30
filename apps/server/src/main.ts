import Fastify from 'fastify';
import { MockLlmProvider, MockTranscriptionProvider } from '@mianyan/core';
import { buildServerApp } from './build.js';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  /** 演示模式必须显式打开；正常启动永远不会在缺服务时偷偷换成模拟实现（见 build.ts 的注释）。 */
  const overrides = config.demoMode
    ? { llm: new MockLlmProvider(), asr: new MockTranscriptionProvider() }
    : {};
  const { app, audio, clock } = await buildServerApp(config, overrides);
  const server = Fastify({ logger: true });

  /**
   * The browser talks to /api on its own origin, so no CORS is registered. A deployment that
   * puts the web app on another host should terminate both behind one reverse proxy instead
   * of widening this API to every origin.
   */
  registerRoutes(server, app, audio, clock, { cookieSecure: config.cookieSecure });

  await server.listen({ host: config.host, port: config.port });
  server.log.info(`面证服务已启动：http://${config.host}:${config.port}`);
  server.log.info(`语言模型：${app.ctx.llm.model}（${app.ctx.llm.driver}）`);
  server.log.info(`语音识别：${config.demoMode ? '本地模拟（演示模式）' : app.ctx.asr.id === 'local-sensevoice' ? '本机 SenseVoice（音频不离开本机）' : '远端转写服务'}`);
  server.log.info(`数据库=${config.dbPath} 音频目录=${config.audioDir}`);
  if (config.demoMode) server.log.warn('演示模式：语言模型与转写都用本地模拟，不联网；不要用于真实候选人数据');
  for (const warning of config.configErrors) server.log.warn(warning);

  const shutdown = async (): Promise<void> => {
    await server.close();
    app.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('服务启动失败：\n' + message);
  process.exit(1);
});
