require('dotenv').config({ quiet: true });

const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { parseRuntimeEnv } = require('./src/lib/server/infra/env.infra');

if (!process.env.TRUST_PROXY) {
  process.env.TRUST_PROXY = 'true';
}

const {
  app: internalApp,
  prepareRuntime,
  stopRuntime
} = require('./server');

const runtimeEnv = parseRuntimeEnv(process.env);
const PORT = runtimeEnv.port;
const HOST = runtimeEnv.host;
const INTERNAL_ERROR_PAYLOAD = JSON.stringify({
  code: 'ERR_INTERNAL',
  error: 'Internal server error'
});

let svelteHandlerPromise = null;
let httpServer = null;
let shuttingDown = false;

function buildSvelteHandlerPath() {
  return path.join(__dirname, 'frontend', 'build', 'handler.js');
}

function getPathname(req) {
  const host = String(req.headers.host || `127.0.0.1:${PORT}`);
  return new URL(String(req.url || '/'), `http://${host}`).pathname;
}

const INTERNAL_EXACT_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/app-config.js',
  '/favicon.ico',
  '/.well-known/appspecific/com.chrome.devtools.json'
]);
const INTERNAL_PREFIX_PATHS = ['/api', '/ui'];

function shouldDispatchInternal(pathname) {
  if (INTERNAL_EXACT_PATHS.has(pathname)) return true;
  return INTERNAL_PREFIX_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function getSvelteHandler() {
  if (!svelteHandlerPromise) {
    const handlerPath = buildSvelteHandlerPath();
    svelteHandlerPromise = import(pathToFileURL(handlerPath).href)
      .then((module) => {
        if (typeof module?.handler !== 'function') {
          throw new Error(`Invalid Svelte handler export in ${handlerPath}`);
        }
        return module.handler;
      });
  }
  return svelteHandlerPromise;
}

function dispatchInternal(req, res) {
  return internalApp(req, res);
}

async function requestHandler(req, res) {
  const pathname = getPathname(req);
  if (shouldDispatchInternal(pathname)) {
    return dispatchInternal(req, res);
  }
  const handler = await getSvelteHandler();
  return handler(req, res);
}

async function shutdown(signal = 'manual') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
    httpServer = null;
  }
  await stopRuntime(signal);
}

async function start() {
  await prepareRuntime();
  httpServer = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res))
      .catch(() => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(INTERNAL_ERROR_PAYLOAD);
      });
  });

  await new Promise((resolve, reject) => {
    httpServer.listen(PORT, HOST, resolve);
    httpServer.once('error', reject);
  });

  console.log(`[sveltekit-runtime] listening on http://${HOST}:${PORT}`);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown('SIGINT')
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

start()
  .catch((error) => {
    console.error('[sveltekit-runtime] startup failed:', String(error?.message || error));
    process.exit(1);
  });
