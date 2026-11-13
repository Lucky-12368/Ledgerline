'use strict';
// Applies db/schema.sql if the database is empty. Safe to run on every deploy.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const exists = (await pool.query("SELECT to_regclass('public.users') AS t")).rows[0].t;
  if (exists) { console.log('Schema already present; nothing to do.'); return; }
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Schema applied.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
