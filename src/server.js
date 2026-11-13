'use strict';
const cfg = require('./config');
const { pool } = require('./db');
const { createApp } = require('./app');

const server = createApp().listen(cfg.port, () => console.log(`LedgerLine listening on :${cfg.port}`));

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
