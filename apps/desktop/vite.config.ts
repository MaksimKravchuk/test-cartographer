/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.TC_ENGINE_PORT ?? 4317}`, changeOrigin: true } },
  },
  // Unit tests (pure GUI logic) and component tests (React views in jsdom).
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
