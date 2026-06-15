import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const SERVER_PORT = process.env.BRAIN_SERVER_PORT ?? '8911';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2'],
      manifest: {
        name: 'Oxford Command Center',
        short_name: 'ORA Brain',
        description: 'Oxford Real Assets — internal command center',
        theme_color: '#0d1b2a',
        background_color: '#05070d',
        display: 'standalone',
        icons: [],
      },
      workbox: {
        // The live API is never cached — only the app shell.
        navigateFallbackDenylist: [/^\/api/, /^\/sse/],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@contracts': fileURLToPath(new URL('./src/contracts', import.meta.url)),
      '@analytics': fileURLToPath(new URL('./src/analytics', import.meta.url)),
    },
  },
  build: {
    // Split heavy vendors out of the main entry chunk so it stays well under the 250 kB
    // gzip budget and vendor code caches independently across deploys (Phase 6).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-router') || id.includes('@remix-run')) return 'vendor-router';
          if (/[\\/]react[\\/]|[\\/]react-dom[\\/]|[\\/]scheduler[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@visx') || id.includes('d3-')) return 'vendor-visx';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'vendor-motion';
          if (id.includes('react-aria') || id.includes('react-stately')) return 'vendor-aria';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      '/sse': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true, ws: false },
    },
  },
});
