const { buildPostgresNumericValueSql } = require('./src/lib/server/http/buildings.route.js');
console.log(typeof buildPostgresNumericValueSql === 'function' ? 'Success' : 'Failure');
