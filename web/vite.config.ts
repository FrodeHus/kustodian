/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Assets resolve relative to index.html, so they load from the app origin (app:// or, on Windows, https://kustodian.invalid).
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: 'hidden',
    // React and TanStack go in their own chunk, keeping each file under the 500 kB warning.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'vendor', test: /node_modules[\\/](react|react-dom|scheduler|@tanstack)[\\/]/ }],
        },
      },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], css: { include: [/\.css\?raw$/] } },
});
