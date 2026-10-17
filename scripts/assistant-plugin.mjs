import { loadEnv } from 'vite';
import { createAssistantMiddleware } from './assistant-api.mjs';
import { resolveAssistantProvider } from './assistant-provider.mjs';
export function assistantPlugin() {
  let root = process.cwd(),
    mode = 'development';
  const environment = () => ({
    ...loadEnv(mode, root, ['AI_', 'RISKRADAR_', 'OPENROUTER_']),
    ...process.env,
  });
  const middleware = createAssistantMiddleware({
    getProvider: () => resolveAssistantProvider(environment()),
    getKey: () => {
      const env = environment();
      return env[resolveAssistantProvider(env).keyVariable] || '';
    },
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
