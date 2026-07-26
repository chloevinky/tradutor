/* Tradutor frontend — vanilla JS, no build step.
   app.js: window chrome (menus, toolbar, tabs, status bar), settings dialog,
   the translator page, word panel + tooltip. reader.js and review.js build on
   the shared helpers exposed as window.T. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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

  // ---------- state & prefs ----------

  const state = {
    known: new Set(),
    result: null,
    historyId: null,
    pendingReveal: null,
    annMap: new Map(),
    abort: null,
    askAbort: null,
    lastText: '',        // input text of the last completed request
    panelWord: null,
    settings: null,
  };

  const prefs = {
    get blur() { return localStorage.getItem('blur') !== '0'; },
    set blur(v) { localStorage.setItem('blur', v ? '1' : '0'); },
    get progressive() { return localStorage.getItem('progressive') === '1'; },
    set progressive(v) { localStorage.setItem('progressive', v ? '1' : '0'); },
    get critique() { return localStorage.getItem('critique') === '1'; },
    set critique(v) { localStorage.setItem('critique', v ? '1' : '0'); },
  };

  // ---------- status bar / error strip ----------

  function setStatus(msg) { $('status-main').textContent = msg || 'Ready.'; }

  function showError(msg) {
    $('error-text').textContent = msg;
    $('error-bar').classList.remove('hidden');
    setStatus('Error.');
  }
  function hideError() { $('error-bar').classList.add('hidden'); }
  $('btn-error-close').addEventListener('click', hideError);
  $('btn-retry').addEventListener('click', () => { hideError(); translate(); });

  // ---------- menu bar ----------

  const menubar = $('menubar');
  let menuOpen = false;

  function closeMenus() {
    menuOpen = false;
    for (const m of menubar.querySelectorAll('.menu')) m.classList.remove('open');
  }
  function openMenu(menu) {
    closeMenus();
    menuOpen = true;
    menu.classList.add('open');
  }
  for (const menu of menubar.querySelectorAll('.menu')) {
    const title = menu.querySelector('.menu-title');
    title.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (menu.classList.contains('open')) closeMenus();
      else openMenu(menu);
    });
    title.addEventListener('mouseenter', () => { if (menuOpen) openMenu(menu); });
  }
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  function syncMenuChecks() {
    const set = (cmd, on) => {
      const mi = menubar.querySelector(`[data-cmd="${cmd}"]`);
      if (mi) mi.classList.toggle('checked', on);
    };
    set('toggle-blur', prefs.blur);
    set('toggle-progressive', prefs.progressive);
    set('toggle-critique', prefs.critique);
  }

  menubar.addEventListener('click', (e) => {
    const mi = e.target.closest('.mi');
    if (!mi) return;
    closeMenus();
    runCommand(mi.dataset.cmd);
  });

  function runCommand(cmd) {
    switch (cmd) {
      case 'open-book': $('book-file').click(); break;
      case 'export-tsv': window.location.href = '/api/export/anki'; break;
      case 'anki-export': showPage('review'); window.T.review?.exportAnki?.(); break;
      case 'settings': openSettings(); break;
      case 'translate': translate(); break;
      case 'clear': clearAll(); break;
      case 'copy-translation': copyTranslation(); break;
      case 'toggle-blur':
        prefs.blur = !prefs.blur;
        syncMenuChecks();
        if (!prefs.blur) { setBlur(false); state.pendingReveal = null; }
        else if (state.result?.direction === 'pt-en' && state.result.mode !== 'critique') setBlur(true);
        break;
      case 'toggle-progressive':
        prefs.progressive = !prefs.progressive;
        syncMenuChecks();
        setStatus('Progressive mode ' + (prefs.progressive ? 'on' : 'off') + ' — press Translate to re-run.');
        break;
      case 'toggle-critique':
        prefs.critique = !prefs.critique;
        syncMenuChecks();
        setStatus('Critique mode ' + (prefs.critique ? 'on' : 'off') + ' — press Translate to re-run.');
        break;
      case 'about': $('about-modal').classList.remove('hidden'); break;
    }
  }

  $('about-close').addEventListener('click', () => $('about-modal').classList.add('hidden'));
  $('about-close-x').addEventListener('click', () => $('about-modal').classList.add('hidden'));

  // ---------- toolbar ----------

  $('tb-translate').addEventListener('click', () => translate());
  $('tb-speak').addEventListener('click', () => speakCurrent());
  $('tb-clear').addEventListener('click', clearAll);
  $('tb-open').addEventListener('click', () => $('book-file').click());
  $('tb-anki').addEventListener('click', () => { showPage('review'); window.T.review?.exportAnki?.(); });
  $('tb-settings').addEventListener('click', openSettings);

  // ---------- notebook tabs ----------

  function showPage(name) {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab.dataset.page === name);
    }
    for (const page of document.querySelectorAll('.page')) {
      page.classList.toggle('hidden', page.id !== 'page-' + name);
    }
    if (name === 'reader') window.T.reader?.onShow?.();
    if (name === 'review') window.T.review?.onShow?.();
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showPage(tab.dataset.page));
  }

  // ---------- global shortcuts ----------

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translate();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      clearAll();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      $('book-file').click();
    }
  });

  // ---------- audio (shared) ----------

  let audioEl = null;
  function playUrl(url) {
    if (audioEl) audioEl.pause();
    audioEl = new Audio(url);
    audioEl.play().catch(() => showError('Could not play audio.'));
  }

  async function speakText(text) {
    const t = String(text || '').trim();
    if (!t) { setStatus('Nothing to speak.'); return; }
    setStatus('Generating speech…');
    try {
      const res = await post('/api/speak', { text: t });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.code === 'no_openai_key') openSettings();
        showError(e.error || `Speech failed (${res.status})`);
        return;
      }
      playUrl(URL.createObjectURL(await res.blob()));
      setStatus('Speaking…');
    } catch (err) {
      showError('Connection to the local server failed: ' + err.message);
    }
  }

  // The Portuguese side of the current translator pair.
  function currentPortuguese() {
    const r = state.result;
    if (r && r.mode !== 'critique') {
      if (r.direction === 'en-pt') return r.translation || '';
      if (r.direction === 'pt-en') return state.lastText;
    }
    if (r && r.mode === 'critique') return r.natural || r.corrected || state.lastText;
    return $('input-text').value.trim();
  }
  function speakCurrent() { speakText(currentPortuguese()); }

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

  // ---------- translator rendering ----------

  const out = $('output');

  function clearExtras() {
    $('chips').innerHTML = '';
    $('variants').innerHTML = '';
    $('variants').classList.add('hidden');
    $('warns').innerHTML = '';
    $('out-note').textContent = '';
  }

  function setBlur(on) {
    out.classList.toggle('blurred', on);
    $('reveal-overlay').classList.toggle('hidden', !on);
  }

  $('reveal-overlay').addEventListener('click', () => {
    setBlur(false);
    if (state.pendingReveal) {
      post('/api/log', { event: 'reveal', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }
  });

  function renderResult() {
    const r = state.result;
    if (!r) return;
    clearExtras();
    state.annMap = buildAnnMap(r.words);

    if (r.mode === 'critique') { renderCritique(r); return; }

    let html;
    if (r.direction === 'en-pt') {
      html = renderAnnotatedText(r.translation || '');
    } else {
      html = renderTranslationHtml(r.translation || '', r.ambiguities);
      // Annotated copy of the Portuguese source, so words stay clickable
      // without the input box ever being touched.
      if (r.direction === 'pt-en' && state.lastText) {
        html += '<span class="out-sep"></span><span class="out-sep-label">vocabulário — hover/click the words</span>\n'
          + renderAnnotatedText(state.lastText);
      }
    }
    out.innerHTML = html;

    const chips = $('chips');
    for (const e of r.expansions || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${e.from} → ${e.to}${e.meaning ? ` (${e.meaning})` : ''}`;
      chips.appendChild(chip);
    }
    for (const s of r.structures || []) {
      const chip = document.createElement('span');
      chip.className = 'chip struct';
      chip.textContent = `${s.text} — ${s.note}`;
      chips.appendChild(chip);
    }
    const warns = $('warns');
    for (const f of r.false_friends || []) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.innerHTML = `⚠️ <b>${esc(f.word)}</b> looks like “${esc(f.looks_like)}” but means: ${esc(f.actually_means)}`;
      warns.appendChild(card);
    }
    if (r.register_variants && (r.register_variants.casual || r.register_variants.neutral)) {
      const variants = $('variants');
      variants.classList.remove('hidden');
      for (const [tag, textv] of Object.entries(r.register_variants)) {
        if (!textv) continue;
        const div = document.createElement('div');
        div.className = 'variant';
        div.innerHTML = `<span class="tag">${esc(tag)}</span>${renderAnnotatedText(textv)}`;
        variants.appendChild(div);
      }
    }
    if (r.parse_failed) {
      const card = document.createElement('div');
      card.className = 'warn-card';
      card.textContent = 'The model returned unstructured output this time — showing raw text without annotations.';
      warns.appendChild(card);
    }

    const shouldBlur = r.direction === 'pt-en' && prefs.blur;
    setBlur(shouldBlur);
    if (shouldBlur && state.historyId) state.pendingReveal = { historyId: state.historyId };
  }

  function renderCritique(r) {
    setBlur(false);
    let html = '<div class="critique">';
    html += `<div class="verdict ${r.grammatical ? 'ok' : 'bad'}">${r.grammatical ? '✓ grammatical' : '✗ has issues'}</div>`;
    if (r.issues && r.issues.length) {
      html += '<div>';
      for (const it of r.issues) {
        html += `<div class="issue"><del>${esc(it.got)}</del> → <ins>${esc(it.should)}</ins><span class="note">${esc(it.note)}</span></div>`;
      }
      html += '</div>';
      html += `<div><div class="block-label">corrected</div><div>${renderAnnotatedText(r.corrected || '')}</div></div>`;
    } else if (r.grammatical === true) {
      html += '<div class="dim">No corrections needed.</div>';
    }
    html += `<div><div class="block-label">a Brazilian would more likely say ${r.register ? `· <span class="chip">${esc(r.register)}</span>` : ''}</div>` +
      `<div>${renderAnnotatedText(r.natural || '')}</div>` +
      (r.why_natural ? `<div class="dim">${esc(r.why_natural)}</div>` : '') + '</div>';
    html += '</div>';
    out.innerHTML = html;
  }

  // ---------- translate (manual: button / Ctrl+Enter only) ----------

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

  async function translate() {
    const text = $('input-text').value.trim();
    if (!text) { setStatus('Type something first.'); return; }
    const mode = prefs.critique ? 'critique' : 'translate';

    if (state.pendingReveal) {
      post('/api/log', { event: 'dismiss', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }
    if (state.abort) state.abort.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.result = null;
    state.historyId = null;
    state.annMap = new Map();
    hideError();
    clearExtras();
    setBlur(false);
    out.textContent = '…';
    setStatus(mode === 'critique' ? 'Critiquing…' : 'Translating…');

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
        out.innerHTML = '<span class="dim">The translation appears here.</span>';
        return;
      }

      await readNdjson(res, (msg) => {
        if (msg.type === 'delta') {
          raw += msg.text;
          if (!blurArmed && mode === 'translate' && prefs.blur && partialDirection(raw) === 'pt-en') {
            blurArmed = true;
            setBlur(true);
          }
          const partial = partialTranslation(raw);
          if (partial !== null) out.textContent = partial;
        } else if (msg.type === 'done') {
          state.result = msg.result;
          state.historyId = msg.historyId;
          state.lastText = text;
          renderResult();
          setStatus(msg.cached ? 'Done (from local cache — no API cost).' : 'Done.');
        } else if (msg.type === 'error') {
          showError(msg.message);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError('Connection to the local server failed: ' + err.message);
    }
  }

  $('btn-translate').addEventListener('click', () => translate());
  $('btn-speak').addEventListener('click', () => speakCurrent());
  $('btn-copy').addEventListener('click', copyTranslation);

  function copyTranslation() {
    const t = state.result?.translation || '';
    if (!t) { setStatus('Nothing to copy yet.'); return; }
    navigator.clipboard.writeText(t).then(
      () => setStatus('Translation copied to clipboard.'),
      () => setStatus('Could not access the clipboard.')
    );
  }

  // ---------- clear (the ONLY thing that empties the input) ----------

  function clearAll() {
    if (state.pendingReveal) {
      post('/api/log', { event: 'dismiss', historyId: state.pendingReveal.historyId });
      state.pendingReveal = null;
    }
    if (state.abort) state.abort.abort();
    if (state.askAbort) state.askAbort.abort();
    state.result = null;
    state.historyId = null;
    state.annMap = new Map();
    state.lastText = '';
    $('input-text').value = '';
    out.innerHTML = '<span class="dim">The translation appears here.</span>';
    setBlur(false);
    clearExtras();
    $('ask-input').value = '';
    $('ask-answer').textContent = '';
    $('ask-answer').classList.add('hidden');
    hideError();
    setStatus('Cleared.');
    $('input-text').focus();
  }
  $('btn-clear').addEventListener('click', clearAll);

  // ---------- ask box ----------

  async function ask() {
    const question = $('ask-input').value.trim();
    if (!question) return;
    const askAnswer = $('ask-answer');

    if (state.askAbort) state.askAbort.abort();
    const abort = new AbortController();
    state.askAbort = abort;

    askAnswer.classList.remove('hidden');
    askAnswer.textContent = '…';
    let answer = '';

    try {
      const res = await api('/api/ask', {
        method: 'POST',
        body: JSON.stringify({
          question,
          text: $('input-text').value.trim(),
          translation: state.result?.translation || '',
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.code === 'no_key') openSettings();
        askAnswer.classList.add('hidden');
        showError(e.error || `Request failed (${res.status})`);
        return;
      }

      await readNdjson(res, (msg) => {
        if (msg.type === 'delta') {
          answer += msg.text;
          askAnswer.textContent = answer;
        } else if (msg.type === 'error') {
          askAnswer.classList.add('hidden');
          showError(msg.message);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      askAnswer.classList.add('hidden');
      showError('Connection to the local server failed: ' + err.message);
    }
  }

  $('ask-btn').addEventListener('click', ask);
  $('ask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ask(); }
  });

  // ---------- tooltip ----------

  document.addEventListener('mouseover', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    const ann = annFor(w.dataset.key);
    if (!ann) return;
    const tooltip = $('tooltip');
    tooltip.innerHTML = `${esc(ann.gloss || '')}` +
      (ann.morphology ? `<span class="tt-morph">${esc(ann.morphology)}</span>` : '');
    tooltip.classList.remove('hidden');
    const rect = w.getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.w')) $('tooltip').classList.add('hidden');
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

    $('word-panel').classList.remove('hidden');
    post('/api/log', { event: 'lookup', word: lemmaKey, gloss: ann?.gloss || '' });
  }

  $('wp-close').addEventListener('click', () => $('word-panel').classList.add('hidden'));

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
    const wasBlurred = out.classList.contains('blurred');
    renderResult();
    if (!wasBlurred) setBlur(false);
  }

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
        $('word-panel').classList.remove('hidden');
        return;
      }
    }
    if (!e.target.closest('#word-panel')) {
      $('word-panel').classList.add('hidden');
      $('wp-known').parentElement.classList.remove('hidden');
    }
  });

  // ---------- settings dialog ----------

  async function loadSettings() {
    const res = await api('/api/settings');
    const s = await res.json();
    state.settings = s;
    $('set-model').value = s.model;
    $('set-key-hint').textContent = s.hasKey ? `Current key: ${s.keyHint}` : 'No key configured yet.';
    $('set-openai-hint').textContent = s.hasOpenaiKey ? `Current key: ${s.openaiHint}` : 'No key yet — speech & card audio disabled.';
    $('set-deck').value = s.ankiDeck || '';
    const voiceSel = $('set-voice');
    voiceSel.innerHTML = '';
    for (const v of s.ttsVoices || ['coral']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === s.ttsVoice) opt.selected = true;
      voiceSel.appendChild(opt);
    }
    $('status-model').textContent = s.model;
    $('status-deck').textContent = 'Deck: ' + (s.ankiDeck || '—');
    return s;
  }

  function openSettings() {
    loadSettings();
    $('set-msg').textContent = '';
    $('set-msg').className = 'set-msg';
    $('settings-modal').classList.remove('hidden');
  }
  function closeSettings() { $('settings-modal').classList.add('hidden'); }

  $('set-cancel').addEventListener('click', closeSettings);
  $('set-cancel-x').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', async () => {
    const msg = $('set-msg');
    msg.textContent = 'Checking & saving…';
    msg.className = 'set-msg';
    const body = {
      model: $('set-model').value.trim(),
      ttsVoice: $('set-voice').value,
      ankiDeck: $('set-deck').value.trim(),
    };
    const key = $('set-key').value.trim();
    if (key) body.apiKey = key;
    const openaiKey = $('set-openai').value.trim();
    if (openaiKey) body.openaiKey = openaiKey;
    const res = await post('/api/settings', body);
    const data = await res.json();
    if (res.ok) {
      msg.textContent = '✓ Saved';
      msg.className = 'set-msg ok';
      $('set-key').value = '';
      $('set-openai').value = '';
      loadSettings();
      setTimeout(closeSettings, 500);
    } else {
      msg.textContent = data.error || 'Failed to save.';
      msg.className = 'set-msg bad';
    }
  });

  // ---------- shared namespace for reader.js / review.js ----------

  window.T = {
    $, esc, api, post, setStatus, showError, hideError,
    playUrl, speakText, openSettings, showPage,
    state, normWord, rerenderAnnotations,
    reader: null, review: null,
  };

  // ---------- init ----------

  syncMenuChecks();
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
