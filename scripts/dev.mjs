await import('./build.mjs');
const { createServer } = await import('vite');
const server = await createServer();
await server.listen();
server.printUrls();
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, () => {
    void server.close().finally(() => process.exit(0));
  });
