const crypto = require('crypto');
const zlib = require('zlib');

function toHttpDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toUTCString();
}

function createWeakEtag(payloadBuffer) {
  const hash = crypto.createHash('sha256').update(payloadBuffer).digest('base64url');
  return `W/"${payloadBuffer.length.toString(16)}-${hash}"`;
}

function parseIfNoneMatch(rawHeader) {
  return String(rawHeader || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isResourceNotModified(req, { etag, lastModified }: LooseRecord) {
  const ifNoneMatch = parseIfNoneMatch(req.headers['if-none-match']);
  if (etag && ifNoneMatch.length > 0) {
    if (ifNoneMatch.includes('*') || ifNoneMatch.includes(etag)) return true;
  }

  if (lastModified) {
    const ifModifiedSinceRaw = String(req.headers['if-modified-since'] || '').trim();
    if (ifModifiedSinceRaw) {
      const ifModifiedSinceTs = Date.parse(ifModifiedSinceRaw);
      const lastModifiedTs = Date.parse(lastModified);
      if (Number.isFinite(ifModifiedSinceTs) && Number.isFinite(lastModifiedTs) && ifModifiedSinceTs >= lastModifiedTs) {
        return true;
      }
    }
  }
  return false;
}

function appendVaryHeader(res, value) {
  const prev = String(res.getHeader('Vary') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!prev.includes(value)) prev.push(value);
  if (prev.length > 0) res.setHeader('Vary', prev.join(', '));
}

function pickEncoding(acceptEncoding) {
  const raw = String(acceptEncoding || '').toLowerCase();
  if (raw.includes('br')) return 'br';
  if (raw.includes('gzip')) return 'gzip';
  return null;
}

function compressPayload(buffer, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5
      }
    });
  }
  if (encoding === 'gzip') {
    return zlib.gzipSync(buffer, { level: 6 });
  }
  return buffer;
}

function sendCachedJson(req, res, payload, options: LooseRecord = {}) {
  const payloadText = JSON.stringify(payload);
  const rawBuffer = Buffer.from(payloadText, 'utf8');
  const etag = createWeakEtag(rawBuffer);
  const lastModified = toHttpDate(options.lastModified);
  const cacheControl = String(options.cacheControl || 'private, no-cache').trim();
  const shouldCompress = rawBuffer.length >= Number(options.minCompressionBytes || 1024);
  const encoding = shouldCompress ? pickEncoding(req.headers['accept-encoding']) : null;

  res.type('application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  appendVaryHeader(res, 'Accept-Encoding');
  if (lastModified) {
    res.setHeader('Last-Modified', lastModified);
  }

  if (isResourceNotModified(req, { etag, lastModified })) {
    return res.status(304).end();
  }

  let body = rawBuffer;
  if (encoding) {
    body = compressPayload(rawBuffer, encoding);
    res.setHeader('Content-Encoding', encoding);
  }
  res.setHeader('Content-Length', String(body.length));

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(body);
}

module.exports = {
  toHttpDate,
  createWeakEtag,
  isResourceNotModified,
  sendCachedJson
};
