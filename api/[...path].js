/**
 * Vercel 只做转发：把 /api/* 原样送到后端（Render）的根路径。
 * 不在这里放数据库、会话或业务逻辑——Vercel 的函数是无状态的，数据必须留在后端。
 */
const ORIGIN = (process.env.API_ORIGIN ?? '').replace(/\/+$/, '');

export default async function handler(req, res) {
  if (!ORIGIN) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 'proxy_unconfigured', message: 'API_ORIGIN 未设置' }));
    return;
  }

  const path = (req.url ?? '/').replace(/^\/api/, '') || '/';

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  let upstream;
  try {
    upstream = await fetch(ORIGIN + path, { method: req.method, headers, body, redirect: 'manual' });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 'proxy_unreachable', message: String(err?.message ?? err) }));
    return;
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (key === 'set-cookie' || key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('content-length', String(buffer.length));
  res.end(buffer);
}
