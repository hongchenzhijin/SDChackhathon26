#!/usr/bin/env node
// Usage:
//   node scripts/refresh-trends.js                 # live snapshot (today)
//   node scripts/refresh-trends.js --as-of 2026-04-19   # historical backfill (HN signals only)
import { buildSnapshot } from './trends.js';

const i = process.argv.indexOf('--as-of');
const asOf = i > -1 ? process.argv[i + 1] : undefined;

buildSnapshot({ asOf }).catch(err => {
  console.error('Refresh failed:', err.message);
  process.exit(1);
});
