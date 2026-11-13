'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const { AppError } = require('./errors');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, routes);
  app.use('/api', (req, _res, next) => next(new AppError(404, 'not_found', 'No such endpoint')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = 500; let code = 'internal_error'; let message = 'Internal error';
    if (err instanceof AppError) { status = err.status; code = err.code; message = err.message; }
    else if (err.type === 'entity.parse.failed') { status = 400; code = 'bad_json'; message = 'Malformed JSON body'; }
    else if (err.type === 'entity.too.large') { status = 413; code = 'too_large'; message = 'Body too large'; }
    else if (err.code === '55P03') { status = 503; code = 'busy'; message = 'Account busy; retry with the same Idempotency-Key'; }
    else if (err.code === '23514') { status = 409; code = 'constraint_violation'; message = 'Rejected by a database constraint'; }
    if (status >= 500 || status === 409) console.error(`[${req.id}]`, err);
    res.status(status).json({ error: { code, message, requestId: req.id } });
  });
  return app;
}

module.exports = { createApp };
