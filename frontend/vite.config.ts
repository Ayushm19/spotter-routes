import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  // MapLibre 6 loads its worker relative to its own module; dependency pre-bundling breaks that.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // MapLibre spawns module workers, so bundle our worker entry (src/lib/maplibreWorker.ts) as ES.
  worker: { format: 'es' },
  server: { port: 5173 },
});
