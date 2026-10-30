const PORT_RANGES: Record<string, { start: number; span: number }> = {
  api: { start: 3600, span: 100 },
  postgresRuntime: { start: 3900, span: 100 },
  sveltekitRuntime: { start: 4200, span: 100 }
};

function pickIntegrationPort(rangeName: keyof typeof PORT_RANGES) {
  const range = PORT_RANGES[rangeName];
  if (!range) {
    throw new Error(`Unknown integration port range: ${String(rangeName)}`);
  }
  return range.start + Math.floor(Math.random() * range.span);
}

// Windows hosts can allocate fetch-blocked ports (e.g. 6000) when listening on port 0.
async function listenOnSafeTestPort(app): Promise<import('node:http').Server> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await new Promise<import('node:http').Server>((resolve, reject) => {
        const server = app.listen(20000 + Math.floor(Math.random() * 30000), '127.0.0.1', () => resolve(server));
        server.on('error', reject);
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Unable to bind a fetch-compatible HTTP test port');
}

module.exports = {
  pickIntegrationPort,
  listenOnSafeTestPort
};
