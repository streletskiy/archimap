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
      // MapLibre ships as a large prebundled runtime chunk. It is already isolated behind lazy imports,
      // so the default Vite warning becomes noise rather than an actionable signal.
      chunkSizeWarningLimit: 950,
      rollupOptions: {
        output: {
          manualChunks(id) {
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
