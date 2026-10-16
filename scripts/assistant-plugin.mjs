import { loadEnv } from 'vite';
import { createAssistantMiddleware } from './assistant-api.mjs';
export function assistantPlugin() {
  let root = process.cwd(),
    mode = 'development';
  const middleware = createAssistantMiddleware({
    getKey: () =>
      process.env.OPENROUTER_API_KEY || loadEnv(mode, root, 'OPENROUTER_').OPENROUTER_API_KEY || '',
  });
  return {
    name: 'dimki-assistant-api',
    configResolved(config) {
      root = config.root;
      mode = config.mode;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
