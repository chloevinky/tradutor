/* Tradutor frontend — vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    input: $('input'),
    inputAnnotated: $('input-annotated'),
    inputWarnings: $('input-warnings'),
    output: $('output'),
    outputLabel: $('output-label'),
    outputStatus: $('output-status'),
    revealOverlay: $('reveal-overlay'),
    expansions: $('expansions'),
    structures: $('structures'),
    variants: $('variants'),
    outputWarnings: $('output-warnings'),
    errorBar: $('error-bar'),
    errorText: $('error-text'),
    tooltip: $('tooltip'),
    wordPanel: $('word-panel'),
    reviewPanel: $('review-panel'),
    settingsModal: $('settings-modal'),
    toggleBlur: $('toggle-blur'),
    toggleProgressive: $('toggle-progressive'),
    toggleCritique: $('toggle-critique'),
  };

  const state = {
    known: new Set(),
    result: null,
    historyId: null,
    pendingReveal: null, // {historyId} while a blurred pt-en result awaits reveal
    annMap: new Map(),   // normalized word -> annotation object
    abort: null,
    lastSentText: '',
    panelWord: null,
  };

  // ---------- prefs (UI-only, localStorage) ----------

  const prefs = {
    get blur() { return localStorage.getItem('blur') !== '0'; },
    set blur(v) { localStorage.setItem('blur', v ? '1' : '0'); },
    get progressive() { return localStorage.getItem('progressive') === '1'; },
    set progressive(v) { localStorage.setItem('progressive', v ? '1' : '0'); },
    get critique() { return localStorage.getItem('critique') === '1'; },
    set critique(v) { localStorage.setItem('critique', v ? '1' : '0'); },
  };

  els.toggleBlur.checked = prefs.blur;
  els.toggleProgressive.checked = prefs.progressive;
  els.toggleCritique.checked = prefs.critique;

  // ---------- helpers ----------

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const normWord = (w) => String(w || '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  function api(path, opts) {
    return fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  }

  function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body) });
  }

  // ---------- error bar ----------

  function showError(msg) {
    els.errorText.textContent = msg;
    els.errorBar.classList.remove('hidden');
  }
  function hideError() {
    els.errorBar.classList.add('hidden');
  }
  $('btn-error-close').addEventListener('click', hideError);
  $('btn-retry').addEventListener('click', () => {
    hideError();
    translate(true);
  });

  // ---------- word annotation rendering ----------

  function buildAnnMap(words) {
    const m = new Map();
    for (const w of words || []) {
      const k = normWord(w.surface);
      if (k && !m.has(k)) m.set(k, w);
      const lk = normWord(w.lemma);
      if (lk && !m.has(lk)) m.set(lk, w);
    }
    return m;
  }

  function annFor(key) {
    if (!key) return null;
    if (state.annMap.has(key)) return state.annMap.get(key);
    const ab = window.abbrevLookup(key);
    if (ab) {
      return {
        surface: key, lemma: ab.to, pos: 'abbreviation',
        gloss: ab.gloss, morphology: `${key} → ${ab.to}`,
        note: 'internet-Portuguese shorthand', _abbrev: true,
      };
    }
    return null;
  }

  const ffWords = () => new Set((state.result?.false_friends || []).map((f) => normWord(f.word)));

  // Wrap each Portuguese word in an interactive span. Text stays pre-wrap.
  function renderAnnotatedText(text) {
    const ff = ffWords();
    const parts = String(text).split(/(\s+)/);
    let html = '';
    for (const tok of parts) {
      if (!tok || /^\s+$/.test(tok)) { html += esc(tok); continue; }
      const m = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su);
      const [, pre, core, post] = m || [null, '', tok, ''];
      const key = normWord(core);
      const ann = annFor(key);
      if (!core || !key) { html += esc(tok); continue; }
      const classes = ['w'];
      if (state.known.has(key) || (ann && state.known.has(normWord(ann.lemma)))) classes.push('known');
      else classes.push('unk');
      if (ff.has(key)) classes.push('ff');
      if (ann && ann._abbrev) classes.push('abbrev');
      html += esc(pre)
        + `<span class="${classes.join(' ')}" data-key="${esc(key)}">${esc(core)}</span>`
        + esc(post);
    }
    return html;
  }

  // English translation with ambiguity spans highlighted.
  function renderTranslationHtml(translation, ambiguities) {
    const text = String(translation ?? '');
    const ranges = [];
    for (let i = 0; i < (ambiguities || []).length; i++) {
      const amb = ambiguities[i];
      if (!amb || !amb.text) continue;
      const at = text.indexOf(amb.text);
      if (at === -1) continue;
      if (ranges.some((r) => at < r.end && at + amb.text.length > r.start)) continue;
      ranges.push({ start: at, end: at + amb.text.length, idx: i });
    }
    ranges.sort((a, b) => a.start - b.start);
    let html = '';
    let pos = 0;
    for (const r of ranges) {
      html += esc(text.slice(pos, r.start));
      html += `<span class="amb" data-amb="${r.idx}" title="ambiguous — click">${esc(text.slice(r.start, r.end))}</span>`;
      pos = r.end;
    }
    html += esc(text.slice(pos));
    return html;
  }

  // ---------- output rendering ----------

  function clearOutputExtras() {
    els.expansions.innerHTML = '';
    els.structures.innerHTML = '';
    els.variants.innerHTML = '';
    els.variants.classList.add('hidden');
    els.outputWarnings.innerHTML = '';
    els.inputWarnings.innerHTML = '';
  }

  function setBlur(on) {
    els.output.classList.toggle('blurred', on);
    els.revealOverlay.classList.toggle('hidden', !on);
  }

  function renderResult() {
    const r = state.result;
    if (!r) return;
    clearOutputExtras();

    if (r.mode === 'critique') {
      renderCritique(r);
      return;
    }

    const dir = r.direction;
    els.outputLabel.textContent = dir === 'pt-en' ? 'English' : dir === 'en-pt' ? 'Português' : 'Translation';
    state.annMap = buildAnnMap(r.words);

    // Output pane: annotate PT when output is Portuguese; highlight ambiguity in EN.
    if (dir === 'en-pt') {
      els.output.innerHTML = renderAnnotatedText(r.translation || '');
    } else {
      els.output.innerHTML = renderTranslationHtml(r.translation || '', r.ambiguities);
    }

    // Input pane: annotated overlay when the input is Portuguese.
    if (dir === 'pt-en') {
      els.inputAnnotated.innerHTML = renderAnnotatedText(els.input.value);
      if (document.activeElement !== els.input) {
        els.inputAnnotated.classList.remove('hidden');
      }
    } else {
      els.inputAnnotated.classList.add('hidden');
    }

    // Expansions: vc → você chips.
    for (const e of r.expansions || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${e.from} → ${e.to}${e.meaning ? ` (${e.meaning})` : ''}`;
      els.expansions.appendChild(chip);
    }

    // Structure notes.
    for (const s of r.structures || []) {
      const chip = document.createElement('span');
      chip.className = 'chip struct';
      chip.textContent = `${s.text} — ${s.note}`;
      els.structures.appendChild(chip);
    }

    // False friends.
    for (const f of r.false_friends || []) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.innerHTML = `⚠️ <b>${esc(f.word)}</b> looks like “${esc(f.looks_like)}” but means: ${esc(f.actually_means)}`;
      (dir === 'pt-en' ? els.inputWarnings : els.outputWarnings).appendChild(card);
    }

    // Register variants (en→pt).
    if (r.register_variants && (r.register_variants.casual || r.register_variants.neutral)) {
      els.variants.classList.remove('hidden');
      for (const [tag, textv] of Object.entries(r.register_variants)) {
        if (!textv) continue;
        const div = document.createElement('div');
        div.className = 'variant';
        div.innerHTML = `<span class="tag">${esc(tag)}</span>${renderAnnotatedText(textv)}`;
        els.variants.appendChild(div);
      }
    }

    if (r.parse_failed) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.textContent = 'The model returned unstructured output this time — showing raw text without annotations.';
      els.outputWarnings.appendChild(card);
    }

    // Blur mechanic: pt→en only.
    const shouldBlur = dir === 'pt-en' && prefs.blur;
    setBlur(shouldBlur);
    if (shouldBlur && state.historyId) {
      state.pendingReveal = { historyId: state.historyId };
    }
  }

  function renderCritique(r) {
    els.outputLabel.textContent = 'Critique';
    state.annMap = buildAnnMap(r.words);
    setBlur(false);

    const ok = r.grammatical === true && (!r.issues || r.issues.length === 0);
    let html = '<div class="critique">';
    html += `<div class="verdict ${r.grammatical ? 'ok' : 'bad'}">${r.grammatical ? '✓ grammatical' : '✗ has issues'}</div>`;
    if (r.issues && r.issues.length) {
      html += '<div>';
      for (const it of r.issues) {
        html += `<div class="issue"><del>${esc(it.got)}</del> → <ins>${esc(it.should)}</ins><span class="note">${esc(it.note)}</span></div>`;
      }
      html += '</div>';
      html += `<div><div class="block-label">corrected</div><div>${renderAnnotatedText(r.corrected || '')}</div></div>`;
    } else if (ok) {
      html += '<div class="dim">No corrections needed.</div>';
    }
    html += `<div><div class="block-label">a Brazilian would more likely say ${r.register ? `· <span class="chip">${esc(r.register)}</span>` : ''}</div>` +
      `<div class="natural-line">${renderAnnotatedText(r.natural || '')}</div>` +
      (r.why_natural ? `<div class="dim">${esc(r.why_natural)}</div>` : '') + '</div>';
    html += '</div>';
    els.output.innerHTML = html;
    els.inputAnnotated.classList.add('hidden');
  }

  // ---------- streaming translate ----------

  let debounceTimer = null;

  function scheduleTranslate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => translate(false), 900);
  }

  // Extract the (partial) "translation" string value from streaming JSON.
  function partialTranslation(raw) {
    const m = raw.match(/"translation"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return null;
    try {
      return JSON.parse('"' + m[1].replace(/\\$/, '') + '"');
    } catch {
      return m[1];
    }
  }
  function partialDirection(raw) {
    const m = raw.match(/"direction"\s*:\s*"(pt-en|en-pt)"/);
    return m ? m[1] : null;
  }

  async function translate(force) {
    const text = els.input.value.trim();
    if (!text) return;
    if (!force && text === state.lastSentText) return;

    // Previous blurred result never revealed -> that's a "needed review" signal? No:
    // dismissed-unrevealed means the learner understood it. Log as dismiss.
    if (state.pendingReveal) {
      post('/api/log', { event: 'dismiss', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }

    if (state.abort) state.abort.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.lastSentText = text;
    state.result = null;
    state.historyId = null;
    state.annMap = new Map();
    hideError();
    clearOutputExtras();
    els.inputAnnotated.classList.add('hidden');
    els.output.textContent = '';
    els.outputStatus.textContent = '…';
    setBlur(false);

    const mode = prefs.critique ? 'critique' : 'translate';
    let raw = '';
    let blurArmed = false;

    try {
      const res = await api('/api/translate', {
        method: 'POST',
        body: JSON.stringify({ text, mode, progressive: prefs.progressive }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.code === 'no_key') {
          openSettings();
        }
        showError(e.error || `Request failed (${res.status})`);
        els.outputStatus.textContent = '';
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      const handleLine = (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'delta') {
          raw += msg.text;
          const dir = partialDirection(raw);
          if (dir === 'pt-en' && prefs.blur && mode === 'translate' && !blurArmed) {
            blurArmed = true;
            setBlur(true);
          }
          const partial = partialTranslation(raw);
          if (partial !== null) {
            els.output.textContent = partial;
            els.outputScroll?.();
          }
        } else if (msg.type === 'done') {
          state.result = msg.result;
          state.historyId = msg.historyId;
          els.outputStatus.textContent = msg.cached ? 'cached' : '';
          renderResult();
        } else if (msg.type === 'error') {
          showError(msg.message);
          els.outputStatus.textContent = '';
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) handleLine(line);
        }
      }
      if (els.outputStatus.textContent === '…') els.outputStatus.textContent = '';
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError('Connection to the local server failed: ' + err.message);
      els.outputStatus.textContent = '';
    }
  }

  els.input.addEventListener('input', () => {
    els.inputAnnotated.classList.add('hidden');
    scheduleTranslate();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTimeout(debounceTimer);
      translate(true);
    }
  });
  els.input.addEventListener('blur', () => {
    // Show annotated overlay when we have a fresh PT analysis of the current text.
    if (state.result && state.result.direction === 'pt-en' &&
        state.lastSentText === els.input.value.trim() && els.input.value.trim()) {
      els.inputAnnotated.innerHTML = renderAnnotatedText(els.input.value);
      els.inputAnnotated.classList.remove('hidden');
    }
  });
  els.inputAnnotated.addEventListener('click', (e) => {
    if (e.target.closest('.w')) return; // word clicks handled globally
    els.inputAnnotated.classList.add('hidden');
    els.input.focus();
  });

  // ---------- reveal ----------

  els.revealOverlay.addEventListener('click', () => {
    setBlur(false);
    if (state.pendingReveal) {
      post('/api/log', { event: 'reveal', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }
  });

  // ---------- tooltip ----------

  document.addEventListener('mouseover', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    const ann = annFor(w.dataset.key);
    if (!ann) return;
    els.tooltip.innerHTML = `${esc(ann.gloss || '')}` +
      (ann.morphology ? `<span class="tt-morph">${esc(ann.morphology)}</span>` : '');
    els.tooltip.classList.remove('hidden');
    const rect = w.getBoundingClientRect();
    els.tooltip.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    els.tooltip.style.top = (rect.bottom + 6) + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.w')) els.tooltip.classList.add('hidden');
  });

  // ---------- word panel ----------

  function openWordPanel(key) {
    const ann = annFor(key);
    state.panelWord = { key, ann };
    $('wp-surface').textContent = ann?.surface || key;
    $('wp-gloss').textContent = ann?.gloss || '(no gloss — try translating first)';

    const meta = [];
    if (ann?.lemma && normWord(ann.lemma) !== key) meta.push(`lemma: ${ann.lemma}`);
    if (ann?.pos) meta.push(ann.pos);
    if (ann?.gender) meta.push(ann.gender === 'm' ? 'masculine' : 'feminine');
    if (ann?.number) meta.push(ann.number === 'pl' ? 'plural' : 'singular');
    if (ann?.morphology) meta.push(ann.morphology);
    $('wp-meta').textContent = meta.join(' · ');
    $('wp-note').textContent = ann?.note || ann?.why || '';

    const conj = $('wp-conjugation');
    conj.innerHTML = '';
    if (ann?.conjugation && typeof ann.conjugation === 'object') {
      let html = '<table class="conj-table">';
      for (const [tense, forms] of Object.entries(ann.conjugation)) {
        if (!forms) continue;
        html += `<tr><td>${esc(tense)}</td><td>${esc(forms)}</td></tr>`;
      }
      html += '</table>';
      conj.innerHTML = html;
    }

    const coll = $('wp-collocations');
    coll.innerHTML = '';
    if (ann?.collocations && ann.collocations.length) {
      coll.innerHTML = '<h3>Collocations</h3>' +
        ann.collocations.map((c) => `<div class="chip struct">${esc(c)}</div>`).join(' ');
    }

    const lemmaKey = normWord(ann?.lemma) || key;
    $('wp-known').checked = state.known.has(key) || state.known.has(lemmaKey);

    els.wordPanel.classList.remove('hidden');

    // Every panel open counts as a lookup — this feeds the review list.
    post('/api/log', { event: 'lookup', word: lemmaKey, gloss: ann?.gloss || '' });
  }

  $('wp-close').addEventListener('click', () => els.wordPanel.classList.add('hidden'));

  $('wp-known').addEventListener('change', async (e) => {
    const pw = state.panelWord;
    if (!pw) return;
    const lemmaKey = normWord(pw.ann?.lemma) || pw.key;
    const known = e.target.checked;
    const res = await post('/api/known-words', { word: lemmaKey, known });
    const data = await res.json();
    state.known = new Set(data.words);
    if (lemmaKey !== pw.key) {
      await post('/api/known-words', { word: pw.key, known }).then(async (r) => {
        state.known = new Set((await r.json()).words);
      });
    }
    rerenderAnnotations();
  });

  function rerenderAnnotations() {
    if (!state.result) return;
    if (state.result.mode === 'critique') { renderCritique(state.result); return; }
    const wasBlurred = els.output.classList.contains('blurred');
    renderResult();
    if (!wasBlurred) setBlur(false);
  }

  // Word + ambiguity clicks (event delegation covers all panes).
  document.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) { openWordPanel(w.dataset.key); return; }
    const amb = e.target.closest('.amb');
    if (amb && state.result) {
      const a = (state.result.ambiguities || [])[Number(amb.dataset.amb)];
      if (a) {
        state.panelWord = null;
        $('wp-surface').textContent = `“${a.text}”`;
        $('wp-gloss').textContent = `The model chose “${a.chosen}”.`;
        $('wp-meta').textContent = a.alternatives?.length
          ? `Could also be: ${a.alternatives.join(', ')}` : '';
        $('wp-note').textContent = a.clue ? `Context clue: ${a.clue}` : 'No strong context clue — Portuguese leaves this open.';
        $('wp-conjugation').innerHTML = '';
        $('wp-collocations').innerHTML = '';
        $('wp-known').parentElement.classList.add('hidden');
        els.wordPanel.classList.remove('hidden');
        return;
      }
    }
    if (!e.target.closest('#word-panel')) {
      els.wordPanel.classList.add('hidden');
      $('wp-known').parentElement.classList.remove('hidden');
    }
  });

  // ---------- toggles ----------

  els.toggleBlur.addEventListener('change', (e) => {
    prefs.blur = e.target.checked;
    if (!e.target.checked) {
      setBlur(false);
      state.pendingReveal = null;
    } else if (state.result?.direction === 'pt-en') {
      setBlur(true);
    }
  });
  els.toggleProgressive.addEventListener('change', (e) => {
    prefs.progressive = e.target.checked;
    state.lastSentText = '';
    scheduleTranslate();
  });
  els.toggleCritique.addEventListener('change', (e) => {
    prefs.critique = e.target.checked;
    state.lastSentText = '';
    clearTimeout(debounceTimer);
    translate(true);
  });

  // ---------- review panel ----------

  $('btn-review').addEventListener('click', async () => {
    const res = await api('/api/review');
    const data = await res.json();
    const wordsEl = $('review-words');
    wordsEl.innerHTML = data.words.length ? '' : '<div class="dim">Nothing yet — click words to look them up.</div>';
    for (const w of data.words) {
      const row = document.createElement('div');
      row.className = 'review-word';
      row.innerHTML = `<span class="rw-word">${esc(w.word)}</span>` +
        `<span class="rw-gloss">${esc(w.gloss)}</span>` +
        `<span class="rw-count">×${w.count}</span>` +
        `<button class="btn btn-small" data-know="${esc(w.word)}">know it</button>`;
      wordsEl.appendChild(row);
    }
    const sentEl = $('review-sentences');
    sentEl.innerHTML = data.sentences.length ? '' : '<div class="dim">Nothing yet — sentences you reveal land here.</div>';
    for (const s of data.sentences) {
      const div = document.createElement('div');
      div.className = 'review-sentence';
      div.innerHTML = `<div class="rs-pt">${esc(s.input)}</div><div class="rs-en">${esc(s.translation)}</div>`;
      sentEl.appendChild(div);
    }
    els.reviewPanel.classList.remove('hidden');
  });
  $('review-close').addEventListener('click', () => els.reviewPanel.classList.add('hidden'));
  $('review-words').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-know]');
    if (!btn) return;
    const res = await post('/api/known-words', { word: btn.dataset.know, known: true });
    state.known = new Set((await res.json()).words);
    btn.closest('.review-word').remove();
    rerenderAnnotations();
  });

  // ---------- settings ----------

  async function loadSettings() {
    const res = await api('/api/settings');
    const s = await res.json();
    $('set-model').value = s.model;
    $('set-key-hint').textContent = s.hasKey ? `Current key: ${s.keyHint}` : 'No key configured yet.';
    return s;
  }

  function openSettings() {
    loadSettings();
    $('set-msg').textContent = '';
    $('set-msg').className = 'set-msg';
    els.settingsModal.classList.remove('hidden');
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('set-cancel').addEventListener('click', () => els.settingsModal.classList.add('hidden'));
  $('set-save').addEventListener('click', async () => {
    const msg = $('set-msg');
    msg.textContent = 'Checking key…';
    msg.className = 'set-msg';
    const body = { model: $('set-model').value.trim() };
    const key = $('set-key').value.trim();
    if (key) body.apiKey = key;
    const res = await post('/api/settings', body);
    const data = await res.json();
    if (res.ok) {
      msg.textContent = '✓ Saved';
      msg.className = 'set-msg ok';
      $('set-key').value = '';
      loadSettings();
      setTimeout(() => els.settingsModal.classList.add('hidden'), 600);
    } else {
      msg.textContent = data.error || 'Failed to save.';
      msg.className = 'set-msg bad';
    }
  });

  // ---------- init ----------

  (async () => {
    try {
      const [settings, knownRes] = await Promise.all([
        loadSettings(),
        api('/api/known-words').then((r) => r.json()),
      ]);
      state.known = new Set(knownRes.words);
      if (!settings.hasKey) openSettings();
    } catch {
      showError('Could not reach the local Tradutor server.');
    }
  })();
})();
