import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser only ever talks to /api on its own origin; Vite proxies to the Fastify server so
 * no CORS preflight is needed and the session cookie can stay SameSite=Lax.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    // landing.html is the marketing page; it shares no code with the app and must survive `vite build`.
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, 'index.html'),
        landing: path.resolve(__dirname, 'landing.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 可用 MIANYAN_API_TARGET 指到另一个后端（比如并行跑一套验证环境），默认还是本机 8787。
        target: process.env.MIANYAN_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
