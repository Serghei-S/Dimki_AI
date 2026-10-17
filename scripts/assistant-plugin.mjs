import { loadEnv } from 'vite';
import tls from 'node:tls';
import { createAssistantMiddleware } from './assistant-api.mjs';
import { resolveAssistantProvider } from './assistant-provider.mjs';
export function assistantPlugin() {
  // Include Windows' trusted roots (for example a locally trusted HTTPS proxy).
  // Preserve Node's defaults and keep certificate/hostname verification enabled.
  if (process.platform === 'win32' && typeof tls.setDefaultCACertificates === 'function') {
    tls.setDefaultCACertificates([
      ...tls.getCACertificates('default'),
      ...tls.getCACertificates('system'),
    ]);
  }
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
