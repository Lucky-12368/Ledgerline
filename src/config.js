'use strict';

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const tokenSecret = need('TOKEN_SECRET');
if (tokenSecret.length < 32) throw new Error('TOKEN_SECRET must be at least 32 characters');

module.exports = {
  databaseUrl: need('DATABASE_URL'),
  tokenSecret,
  port: Number(process.env.PORT || 3000),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  tokenTtlSeconds: 60 * 60,
  // 1e12 paise = Rs 10,000,000,000 per movement. Far below BIGINT range, so sums cannot overflow.
  maxAmount: 10n ** 12n,
  flagThreshold: BigInt(process.env.FLAG_THRESHOLD_PAISE || '5000000'),
};
