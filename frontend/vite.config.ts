import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ command, mode }) => {
  const isAnalyze = mode === 'analyze';
  const logger = createLogger('info', { allowClearScreen: false });
  const shouldSuppressWarning = (message: string) =>
    message.includes('[PLUGIN_TIMINGS] Warning:') ||
    message.includes('Your build spent significant time in plugins.') ||
    message.startsWith('Circular dependency:');
  const shouldSuppressConsoleWarning = (...args: unknown[]) =>
    shouldSuppressWarning(args.map((arg) => String(arg)).join(' '));
  const shouldSuppressRolldownLog = (log: { code?: string; message: string }) =>
    log.code === 'CIRCULAR_DEPENDENCY' || log.message.startsWith('Circular dependency:');
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);
  const originalConsoleWarn = console.warn.bind(console);

  logger.warn = (message, options) => {
    if (!shouldSuppressWarning(message)) warn(message, options);
  };
  logger.warnOnce = (message, options) => {
    if (!shouldSuppressWarning(message)) warnOnce(message, options);
  };

  if (command === 'build') {
    console.warn = (...args) => {
      if (!shouldSuppressConsoleWarning(...args)) originalConsoleWarn(...args);
    };
  }

  const silentRolldownChecks = {
    circularDependency: false,
    pluginTimings: false
  };
  return {
    customLogger: logger,
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
      // Rolldown still supports manual chunking here, and we keep the current vendor split behavior.
      rolldownOptions: {
        checks: silentRolldownChecks,
        onLog(level, log, defaultHandler) {
          if (shouldSuppressRolldownLog(log)) return;
          defaultHandler(level, log);
        },
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
    },
    optimizeDeps: {
      rolldownOptions: {
        checks: silentRolldownChecks,
        onLog(level, log, defaultHandler) {
          if (shouldSuppressRolldownLog(log)) return;
          defaultHandler(level, log);
        }
      }
    }
  };
});
