'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('./config');
const { pool } = require('./db');
const { AppError } = require('./errors');

const scrypt = promisify(crypto.scrypt);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const dk = await scrypt(pw, Buffer.from(s, 'base64url'), 64);
  const want = Buffer.from(h, 'base64url');
  return want.length === dk.length && crypto.timingSafeEqual(dk, want);
}

let dummy;
async function dummyVerify(pw) { // equalise timing for unknown emails
  dummy = dummy || (await hashPassword('dummy-password'));
  await verifyPassword(pw, dummy);
}

const mac = (body) => crypto.createHmac('sha256', cfg.tokenSecret).update(body).digest();

function signToken(userId) {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + cfg.tokenTtlSeconds })).toString('base64url');
  return `${body}.${mac(body).toString('base64url')}`;
}

function verifyToken(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const got = Buffer.from(sig, 'base64url');
  const want = mac(body);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

// The token carries only the user id. The role is re-read from the database on EVERY request.
async function authenticate(req, _res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    const p = m && verifyToken(m[1]);
    if (!p) throw new AppError(401, 'unauthenticated', 'Missing or invalid token');
    const r = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [p.uid]);
    if (!r.rowCount) throw new AppError(401, 'unauthenticated', 'Unknown user');
    req.user = r.rows[0];
    next();
  } catch (e) { next(e); }
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new AppError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`));

// Crude in-memory brute-force limiter (per instance).
const fails = new Map();
const limiter = {
  blocked(k) { const f = fails.get(k); return !!f && f.n >= 10 && f.until > Date.now(); },
  fail(k) {
    if (fails.size > 10000) fails.clear();
    const f = fails.get(k);
    fails.set(k, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
  },
  reset(k) { fails.delete(k); },
};

module.exports = { hashPassword, verifyPassword, dummyVerify, signToken, verifyToken, authenticate, requireRole, limiter };
