import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Consume the shared package's TS source directly. The API needs a
      // compiled dist/ because Node can't load .ts, but Vite understands TS
      // natively and pulling from source avoids the CJS/ESM interop issues
      // that surface when Vite tries to parse named exports off a
      // CommonJS-emitted dist/index.js.
      '@prequest/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
