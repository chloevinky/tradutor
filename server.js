// Tradutor — local pt-BR <-> EN learning translator.
// One lightweight Express server: static frontend + JSON API + streaming translate.
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as store from './lib/store.js';
import { cacheKey, cacheGet, cachePut } from './lib/cache.js';
import { streamCompletion, validateKey, parseModelJson, friendlyError } from './lib/anthropic.js';
import { parseBook } from './lib/ebook.js';
import { synthesize, validateOpenaiKey, TTS_VOICES } from './lib/tts.js';
import { exportEntries } from './lib/anki.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(store.ROOT, 'public')));

const PROMPTS_DIR = path.join(store.ROOT, 'prompts');

function loadPrompt(mode) {
  const names = { critique: 'critique.md', ask: 'ask.md', lookup: 'lookup.md' };
  const file = path.join(PROMPTS_DIR, names[mode] || 'translate.md');
  const text = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { text, hash };
}

// ---------- settings ----------

const hint = (k) => (k ? k.slice(0, 8) + '…' + k.slice(-4) : '');

app.get('/api/settings', (req, res) => {
  const s = store.getSettings();
  res.json({
    hasKey: Boolean(s.apiKey),
    keyHint: hint(s.apiKey),
    model: s.model,
    hasOpenaiKey: Boolean(s.openaiKey),
    openaiHint: hint(s.openaiKey),
    ttsVoice: s.ttsVoice,
    ttsVoices: TTS_VOICES,
    ankiDeck: s.ankiDeck,
  });
});

app.post('/api/settings', async (req, res) => {
  const { apiKey, model, openaiKey, ttsVoice, ankiDeck } = req.body || {};
  const patch = {};
  if (typeof model === 'string' && model.trim()) patch.model = model.trim();
  if (typeof ttsVoice === 'string' && TTS_VOICES.includes(ttsVoice)) patch.ttsVoice = ttsVoice;
  if (typeof ankiDeck === 'string' && ankiDeck.trim()) patch.ankiDeck = ankiDeck.trim();
  if (typeof apiKey === 'string' && apiKey.trim()) {
    const key = apiKey.trim();
    try {
      await validateKey(key, patch.model || store.getSettings().model);
    } catch (err) {
      const fe = friendlyError(err);
      return res.status(400).json({ error: fe.message, code: fe.code });
    }
    patch.apiKey = key;
  }
  if (typeof openaiKey === 'string' && openaiKey.trim()) {
    const key = openaiKey.trim();
    try {
      await validateOpenaiKey(key);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: 'openai_auth' });
    }
    patch.openaiKey = key;
  }
  const s = store.saveSettings(patch);
  res.json({ ok: true, hasKey: Boolean(s.apiKey), hasOpenaiKey: Boolean(s.openaiKey), model: s.model });
});

// ---------- known words ----------

app.get('/api/known-words', (req, res) => {
  res.json({ words: Object.keys(store.getKnownWords()) });
});

app.post('/api/known-words', (req, res) => {
  const { word, known } = req.body || {};
  const map = store.setKnownWord(word, Boolean(known));
  res.json({ words: Object.keys(map) });
});

// ---------- event logging (reveals, dismissals, lookups) ----------

app.post('/api/log', (req, res) => {
  const { event, historyId, word, gloss } = req.body || {};
  if (event === 'reveal' && historyId) {
    store.markHistory(historyId, { revealed: true, revealedAt: Date.now() });
  } else if (event === 'dismiss' && historyId) {
    store.markHistory(historyId, { revealed: false });
  } else if (event === 'lookup' && word) {
    store.bumpWordLookup(word, gloss);
  }
  res.json({ ok: true });
});

// ---------- review / history / export ----------

app.get('/api/review', (req, res) => {
  res.json(store.buildReview());
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ history: store.getHistory().slice(-limit).reverse() });
});

app.get('/api/export/anki', (req, res) => {
  const tsv = store.buildAnkiTsv();
  res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tradutor-anki.tsv"');
  res.send(tsv);
});

// ---------- translate (NDJSON stream) ----------

app.post('/api/translate', async (req, res) => {
  const settings = store.getSettings();
  const { text, mode = 'translate', progressive = false } = req.body || {};
  const input = String(text || '').trim();

  if (!settings.apiKey) {
    return res.status(400).json({ error: 'No API key configured. Open Settings first.', code: 'no_key' });
  }
  if (!input) {
    return res.status(400).json({ error: 'Nothing to translate.', code: 'empty' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  let prompt;
  try {
    prompt = loadPrompt(mode);
  } catch (err) {
    send({ type: 'error', message: 'Prompt file missing: ' + err.message });
    return res.end();
  }

  const knownWords = Object.keys(store.getKnownWords()).sort();
  const key = cacheKey({
    v: 2,
    mode,
    model: settings.model,
    prompt: prompt.hash,
    progressive: mode === 'translate' ? Boolean(progressive) : false,
    known: mode === 'translate' && progressive ? knownWords : [],
    text: input,
  });

  const finish = (result, raw, cached) => {
    let historyId = null;
    if (mode === 'translate') {
      historyId = store.appendHistory({
        mode,
        direction: result.direction || null,
        input,
        translation: result.translation || '',
        revealed: null,
      });
    }
    send({ type: 'done', result, historyId, cached });
    res.end();
  };

  const cached = cacheGet(key);
  if (cached && cached.result) {
    return finish(cached.result, cached.raw, true);
  }

  const userContent = mode === 'critique'
    ? `Learner-written Portuguese to critique:\n<<<\n${input}\n>>>`
    : [
        `Progressive mode: ${progressive ? 'ON' : 'OFF'}`,
        `Known Portuguese words (${knownWords.length}): ${knownWords.join(', ') || '(none yet)'}`,
        `Text to translate:\n<<<\n${input}\n>>>`,
      ].join('\n');

  try {
    const raw = await streamCompletion({
      apiKey: settings.apiKey,
      model: settings.model,
      system: prompt.text,
      userContent,
      onDelta: (delta) => send({ type: 'delta', text: delta }),
    });

    let result = parseModelJson(raw);
    if (!result) {
      // Model broke the JSON contract — degrade to plain text instead of failing.
      result = {
        direction: null,
        translation: raw.trim(),
        register_variants: null,
        expansions: [],
        words: [],
        ambiguities: [],
        false_friends: [],
        structures: [],
        parse_failed: true,
      };
    }
    cachePut(key, { result, raw });
    finish(result, raw, false);
  } catch (err) {
    const fe = friendlyError(err);
    send({ type: 'error', message: fe.message, code: fe.code, status: fe.status });
    res.end();
  }
});

// ---------- ask (follow-up questions about the current text, NDJSON stream) ----------

app.post('/api/ask', async (req, res) => {
  const settings = store.getSettings();
  const { question, text = '', translation = '' } = req.body || {};
  const q = String(question || '').trim();

  if (!settings.apiKey) {
    return res.status(400).json({ error: 'No API key configured. Open Settings first.', code: 'no_key' });
  }
  if (!q) {
    return res.status(400).json({ error: 'No question given.', code: 'empty' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  let prompt;
  try {
    prompt = loadPrompt('ask');
  } catch (err) {
    send({ type: 'error', message: 'Prompt file missing: ' + err.message });
    return res.end();
  }

  const userContent = [
    `Text the learner is looking at:\n<<<\n${String(text).trim() || '(empty)'}\n>>>`,
    `Its translation:\n<<<\n${String(translation).trim() || '(none yet)'}\n>>>`,
    `Question: ${q}`,
  ].join('\n\n');

  try {
    const raw = await streamCompletion({
      apiKey: settings.apiKey,
      model: settings.model,
      system: prompt.text,
      userContent,
      maxTokens: 4000,
      onDelta: (delta) => send({ type: 'delta', text: delta }),
    });
    send({ type: 'done', answer: raw.trim() });
    res.end();
  } catch (err) {
    const fe = friendlyError(err);
    send({ type: 'error', message: fe.message, code: fe.code, status: fe.status });
    res.end();
  }
});

// ---------- ebook library ----------

app.post('/api/books', express.raw({ type: () => true, limit: '80mb' }), (req, res) => {
  const name = String(req.query.name || 'book');
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Empty upload.' });
  }
  let parsed;
  try {
    parsed = parseBook(req.body, name);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const id = crypto.createHash('sha256').update(req.body).digest('hex').slice(0, 12);
  const title = parsed.title || name.replace(/\.[^.]+$/, '');
  const meta = {
    id,
    title,
    author: parsed.author || null,
    format: parsed.format,
    chapterCount: parsed.chapters.length,
    paragraphCount: parsed.chapters.reduce((n, c) => n + c.paragraphs.length, 0),
    fileName: name,
  };
  const book = store.addBook(meta, { chapters: parsed.chapters });
  res.json({ book });
});

app.get('/api/books', (req, res) => {
  res.json({ books: store.getBooks() });
});

app.get('/api/books/:id', (req, res) => {
  const book = store.getBooks().find((b) => b.id === req.params.id);
  const content = store.getBookContent(req.params.id);
  if (!book || !content) return res.status(404).json({ error: 'Book not found.' });
  res.json({ book, chapters: content.chapters });
});

app.delete('/api/books/:id', (req, res) => {
  res.json({ ok: store.removeBook(req.params.id) });
});

app.post('/api/books/:id/position', (req, res) => {
  const book = store.setBookPosition(req.params.id, req.body || {});
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  res.json({ ok: true, position: book.position });
});

// ---------- word/phrase lookup (from the reader) → saved words DB ----------

app.post('/api/lookup', async (req, res) => {
  const settings = store.getSettings();
  const { text, context = '', bookId = null, save = true } = req.body || {};
  const sel = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!settings.apiKey) {
    return res.status(400).json({ error: 'No API key configured. Open Settings first.', code: 'no_key' });
  }
  if (!sel) return res.status(400).json({ error: 'Nothing selected.', code: 'empty' });

  let prompt;
  try {
    prompt = loadPrompt('lookup');
  } catch (err) {
    return res.status(500).json({ error: 'Prompt file missing: ' + err.message });
  }

  const key = cacheKey({ v: 1, mode: 'lookup', model: settings.model, prompt: prompt.hash, text: sel, context });
  let result = cacheGet(key)?.result;
  let cached = Boolean(result);

  if (!result) {
    const userContent = [
      `Selection: ${sel}`,
      `Sentence it appears in:\n<<<\n${String(context).trim() || '(no context)'}\n>>>`,
    ].join('\n');
    try {
      const raw = await streamCompletion({
        apiKey: settings.apiKey,
        model: settings.model,
        system: prompt.text,
        userContent,
        maxTokens: 1000,
        onDelta: () => {},
      });
      result = parseModelJson(raw);
      if (!result || !result.en) result = { pt: sel, en: String(raw).trim(), lemma: null, literal: null, note: '' };
      cachePut(key, { result });
    } catch (err) {
      const fe = friendlyError(err);
      return res.status(fe.status >= 400 && fe.status < 600 ? fe.status : 502)
        .json({ error: fe.message, code: fe.code });
    }
  }

  let entry = null;
  if (save) {
    const book = bookId ? store.getBooks().find((b) => b.id === bookId) : null;
    entry = store.addSaved({
      pt: result.pt || sel,
      en: result.en,
      note: result.note || '',
      context: String(context).trim().slice(0, 400),
      bookId,
      bookTitle: book ? book.title : null,
    });
    store.bumpWordLookup(result.lemma || result.pt || sel, result.en);
  }
  res.json({ result, entry, cached });
});

// ---------- saved words & phrases ----------

app.get('/api/saved', (req, res) => {
  res.json({ entries: store.getSaved().slice().reverse() });
});

app.delete('/api/saved/:id', (req, res) => {
  res.json({ ok: store.removeSaved(req.params.id) });
});

// ---------- text-to-speech (OpenAI) ----------

async function ensureEntryAudio(entry, settings) {
  if (entry.audio && fs.existsSync(path.join(store.AUDIO_DIR, entry.audio))) return entry;
  const mp3 = await synthesize({ apiKey: settings.openaiKey, text: entry.pt, voice: settings.ttsVoice });
  const file = entry.id + '.mp3';
  fs.writeFileSync(path.join(store.AUDIO_DIR, file), mp3);
  return store.patchSaved(entry.id, { audio: file });
}

app.post('/api/saved/:id/audio', async (req, res) => {
  const settings = store.getSettings();
  const entry = store.getSaved().find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  try {
    const updated = await ensureEntryAudio(entry, settings);
    res.json({ ok: true, audio: '/api/audio/' + updated.audio });
  } catch (err) {
    res.status(err.code === 'no_openai_key' ? 400 : 502).json({ error: err.message, code: err.code });
  }
});

app.get('/api/audio/:file', (req, res) => {
  const safe = String(req.params.file).replace(/[^a-z0-9._-]/gi, '');
  const file = path.join(store.AUDIO_DIR, safe);
  if (!safe || !fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'max-age=86400');
  fs.createReadStream(file).pipe(res);
});

// Ad-hoc speech for the translator's Speak button. Cached by text+voice hash.
app.post('/api/speak', async (req, res) => {
  const settings = store.getSettings();
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to speak.' });
  const file = 'speak-' + crypto.createHash('sha256')
    .update(settings.ttsVoice + '\0' + text).digest('hex').slice(0, 16) + '.mp3';
  const full = path.join(store.AUDIO_DIR, file);
  try {
    if (!fs.existsSync(full)) {
      const mp3 = await synthesize({ apiKey: settings.openaiKey, text, voice: settings.ttsVoice });
      fs.writeFileSync(full, mp3);
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    res.status(err.code === 'no_openai_key' ? 400 : 502).json({ error: err.message, code: err.code });
  }
});

// ---------- Anki sync (AnkiConnect) ----------

app.post('/api/anki/export', async (req, res) => {
  const settings = store.getSettings();
  const withAudio = Boolean(req.body?.withAudio);
  let entries = store.getSaved();
  if (!entries.length) return res.status(400).json({ error: 'No saved words to export yet.' });

  let audioGenerated = 0;
  const audioErrors = [];
  if (withAudio) {
    for (const entry of entries) {
      if (entry.audio) continue;
      try {
        await ensureEntryAudio(entry, settings);
        audioGenerated++;
      } catch (err) {
        audioErrors.push(`"${entry.pt}": ${err.message}`);
        if (err.code === 'no_openai_key' || err.status === 401 || err.status === 429) break;
      }
    }
    entries = store.getSaved();
  }

  try {
    const summary = await exportEntries({ deck: settings.ankiDeck, entries });
    res.json({ ok: true, deck: settings.ankiDeck, ...summary, audioGenerated, audioErrors });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

// ---------- boot ----------

const PORT = process.env.PORT || store.getSettings().port || 4747;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tradutor running at http://localhost:${PORT}`);
});
