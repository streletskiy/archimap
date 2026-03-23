require('dotenv').config({ quiet: true });

const { createServerRuntime } = require('./src/lib/server/boot/server-runtime.boot');

const runtime = createServerRuntime({
  rootDir: __dirname,
  rawEnv: process.env,
  processRef: process
});

if (require.main === module) {
  runtime.runAsMain();
}

module.exports = {
  app: runtime.app,
  initializeRuntime: runtime.initializeRuntime,
  prepareRuntime: runtime.prepareRuntime,
  startHttpServer: runtime.startHttpServer,
  stopRuntime: runtime.stopRuntime
};
