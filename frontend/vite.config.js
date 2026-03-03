import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => {
  const isAnalyze = mode === 'analyze';
  return {
    plugins: [
      sveltekit(),
      ...(isAnalyze ? [visualizer({ filename: 'build/bundle-analysis.html', gzipSize: true, brotliSize: true })] : [])
    ],
    build: {
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/src/routes/admin') || id.includes('/src/routes/app/admin')) {
              return 'admin';
            }
            if (id.includes('maplibre-gl')) {
              return 'maplibre';
            }
            if (id.includes('pmtiles')) {
              return 'pmtiles';
            }
            if (id.includes('marked')) {
              return 'markdown';
            }
            if (id.includes('node_modules')) {
              return 'vendor';
            }
            return undefined;
          }
        }
      }
    }
  };
});
