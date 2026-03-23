const fs = require('fs');
const { createWeakEtag, isResourceNotModified, toHttpDate } = require('./http-cache.infra');

function parseRangeHeader(rangeHeader, totalSize) {
  const raw = String(rangeHeader || '').trim();
  const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];

  let start = startRaw === '' ? null : Number(startRaw);
  let end = endRaw === '' ? null : Number(endRaw);
  if ((start != null && !Number.isInteger(start)) || (end != null && !Number.isInteger(end))) {
    return null;
  }
  if (start == null && end == null) return null;

  if (start == null) {
    const suffixLength = end;
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else if (end == null) {
    end = totalSize - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= totalSize) {
    return null;
  }
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

function buildPmtilesEtag(stat) {
  const fingerprint = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  return createWeakEtag(Buffer.from(fingerprint, 'utf8'));
}

function sendPmtiles(req, res, pmtilesPath, options: LooseRecord = {}) {
  let stat;
  try {
    stat = fs.statSync(pmtilesPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return res.status(404).json({ code: 'ERR_PMTILES_NOT_FOUND', error: 'PMTiles file was not found. Run sync to generate the tileset.' });
    }
    return res.status(500).json({ code: 'ERR_PMTILES_READ_FAILED', error: 'Failed to read PMTiles file' });
  }

  if (!stat.isFile()) {
    return res.status(404).json({ code: 'ERR_PMTILES_NOT_FOUND', error: 'PMTiles file was not found. Run sync to generate the tileset.' });
  }

  const cacheControl = String(options.cacheControl || 'public, max-age=300').trim();
  const lastModified = toHttpDate(stat.mtime);
  const etag = buildPmtilesEtag(stat);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  if (lastModified) res.setHeader('Last-Modified', lastModified);

  const rangeHeader = req.headers.range;
  if (!rangeHeader && isResourceNotModified(req, { etag, lastModified })) {
    return res.status(304).end();
  }

  const total = stat.size;
  const parsedRange = parseRangeHeader(rangeHeader, total);
  if (rangeHeader && !parsedRange) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  const start = parsedRange ? parsedRange.start : 0;
  const end = parsedRange ? parsedRange.end : Math.max(0, total - 1);
  const contentLength = parsedRange ? (end - start + 1) : total;
  if (parsedRange) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(contentLength));

  if (req.method === 'HEAD') {
    return res.end();
  }

  const stream = fs.createReadStream(pmtilesPath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ code: 'ERR_PMTILES_STREAM_FAILED', error: 'Failed to stream PMTiles file' });
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
  return undefined;
}

module.exports = {
  parseRangeHeader,
  sendPmtiles
};
