import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: { outDir: '../dist-web', emptyOutDir: true },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:8787', '/healthz': 'http://localhost:8787' },
  },
});
