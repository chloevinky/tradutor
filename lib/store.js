// Local JSON storage: settings (config/), user data + cache (data/).
// Everything here is gitignored so `git pull` never touches user state.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');

for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known_words.json');
const STATS_FILE = path.join(DATA_DIR, 'word_stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const HISTORY_CAP = 1000;

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-4-8',
  port: 4747,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  return next;
}

// ---------- known words ----------

export function getKnownWords() {
  return readJson(KNOWN_FILE, {});
}

export function setKnownWord(word, known) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return getKnownWords();
  const map = getKnownWords();
  if (known) {
    map[w] = Date.now();
  } else {
    delete map[w];
  }
  writeJson(KNOWN_FILE, map);
  return map;
}

// ---------- word lookup stats ----------

export function getWordStats() {
  return readJson(STATS_FILE, {});
}

export function bumpWordLookup(word, gloss) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return;
  const stats = getWordStats();
  const entry = stats[w] || { count: 0, gloss: '', lastTs: 0 };
  entry.count += 1;
  entry.lastTs = Date.now();
  if (gloss) entry.gloss = String(gloss).slice(0, 200);
  stats[w] = entry;
  writeJson(STATS_FILE, stats);
}

// ---------- history ----------

export function getHistory() {
  return readJson(HISTORY_FILE, []);
}

export function appendHistory(entry) {
  const history = getHistory();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  history.push({ id, ts: Date.now(), ...entry });
  while (history.length > HISTORY_CAP) history.shift();
  writeJson(HISTORY_FILE, history);
  return id;
}

export function markHistory(id, patch) {
  const history = getHistory();
  const entry = history.find((h) => h.id === id);
  if (entry) {
    Object.assign(entry, patch);
    writeJson(HISTORY_FILE, history);
  }
  return entry;
}

// ---------- review / export ----------

export function buildReview() {
  const known = getKnownWords();
  const stats = getWordStats();
  const words = Object.entries(stats)
    .filter(([w]) => !known[w])
    .map(([word, s]) => ({ word, count: s.count, gloss: s.gloss || '' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);

  const sentences = getHistory()
    .filter((h) => h.revealed === true)
    .slice(-100)
    .reverse()
    .map((h) => ({ id: h.id, ts: h.ts, input: h.input, translation: h.translation }));

  return { words, sentences };
}

export function buildAnkiTsv() {
  const known = getKnownWords();
  const stats = getWordStats();
  const history = getHistory().filter((h) => h.direction === 'pt-en');

  const clean = (s) =>
    String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();

  const rows = [];
  const words = Object.entries(stats)
    .filter(([w]) => !known[w])
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 200);

  for (const [word, s] of words) {
    // Most recent PT sentence containing this word, for context on the card front.
    const re = new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([^\\p{L}]|$)`, 'iu');
    const hit = [...history].reverse().find((h) => re.test(h.input || ''));
    let front = word;
    let back = clean(s.gloss);
    if (hit) {
      front = clean(hit.input).replace(re, (m, a, b, c) => `${a}<b>${b}</b>${c}`);
      back = `${clean(s.gloss)}${s.gloss ? ' — ' : ''}${clean(hit.translation)}`;
    }
    if (!back) back = '(look this one up again)';
    rows.push(`${front}\t${back}`);
  }

  // Also include sentences the user needed revealed but that have no tracked word.
  const covered = new Set(rows.map((r) => r.split('\t')[0]));
  for (const h of [...history].reverse()) {
    if (h.revealed !== true) continue;
    const front = clean(h.input);
    if (!front || covered.has(front)) continue;
    covered.add(front);
    rows.push(`${front}\t${clean(h.translation)}`);
    if (rows.length >= 300) break;
  }

  return rows.join('\n') + '\n';
}
