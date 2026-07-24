/* Tradutor frontend — vanilla JS, no build step.
   Both panes are editable: type in either side and the translation renders
   in the other (direction is auto-detected by the model). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const sides = {};
  for (const side of ['left', 'right']) {
    sides[side] = {
      side,
      textarea: $('text-' + side),
      render: $('render-' + side),
      reveal: $('reveal-' + side),
      label: $('label-' + side),
      status: $('status-' + side),
      chips: $('chips-' + side),
      variants: $('variants-' + side),
      warn: $('warn-' + side),
    };
  }
  const other = (side) => (side === 'left' ? 'right' : 'left');

  const els = {
    errorBar: $('error-bar'),
    errorText: $('error-text'),
    tooltip: $('tooltip'),
    wordPanel: $('word-panel'),
    reviewPanel: $('review-panel'),
    settingsModal: $('settings-modal'),
    toggleBlur: $('toggle-blur'),
    toggleProgressive: $('toggle-progressive'),
    toggleCritique: $('toggle-critique'),
    askInput: $('ask-input'),
    askBtn: $('ask-btn'),
    askAnswer: $('ask-answer'),
  };

  const DEFAULT_LABELS = {
    left: 'Português / English <span class="dim">(auto)</span>',
    right: 'Translation <span class="dim">(or type here to reverse)</span>',
  };

  const state = {
    known: new Set(),
    source: 'left',       // which pane the current text was typed into
    result: null,
    historyId: null,
    pendingReveal: null,  // {historyId} while a blurred pt-en result awaits reveal
    annMap: new Map(),    // normalized word -> annotation object
    abort: null,
    askAbort: null,
    lastKey: '',          // dedupe key of the last request sent
    lastText: '',         // source text of the last request sent
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
    return fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  }
  function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body) });
  }

  // Read an NDJSON response, invoking onMsg per parsed line.
  async function readNdjson(res, onMsg) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { onMsg(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
    }
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

  // ---------- rendering ----------

  function clearExtras() {
    for (const side of ['left', 'right']) {
      sides[side].chips.innerHTML = '';
      sides[side].warn.innerHTML = '';
      sides[side].variants.innerHTML = '';
      sides[side].variants.classList.add('hidden');
    }
  }

  function setBlur(side, on) {
    for (const s of ['left', 'right']) {
      const P = sides[s];
      const active = on && s === side;
      P.render.classList.toggle('blurred', active);
      P.reveal.classList.toggle('hidden', !active);
    }
  }

  function renderResult() {
    const r = state.result;
    if (!r) return;
    clearExtras();

    if (r.mode === 'critique') {
      renderCritique(r);
      return;
    }

    const src = state.source;
    const tgt = other(src);
    const S = sides[src];
    const T = sides[tgt];
    const dir = r.direction;
    state.annMap = buildAnnMap(r.words);
    const ptSide = dir === 'pt-en' ? src : dir === 'en-pt' ? tgt : null;

    S.label.textContent = dir === 'pt-en' ? 'Português' : dir === 'en-pt' ? 'English' : 'Input';
    T.label.textContent = dir === 'pt-en' ? 'English' : dir === 'en-pt' ? 'Português' : 'Translation';

    // Target pane: translation in the textarea (copyable/editable), rendered view on top.
    T.textarea.value = r.translation || '';
    T.render.innerHTML = ptSide === tgt
      ? renderAnnotatedText(r.translation || '')
      : renderTranslationHtml(r.translation || '', r.ambiguities);
    T.render.classList.remove('hidden');

    // Source pane: annotated overlay when the source is Portuguese.
    if (ptSide === src) {
      S.render.innerHTML = renderAnnotatedText(S.textarea.value);
      S.render.classList.toggle('hidden', document.activeElement === S.textarea);
    } else {
      S.render.classList.add('hidden');
    }

    // Learning extras attach to the Portuguese pane.
    const P = ptSide ? sides[ptSide] : T;
    for (const e of r.expansions || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${e.from} → ${e.to}${e.meaning ? ` (${e.meaning})` : ''}`;
      P.chips.appendChild(chip);
    }
    for (const s of r.structures || []) {
      const chip = document.createElement('span');
      chip.className = 'chip struct';
      chip.textContent = `${s.text} — ${s.note}`;
      P.chips.appendChild(chip);
    }
    for (const f of r.false_friends || []) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.innerHTML = `⚠️ <b>${esc(f.word)}</b> looks like “${esc(f.looks_like)}” but means: ${esc(f.actually_means)}`;
      P.warn.appendChild(card);
    }
    if (r.register_variants && (r.register_variants.casual || r.register_variants.neutral)) {
      P.variants.classList.remove('hidden');
      for (const [tag, textv] of Object.entries(r.register_variants)) {
        if (!textv) continue;
        const div = document.createElement('div');
        div.className = 'variant';
        div.innerHTML = `<span class="tag">${esc(tag)}</span>${renderAnnotatedText(textv)}`;
        P.variants.appendChild(div);
      }
    }
    if (r.parse_failed) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.textContent = 'The model returned unstructured output this time — showing raw text without annotations.';
      T.warn.appendChild(card);
    }

    // Blur mechanic: English output of pt→en only.
    const shouldBlur = dir === 'pt-en' && prefs.blur;
    setBlur(tgt, shouldBlur);
    if (shouldBlur && state.historyId) {
      state.pendingReveal = { historyId: state.historyId };
    }
  }

  function renderCritique(r) {
    const T = sides[other(state.source)];
    T.label.textContent = 'Critique';
    state.annMap = buildAnnMap(r.words);
    setBlur(null, false);
    T.textarea.value = '';

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
    T.render.innerHTML = html;
    T.render.classList.remove('hidden');
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
    const src = state.source;
    const S = sides[src];
    const T = sides[other(src)];
    const text = S.textarea.value.trim();
    if (!text) return;

    const mode = prefs.critique ? 'critique' : 'translate';
    const dedupeKey = [src, mode, prefs.progressive ? 'p' : '', text].join('|');
    if (!force && dedupeKey === state.lastKey) return;

    // A blurred result the learner never revealed counts as understood — log dismiss.
    if (state.pendingReveal) {
      post('/api/log', { event: 'dismiss', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }

    if (state.abort) state.abort.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.lastKey = dedupeKey;
    state.lastText = text;
    state.result = null;
    state.historyId = null;
    state.annMap = new Map();
    hideError();
    clearExtras();
    setBlur(null, false);
    S.render.classList.add('hidden');
    T.textarea.value = '';
    T.render.textContent = '';
    T.render.classList.remove('hidden');
    T.status.textContent = '…';
    S.status.textContent = '';

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
        if (e.code === 'no_key') openSettings();
        showError(e.error || `Request failed (${res.status})`);
        T.status.textContent = '';
        return;
      }

      await readNdjson(res, (msg) => {
        if (msg.type === 'delta') {
          raw += msg.text;
          if (!blurArmed && mode === 'translate' && prefs.blur && partialDirection(raw) === 'pt-en') {
            blurArmed = true;
            setBlur(other(src), true);
          }
          const partial = partialTranslation(raw);
          if (partial !== null) T.render.textContent = partial;
        } else if (msg.type === 'done') {
          state.result = msg.result;
          state.historyId = msg.historyId;
          T.status.textContent = msg.cached ? 'cached' : '';
          renderResult();
        } else if (msg.type === 'error') {
          showError(msg.message);
          T.status.textContent = '';
        }
      });
      if (T.status.textContent === '…') T.status.textContent = '';
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError('Connection to the local server failed: ' + err.message);
      T.status.textContent = '';
    }
  }

  // ---------- pane events (both sides are inputs) ----------

  for (const side of ['left', 'right']) {
    const S = sides[side];

    S.textarea.addEventListener('input', () => {
      state.source = side;         // typing here makes this side the source
      S.render.classList.add('hidden');
      scheduleTranslate();
    });

    S.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        state.source = side;
        clearTimeout(debounceTimer);
        translate(true);
      }
    });

    // Re-show the rendered overlay when focus leaves an unchanged pane.
    S.textarea.addEventListener('blur', () => {
      const r = state.result;
      if (!r) return;
      if (side === state.source) {
        if (r.mode !== 'critique' && r.direction === 'pt-en' &&
            S.textarea.value.trim() === state.lastText) {
          S.render.innerHTML = renderAnnotatedText(S.textarea.value);
          S.render.classList.remove('hidden');
        }
      } else if (S.textarea.value === (r.translation || '')) {
        S.render.classList.remove('hidden');
      }
    });

    // Clicking the rendered view (not on a word) drops into the textarea to edit.
    S.render.addEventListener('click', (e) => {
      if (e.target.closest('.w') || e.target.closest('.amb')) return;
      S.render.classList.add('hidden');
      S.textarea.focus();
    });

    S.reveal.addEventListener('click', () => {
      setBlur(null, false);
      if (state.pendingReveal) {
        post('/api/log', { event: 'reveal', historyId: state.pendingReveal.historyId });
        state.pendingReveal = null;
      }
    });
  }

  // ---------- clear ----------

  function clearAll() {
    if (state.pendingReveal) {
      post('/api/log', { event: 'dismiss', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }
    if (state.abort) state.abort.abort();
    if (state.askAbort) state.askAbort.abort();
    clearTimeout(debounceTimer);
    state.result = null;
    state.historyId = null;
    state.annMap = new Map();
    state.lastKey = '';
    state.lastText = '';
    for (const side of ['left', 'right']) {
      const S = sides[side];
      S.textarea.value = '';
      S.render.innerHTML = '';
      S.render.classList.add('hidden');
      S.status.textContent = '';
      S.label.innerHTML = DEFAULT_LABELS[side];
    }
    setBlur(null, false);
    clearExtras();
    els.askInput.value = '';
    els.askAnswer.textContent = '';
    els.askAnswer.classList.add('hidden');
    hideError();
    state.source = 'left';
    sides.left.textarea.focus();
  }
  $('btn-clear').addEventListener('click', clearAll);

  // ---------- ask box ----------

  async function ask() {
    const question = els.askInput.value.trim();
    if (!question) return;
    const text = sides[state.source].textarea.value.trim();

    if (state.askAbort) state.askAbort.abort();
    const abort = new AbortController();
    state.askAbort = abort;

    els.askAnswer.classList.remove('hidden');
    els.askAnswer.textContent = '…';
    let answer = '';

    try {
      const res = await api('/api/ask', {
        method: 'POST',
        body: JSON.stringify({
          question,
          text,
          translation: state.result?.translation || '',
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.code === 'no_key') openSettings();
        els.askAnswer.classList.add('hidden');
        showError(e.error || `Request failed (${res.status})`);
        return;
      }

      await readNdjson(res, (msg) => {
        if (msg.type === 'delta') {
          answer += msg.text;
          els.askAnswer.textContent = answer;
        } else if (msg.type === 'error') {
          els.askAnswer.classList.add('hidden');
          showError(msg.message);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      els.askAnswer.classList.add('hidden');
      showError('Connection to the local server failed: ' + err.message);
    }
  }

  els.askBtn.addEventListener('click', ask);
  els.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ask();
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
    $('wp-known').parentElement.classList.remove('hidden');

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
    let res = await post('/api/known-words', { word: lemmaKey, known });
    state.known = new Set((await res.json()).words);
    if (lemmaKey !== pw.key) {
      res = await post('/api/known-words', { word: pw.key, known });
      state.known = new Set((await res.json()).words);
    }
    rerenderAnnotations();
  });

  function rerenderAnnotations() {
    if (!state.result) return;
    if (state.result.mode === 'critique') { renderCritique(state.result); return; }
    const blurredSide = ['left', 'right'].find((s) => sides[s].render.classList.contains('blurred'));
    renderResult();
    if (!blurredSide) setBlur(null, false);
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
      setBlur(null, false);
      state.pendingReveal = null;
    } else if (state.result?.direction === 'pt-en' && state.result.mode !== 'critique') {
      setBlur(other(state.source), true);
    }
  });
  els.toggleProgressive.addEventListener('change', (e) => {
    prefs.progressive = e.target.checked;
    state.lastKey = '';
    scheduleTranslate();
  });
  els.toggleCritique.addEventListener('change', (e) => {
    prefs.critique = e.target.checked;
    state.lastKey = '';
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
