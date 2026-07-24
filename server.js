// Tradutor — local pt-BR <-> EN learning translator.
// One lightweight Express server: static frontend + JSON API + streaming translate.
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as store from './lib/store.js';
import { cacheKey, cacheGet, cachePut } from './lib/cache.js';
import { streamCompletion, validateKey, parseModelJson, friendlyError } from './lib/anthropic.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(store.ROOT, 'public')));

const PROMPTS_DIR = path.join(store.ROOT, 'prompts');

function loadPrompt(mode) {
  const file = path.join(PROMPTS_DIR, mode === 'critique' ? 'critique.md' : 'translate.md');
  const text = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { text, hash };
}

// ---------- settings ----------

app.get('/api/settings', (req, res) => {
  const s = store.getSettings();
  res.json({
    hasKey: Boolean(s.apiKey),
    keyHint: s.apiKey ? s.apiKey.slice(0, 10) + '…' + s.apiKey.slice(-4) : '',
    model: s.model,
  });
});

app.post('/api/settings', async (req, res) => {
  const { apiKey, model } = req.body || {};
  const patch = {};
  if (typeof model === 'string' && model.trim()) patch.model = model.trim();
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
  const s = store.saveSettings(patch);
  res.json({ ok: true, hasKey: Boolean(s.apiKey), model: s.model });
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

// ---------- boot ----------

const PORT = process.env.PORT || store.getSettings().port || 4747;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tradutor running at http://localhost:${PORT}`);
});
