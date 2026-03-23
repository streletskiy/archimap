const { ensureAuthSchema } = require('./schema');
const { registerAuthRoutes } = require('./auth.route');

module.exports = {
  ensureAuthSchema,
  registerAuthRoutes
};
