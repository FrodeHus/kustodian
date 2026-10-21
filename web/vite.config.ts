/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Assets resolve relative to index.html, so they load from the app origin (app:// or, on Windows, https://kustodian.invalid).
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
