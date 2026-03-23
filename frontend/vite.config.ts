import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => {
  const isAnalyze = mode === 'analyze';
  return {
    server: {
      fs: {
        allow: ['..']
      }
    },
    plugins: [
      tailwindcss(),
      sveltekit(),
      ...(isAnalyze ? [visualizer({ filename: 'build/bundle-analysis.html', gzipSize: true, brotliSize: true })] : [])
    ],
    build: {
      // MapLibre ships as a large prebundled runtime chunk. It is already isolated behind lazy imports,
      // so keep the warning threshold above that known bundle size.
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('maplibre-gl')) {
              return 'maplibre';
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
