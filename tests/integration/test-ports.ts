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

module.exports = {
  pickIntegrationPort
};
