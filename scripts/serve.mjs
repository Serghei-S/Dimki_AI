import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { createAssistantMiddleware } from './assistant-api.mjs';
import { resolveAssistantProvider } from './assistant-provider.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function createAppServer({
  env = process.env,
  root = resolve(projectRoot, 'web-dist'),
  assistantOptions = {},
} = {}) {
  const middleware = createAssistantMiddleware({
    publicOrigin: env.PUBLIC_ORIGIN || undefined,
    getProvider: () => resolveAssistantProvider(env),
    getKey: () => env[resolveAssistantProvider(env).keyVariable] || '',
    ...assistantOptions,
  });
  const staticFiles = sirv(root, { etag: true, dotfiles: false, single: false });
  const server = createServer((req, res) => {
    const fail = (status, text) => {
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(text);
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url?.startsWith('/api/')) {
      void middleware(req, res, () => fail(404, 'API endpoint not found')).catch(() =>
        fail(500, 'API error'),
      );
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Method not allowed');
    res.setHeader('Cache-Control', 'no-cache');
    staticFiles(req, res, () => fail(404, 'File not found'));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 20000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535');
  for (const path of ['web-dist/index.html', 'dist/engine.js', 'dist/report.js']) {
    if (!existsSync(resolve(projectRoot, path))) throw new Error(`Missing ${path}. Run pnpm build first.`);
  }
  const host = process.env.HOST || (process.env.PUBLIC_ORIGIN ? '0.0.0.0' : '127.0.0.1');
  const server = createAppServer();
  server.on('error', (error) => {
    console.error(`Server failed: ${error.code || error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () =>
    console.log(
      `Dimki AI: ${process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`} (listening on ${host}:${port})`,
    ),
  );
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 100000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
