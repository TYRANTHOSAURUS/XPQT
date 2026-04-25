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
    rollupOptions: {
      output: {
        // Split large, stable vendor groups into their own chunks so repeat
        // visitors cache them across deploys — when only app code changes,
        // these hashes don't. Order matters: more-specific matches win, so
        // react-query / dnd-kit / reactflow are matched before the generic
        // react bucket.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('reactflow') || id.includes('dagre')) return 'vendor-flow';
          if (id.includes('@dnd-kit')) return 'vendor-dnd';
          if (
            id.includes('@base-ui') ||
            id.includes('lucide-react') ||
            id.includes('sonner') ||
            id.includes('cmdk')
          ) return 'vendor-ui';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (
            id.includes('react-router') ||
            id.includes('react-dom') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) return 'vendor-react';
          return 'vendor';
        },
      },
    },
    // App bundle now sits below this with vendors split out; the original
    // 500 warning was meaningless noise post-split.
    chunkSizeWarningLimit: 800,
  },
});
