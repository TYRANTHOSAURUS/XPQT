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
  build: {
    // Manual chunk splitting of React was producing a runtime TDZ:
    //   "Cannot set properties of undefined (setting 'Activity')"
    // because vendor chunks ended up importing back into React's own init
    // closure (`var je=xP(), Av={...}, xe={}` — xP() triggers a cross-chunk
    // chain that re-enters SP() before `xe={}` has run). Letting Vite/Rollup
    // pick chunk boundaries avoids the cycle. If we want vendor-cache wins
    // back, do it via dynamic imports / route-level splits, not manualChunks.
    chunkSizeWarningLimit: 1500,
  },
});
