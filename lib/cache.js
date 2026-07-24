// Response cache: hash of (model + prompt + options + text) -> parsed result.
// Keeps repeated lookups instant and API costs down.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CACHE_DIR } from './store.js';

export function cacheKey(parts) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(parts));
  return h.digest('hex');
}

export function cacheGet(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function cachePut(key, value) {
  try {
    const file = path.join(CACHE_DIR, key + '.json');
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), ...value }));
  } catch {
    // Cache failures are never fatal.
  }
}
