// Local JSON storage: settings (config/), user data + cache (data/).
// Everything here is gitignored so `git pull` never touches user state.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const BOOKS_DIR = path.join(DATA_DIR, 'books');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR, BOOKS_DIR, AUDIO_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known_words.json');
const STATS_FILE = path.join(DATA_DIR, 'word_stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SAVED_FILE = path.join(DATA_DIR, 'saved_words.json');
const BOOKS_INDEX = path.join(BOOKS_DIR, 'index.json');

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
  openaiKey: '',
  ttsVoice: 'coral',
  ankiDeck: 'Tradutor pt-BR',
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

// ---------- saved words & phrases (from the ebook reader / lookups) ----------

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function getSaved() {
  return readJson(SAVED_FILE, []);
}

// Adds a lookup result. Repeated lookups of the same Portuguese text update the
// existing entry (bumping its count) instead of duplicating it.
export function addSaved({ pt, en, note, context, bookId, bookTitle }) {
  const list = getSaved();
  const key = String(pt || '').trim().toLowerCase();
  if (!key) return null;
  let entry = list.find((e) => e.pt.trim().toLowerCase() === key);
  if (entry) {
    entry.count = (entry.count || 1) + 1;
    entry.ts = Date.now();
    if (en) entry.en = en;
    if (note) entry.note = note;
    if (context) entry.context = context;
  } else {
    entry = {
      id: newId(),
      pt: String(pt).trim(),
      en: String(en || '').trim(),
      note: String(note || ''),
      context: String(context || ''),
      bookId: bookId || null,
      bookTitle: bookTitle || null,
      audio: null,
      count: 1,
      ts: Date.now(),
    };
    list.push(entry);
  }
  writeJson(SAVED_FILE, list);
  return entry;
}

export function patchSaved(id, patch) {
  const list = getSaved();
  const entry = list.find((e) => e.id === id);
  if (entry) {
    Object.assign(entry, patch);
    writeJson(SAVED_FILE, list);
  }
  return entry || null;
}

export function removeSaved(id) {
  const list = getSaved();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [entry] = list.splice(idx, 1);
  if (entry.audio) {
    try { fs.unlinkSync(path.join(AUDIO_DIR, entry.audio)); } catch { /* already gone */ }
  }
  writeJson(SAVED_FILE, list);
  return true;
}

// ---------- ebook library ----------

export function getBooks() {
  return readJson(BOOKS_INDEX, []);
}

export function getBookContent(id) {
  const safe = String(id).replace(/[^a-z0-9]/gi, '');
  return readJson(path.join(BOOKS_DIR, safe + '.json'), null);
}

export function addBook(meta, content) {
  const books = getBooks();
  const existing = books.find((b) => b.id === meta.id);
  if (!existing) {
    books.push({ ...meta, addedAt: Date.now(), position: { chapter: 0, paragraph: 0 } });
    writeJson(BOOKS_INDEX, books);
  }
  writeJson(path.join(BOOKS_DIR, meta.id + '.json'), content);
  return books.find((b) => b.id === meta.id);
}

export function removeBook(id) {
  const books = getBooks();
  const idx = books.findIndex((b) => b.id === id);
  if (idx === -1) return false;
  books.splice(idx, 1);
  writeJson(BOOKS_INDEX, books);
  const safe = String(id).replace(/[^a-z0-9]/gi, '');
  try { fs.unlinkSync(path.join(BOOKS_DIR, safe + '.json')); } catch { /* already gone */ }
  return true;
}

export function setBookPosition(id, position) {
  const books = getBooks();
  const book = books.find((b) => b.id === id);
  if (book) {
    book.position = {
      chapter: Math.max(0, parseInt(position.chapter, 10) || 0),
      paragraph: Math.max(0, parseInt(position.paragraph, 10) || 0),
    };
    writeJson(BOOKS_INDEX, books);
  }
  return book || null;
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
