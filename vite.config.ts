import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: 'web-dist',
    target: 'es2022',
    sourcemap: true,
    emptyOutDir: true,
    chunkSizeWarningLimit: 950,
  },
  worker: { format: 'es' },
});
