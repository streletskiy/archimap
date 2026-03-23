import crypto from 'node:crypto';
import type { Handle } from '@sveltejs/kit';

function normalizeOrigins(input: string) {
  return String(input || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//.test(value))
    .map((value) => value.replace(/\/+$/, ''));
}

function extractInlineScriptHashesFromHtml(html: string) {
  const text = String(html || '');
  const hashes: string[] = [];
  const scriptTagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptTagPattern.exec(text)) !== null) {
    const attrs = String(match[1] || '');
    const body = String(match[2] || '');
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (!body.trim()) continue;
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${hash}'`);
  }

  return [...new Set(hashes)];
}

function buildCspHeader(nodeEnv: string, rawConnectOrigins: string, scriptHashes: string[] = []) {
  const isProd = String(nodeEnv || '').toLowerCase() === 'production';
  const connectOrigins = normalizeOrigins(rawConnectOrigins);
  const connectSrc = ["'self'", ...connectOrigins];
  const imgSrc = ["'self'", 'data:', 'blob:', ...connectOrigins];
  const fontSrc = ["'self'", 'data:', ...connectOrigins];
  const scriptSrcBase = isProd ? ["'self'"] : ["'self'", "'unsafe-eval'"];
  const scriptSrc = [...scriptSrcBase, ...scriptHashes];
  const connectValue = isProd ? connectSrc : [...connectSrc, 'ws:', 'wss:'];

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src ${imgSrc.join(' ')}`,
    `font-src ${fontSrc.join(' ')}`,
    `connect-src ${connectValue.join(' ')}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`
  ].join('; ');
}

const NODE_ENV = String(process.env.NODE_ENV || 'development');
const DEFAULT_CSP_CONNECT_SRC_EXTRA = 'https://tiles.basemaps.cartocdn.com,https://*.basemaps.cartocdn.com';
const CSP_CONNECT_SRC_EXTRA = String(process.env.CSP_CONNECT_SRC_EXTRA || DEFAULT_CSP_CONNECT_SRC_EXTRA);

export const handle: Handle = async ({ event, resolve }) => {
  const incomingRequestId = String(event.request.headers.get('x-request-id') || '').trim();
  const requestId = incomingRequestId || crypto.randomUUID();
  const response = await resolve(event);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const isHtml = contentType.includes('text/html');

  let nextResponse = response;
  let cspHeader = buildCspHeader(NODE_ENV, CSP_CONNECT_SRC_EXTRA);
  if (isHtml) {
    const html = await response.text();
    const scriptHashes = extractInlineScriptHashesFromHtml(html);
    cspHeader = buildCspHeader(NODE_ENV, CSP_CONNECT_SRC_EXTRA, scriptHashes);
    nextResponse = new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
    });
  }

  nextResponse.headers.set('x-request-id', requestId);
  nextResponse.headers.set('X-Content-Type-Options', 'nosniff');
  nextResponse.headers.set('X-Frame-Options', 'DENY');
  nextResponse.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  nextResponse.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  nextResponse.headers.set('Content-Security-Policy', cspHeader);

  if (NODE_ENV === 'production' && event.url.protocol === 'https:') {
    nextResponse.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return nextResponse;
};
