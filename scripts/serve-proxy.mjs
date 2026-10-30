import http from 'node:http';
import { fileURLToPath } from 'node:url';

const origin = process.env.API_ORIGIN;
if (!origin) {
  console.error('请先设置 API_ORIGIN，例如：set API_ORIGIN=http://127.0.0.1:8787');
  process.exit(1);
}
process.env.API_ORIGIN = origin;

const handlerUrl = new URL('../api/[...path].js', import.meta.url);
const mod = await import(handlerUrl.href);

const port = Number(process.env.PROXY_PORT ?? 8891);
const server = http.createServer((req, res) => void mod.default(req, res));
server.listen(port, '127.0.0.1', () => {
  console.log(`本地转发已启动：http://127.0.0.1:${port} → ${origin}`);
});
