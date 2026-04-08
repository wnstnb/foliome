#!/usr/bin/env node
/**
 * Check whether environment variables are set without revealing their values.
 *
 * Usage:
 *   node scripts/check-env.js VAR1 VAR2 ...
 *   node scripts/check-env.js --prefix CHASE    # checks all CHASE_* vars
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: node scripts/check-env.js VAR1 VAR2 ...');
  console.log('       node scripts/check-env.js --prefix BANK_NAME');
  process.exit(1);
}

if (args[0] === '--prefix' && args[1]) {
  const prefix = args[1].toUpperCase();
  const matches = Object.keys(process.env)
    .filter(k => k.startsWith(prefix))
    .sort();

  if (matches.length === 0) {
    console.log(`No env vars found with prefix "${prefix}"`);
  } else {
    for (const key of matches) {
      console.log(`${key}: set`);
    }
  }
} else {
  for (const name of args) {
    console.log(`${name}: ${process.env[name] ? 'set' : 'NOT SET'}`);
  }
}
