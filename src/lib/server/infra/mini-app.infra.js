const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const TEXT_MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

function normalizePathname(value) {
  const raw = String(value || '/').trim() || '/';
  if (raw === '/') return '/';
  if (raw.endsWith('/')) return raw.slice(0, -1) || '/';
  return raw;
}

function readQuery(searchParams) {
  const out = {};
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createParamMatcher(pattern) {
  const keys = [];
  const source = normalizePathname(pattern)
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (!segment.startsWith(':')) return escapeRegExp(segment);
      const key = segment.slice(1).trim();
      if (!key) return '[^/]+';
      keys.push(key);
      return '([^/]+)';
    })
    .join('/');
  const re = new RegExp(`^${source}/?$`);
  return (pathname) => {
    const match = re.exec(normalizePathname(pathname));
    if (!match) return null;
    if (keys.length === 0) return {};
    const params = {};
    for (let i = 0; i < keys.length; i += 1) {
      try {
        params[keys[i]] = decodeURIComponent(String(match[i + 1] || ''));
      } catch {
        params[keys[i]] = String(match[i + 1] || '');
      }
    }
    return params;
  };
}

function createStringMatcher(pattern, { prefix = false } = {}) {
  const normalized = normalizePathname(pattern);
  if (normalized.includes(':')) {
    if (prefix) {
      throw new Error(`Prefix middleware paths cannot contain params: ${pattern}`);
    }
    return createParamMatcher(normalized);
  }

  if (prefix) {
    return (pathname) => {
      const next = normalizePathname(pathname);
      if (normalized === '/') return {};
      if (next === normalized || next.startsWith(`${normalized}/`)) return {};
      return null;
    };
  }

  return (pathname) => {
    const next = normalizePathname(pathname);
    if (next === normalized) return {};
    if (normalized !== '/' && next === `${normalized}/`) return {};
    return null;
  };
}

function cloneRegex(regex) {
  const flags = regex.flags.replace(/g/g, '');
  return new RegExp(regex.source, flags);
}

function createRegexMatcher(regex) {
  const re = cloneRegex(regex);
  return (pathname) => {
    re.lastIndex = 0;
    return re.test(pathname) ? {} : null;
  };
}

function toMatchers(pattern, options = {}) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.map((entry) => {
    if (entry instanceof RegExp) return createRegexMatcher(entry);
    return createStringMatcher(entry, options);
  });
}

function flattenHandlers(items) {
  const out = [];
  const stack = Array.isArray(items) ? [...items] : [items];
  while (stack.length > 0) {
    const current = stack.shift();
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    if (typeof current === 'function') {
      out.push(current);
    }
  }
  return out;
}

function resolveClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
    if (forwardedFor) {
      const first = forwardedFor.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  const direct = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return String(direct || '').trim() || '127.0.0.1';
}

function resolveProtocol(req, trustProxy) {
  if (trustProxy) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (forwardedProto === 'https') return 'https';
    if (forwardedProto === 'http') return 'http';
  }
  return req.socket?.encrypted ? 'https' : 'http';
}

function setDefaultContentType(res, value) {
  if (!res.getHeader('content-type') && !res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', value);
  }
}

function writePayload(req, res, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (!res.getHeader('content-length') && !res.getHeader('Content-Length')) {
    res.setHeader('Content-Length', String(body.length));
  }
  if (String(req.method || '').toUpperCase() === 'HEAD') {
    return res.end();
  }
  return res.end(body);
}

function applyResponseHelpers(req, res) {
  if (typeof res.status !== 'function') {
    res.status = (statusCode) => {
      const code = Number(statusCode);
      if (Number.isInteger(code) && code >= 100 && code <= 999) {
        res.statusCode = code;
      }
      return res;
    };
  }

  if (typeof res.type !== 'function') {
    res.type = (value) => {
      const raw = String(value || '').trim().toLowerCase();
      if (!raw) return res;
      if (raw.includes('/')) {
        res.setHeader('Content-Type', raw.includes('charset=') ? raw : `${raw}; charset=utf-8`);
      } else if (raw in TEXT_MIME_BY_EXT) {
        res.setHeader('Content-Type', TEXT_MIME_BY_EXT[raw]);
      } else {
        res.setHeader('Content-Type', raw);
      }
      return res;
    };
  }

  if (typeof res.send !== 'function') {
    res.send = (payload) => {
      if (payload == null) {
        if (!res.getHeader('content-length') && !res.getHeader('Content-Length')) {
          res.setHeader('Content-Length', '0');
        }
        return res.end();
      }
      if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
        return res.json(payload);
      }
      return writePayload(req, res, payload);
    };
  }

  if (typeof res.json !== 'function') {
    res.json = (payload) => {
      const text = JSON.stringify(payload);
      setDefaultContentType(res, 'application/json; charset=utf-8');
      return writePayload(req, res, text);
    };
  }

  if (typeof res.redirect !== 'function') {
    res.redirect = (statusOrLocation, maybeLocation) => {
      let statusCode = 302;
      let location = statusOrLocation;
      if (typeof statusOrLocation === 'number') {
        statusCode = statusOrLocation;
        location = maybeLocation;
      }
      const target = String(location || '/');
      res.status(statusCode);
      res.setHeader('Location', target);
      return res.end();
    };
  }

  if (typeof res.sendFile !== 'function') {
    res.sendFile = (filePath) => {
      const resolved = path.resolve(String(filePath || ''));
      fs.stat(resolved, (error, stat) => {
        if (error || !stat || !stat.isFile()) {
          if (!res.headersSent) {
            res.status(404).json({ error: 'File not found' });
          } else {
            res.end();
          }
          return;
        }

        const ext = path.extname(resolved).toLowerCase();
        const contentType = TEXT_MIME_BY_EXT[ext] || 'application/octet-stream';
        res.type(contentType);
        res.setHeader('Content-Length', String(stat.size));
        if (String(req.method || '').toUpperCase() === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(resolved);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Unable to stream file' });
            return;
          }
          res.destroy();
        });
        stream.pipe(res);
      });
      return res;
    };
  }
}

function applyRequestHelpers(app, req) {
  if (typeof req.get !== 'function') {
    req.get = (name) => {
      const key = String(name || '').trim().toLowerCase();
      if (!key) return undefined;
      const value = req.headers[key];
      if (Array.isArray(value)) return value.join(', ');
      return value == null ? undefined : String(value);
    };
  }

  const host = String(req.headers.host || '127.0.0.1');
  const parsedUrl = new URL(String(req.url || '/'), `http://${host}`);
  req.originalUrl = req.originalUrl || req.url || '/';
  req.path = normalizePathname(parsedUrl.pathname);
  req.query = readQuery(parsedUrl.searchParams);
  req.params = {};

  const trustProxy = Boolean(app._settings['trust proxy']);
  req.ip = resolveClientIp(req, trustProxy);
  req.protocol = resolveProtocol(req, trustProxy);
  req.secure = req.protocol === 'https';
  req.hostname = String(parsedUrl.hostname || '').trim();
}

function isRouteMethodMatch(layerMethod, reqMethod) {
  const method = String(reqMethod || 'GET').toUpperCase();
  if (layerMethod === '*') return true;
  if (layerMethod === method) return true;
  return method === 'HEAD' && layerMethod === 'GET';
}

function matchLayer(layer, req) {
  if (layer.kind === 'route' && !isRouteMethodMatch(layer.method, req.method)) {
    return null;
  }
  for (const matcher of layer.matchers) {
    const params = matcher(req.path);
    if (params) return params;
  }
  return null;
}

function executeHandler(handler, err, req, res) {
  const isErrorHandler = handler.length >= 4;
  if (err && !isErrorHandler) return Promise.resolve({ skipped: true, err });
  if (!err && isErrorHandler) return Promise.resolve({ skipped: true, err });

  const expectsNext = err ? handler.length >= 4 : handler.length >= 3;
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      res.off('finish', onDone);
      res.off('close', onDone);
    };

    const finalize = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    const onDone = () => finalize({ type: 'done' });

    const next = (nextErr) => {
      finalize({ type: 'next', err: nextErr });
    };

    res.once('finish', onDone);
    res.once('close', onDone);

    try {
      const value = err
        ? handler(err, req, res, next)
        : handler(req, res, next);
      const awaited = value && typeof value.then === 'function'
        ? value
        : Promise.resolve(value);
      awaited
        .then(() => {
          if (expectsNext) {
            if (res.writableEnded || res.destroyed) {
              finalize({ type: 'done' });
            }
            return;
          }
          finalize({ type: 'done' });
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function registerLayer(app, layer) {
  app._layers.push(layer);
}

function createMiniApp() {
  const app = function miniAppHandler(req, res) {
    return app.handle(req, res);
  };
  app._layers = [];
  app._settings = Object.create(null);

  app.disable = (name) => {
    app._settings[String(name || '')] = false;
    return app;
  };

  app.set = (name, value) => {
    app._settings[String(name || '')] = value;
    return app;
  };

  app.getSetting = (name) => app._settings[String(name || '')];

  app.use = (...args) => {
    let pattern = '/';
    let handlers = args;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0])) {
      pattern = args[0];
      handlers = args.slice(1);
    }
    const flattened = flattenHandlers(handlers);
    for (const handler of flattened) {
      registerLayer(app, {
        kind: 'middleware',
        matchers: toMatchers(pattern, { prefix: true }),
        handler
      });
    }
    return app;
  };

  function addRoute(method, pattern, handlers) {
    const flattened = flattenHandlers(handlers);
    registerLayer(app, {
      kind: 'route',
      method,
      matchers: toMatchers(pattern, { prefix: false }),
      handlers: flattened
    });
    return app;
  }

  for (const method of HTTP_METHODS) {
    app[method.toLowerCase()] = (pattern, ...handlers) => addRoute(method, pattern, handlers);
  }
  app.all = (pattern, ...handlers) => addRoute('*', pattern, handlers);

  app.handle = async (req, res) => {
    applyRequestHelpers(app, req);
    applyResponseHelpers(req, res);

    let layerIndex = 0;
    let currentError;

    while (layerIndex < app._layers.length) {
      const layer = app._layers[layerIndex];
      layerIndex += 1;

      const matchedParams = matchLayer(layer, req);
      if (!matchedParams) continue;
      if (layer.kind === 'route') {
        req.params = matchedParams;
      }

      const handlers = layer.kind === 'route' ? layer.handlers : [layer.handler];
      for (const handler of handlers) {
        let outcome;
        try {
          outcome = await executeHandler(handler, currentError, req, res);
        } catch (error) {
          currentError = error;
          continue;
        }

        if (outcome?.skipped) {
          continue;
        }

        if (outcome?.type === 'next') {
          currentError = outcome.err;
          continue;
        }

        return;
      }
    }

    if (currentError) {
      if (!res.headersSent) {
        res.statusCode = 500;
        setDefaultContentType(res, 'application/json; charset=utf-8');
        const payload = JSON.stringify({
          code: 'ERR_INTERNAL',
          error: String(currentError?.message || currentError || 'Internal server error')
        });
        writePayload(req, res, payload);
      }
      return;
    }

    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 404;
      res.end();
    }
  };

  app.listen = (port, host, callback) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(app.handle(req, res))
        .catch((error) => {
          if (res.headersSent || res.writableEnded) return;
          res.statusCode = 500;
          setDefaultContentType(res, 'application/json; charset=utf-8');
          writePayload(req, res, JSON.stringify({
            code: 'ERR_INTERNAL',
            error: String(error?.message || error || 'Unknown server error')
          }));
        });
    });
    return server.listen(port, host, callback);
  };

  return app;
}

function jsonMiddleware(options = {}) {
  const limitBytes = Math.max(1024, Number(options.limitBytes || (1024 * 1024)));
  return (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) return next();

    if (req.body !== undefined) return next();

    let total = 0;
    const chunks = [];
    let finished = false;

    const fail = (status, payload) => {
      if (finished) return;
      finished = true;
      res.status(status).json(payload);
    };

    req.on('data', (chunk) => {
      if (finished) return;
      total += chunk.length;
      if (total > limitBytes) {
        fail(413, { error: 'Payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      fail(400, { error: 'Unable to read request body' });
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        req.body = {};
        return next();
      }
      try {
        req.body = JSON.parse(raw);
        return next();
      } catch {
        return res.status(400).json({ error: 'Некорректный JSON payload' });
      }
    });

    return undefined;
  };
}

module.exports = {
  createMiniApp,
  jsonMiddleware
};
