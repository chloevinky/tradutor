/* Tradutor — review & export page. Saved words/phrases table, per-card TTS
   audio, and Anki sync via AnkiConnect. Uses the shared helpers in window.T. */
(() => {
  'use strict';
  const { $, esc, api, post, setStatus, showError, playUrl } = window.T;

  const rv = { entries: [], stale: true, busy: false };

  const body = $('saved-body');
  const msg = $('review-msg');

  function say(text, cls) {
    msg.textContent = text;
    msg.className = 'review-msg' + (cls ? ' ' + cls : '');
  }

  const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // ---------- table ----------

  async function refresh() {
    const [savedRes, reviewRes] = await Promise.all([api('/api/saved'), api('/api/review')]);
    rv.entries = (await savedRes.json()).entries || [];
    rv.stale = false;

    body.innerHTML = '';
    if (!rv.entries.length) {
      body.innerHTML = '<tr><td colspan="8" class="dim" style="padding:10px">Nothing saved yet — open a book in the Reader tab and click words you don\'t know.</td></tr>';
    }
    for (const e of rv.entries) {
      const tr = document.createElement('tr');
      tr.dataset.id = e.id;
      tr.innerHTML =
        `<td class="td-pt" title="${esc(e.pt)}">${esc(e.pt)}</td>` +
        `<td>${esc(e.en)}</td>` +
        `<td class="td-note">${esc(e.note || '')}</td>` +
        `<td class="td-ctx" title="${esc(e.context || '')}">${esc((e.context || '').slice(0, 80))}</td>` +
        `<td class="td-ctx">${esc(e.bookTitle || '—')} · ${fmtDate(e.ts)}</td>` +
        `<td>${e.count > 1 ? e.count + '×' : ''}</td>` +
        `<td><button class="icon-btn" data-act="audio" title="${e.audio ? 'Play pt-BR audio' : 'Generate & play pt-BR audio'}">${e.audio ? '▶' : '♪'}</button></td>` +
        `<td><button class="icon-btn" data-act="del" title="Delete">✕</button></td>`;
      body.appendChild(tr);
    }

    // Old-style translator review: most looked-up words.
    const data = await reviewRes.json();
    const wordsEl = $('review-words');
    wordsEl.innerHTML = data.words.length ? '' : '<div class="dim">Nothing yet — click words in the translator to look them up.</div>';
    for (const w of data.words) {
      const row = document.createElement('div');
      row.className = 'review-word';
      row.innerHTML = `<span class="rw-word">${esc(w.word)}</span>` +
        `<span class="rw-gloss">${esc(w.gloss)}</span>` +
        `<span class="rw-count">×${w.count}</span>` +
        `<button class="btn btn-small" data-know="${esc(w.word)}">know it</button>`;
      wordsEl.appendChild(row);
    }
  }

  async function generateAudio(id) {
    const res = await post(`/api/saved/${id}/audio`, {});
    const data = await res.json();
    if (!res.ok) {
      if (data.code === 'no_openai_key') window.T.openSettings();
      throw new Error(data.error || 'Audio generation failed.');
    }
    return data.audio;
  }

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('.icon-btn');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const entry = rv.entries.find((x) => x.id === id);
    if (!entry) return;

    if (btn.dataset.act === 'del') {
      await api('/api/saved/' + id, { method: 'DELETE' });
      tr.remove();
      rv.entries = rv.entries.filter((x) => x.id !== id);
      setStatus(`Deleted "${entry.pt}".`);
      return;
    }
    if (btn.dataset.act === 'audio') {
      try {
        if (entry.audio) {
          playUrl('/api/audio/' + entry.audio);
        } else {
          btn.textContent = '…';
          const url = await generateAudio(id);
          entry.audio = url.split('/').pop();
          btn.textContent = '▶';
          playUrl(url);
        }
      } catch (err) {
        btn.textContent = '♪';
        showError(err.message);
      }
    }
  });

  $('review-words').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-know]');
    if (!btn) return;
    const res = await post('/api/known-words', { word: btn.dataset.know, known: true });
    window.T.state.known = new Set((await res.json()).words);
    btn.closest('.review-word').remove();
    window.T.rerenderAnnotations();
  });

  // ---------- audio batch + Anki export ----------

  $('btn-gen-audio').addEventListener('click', async () => {
    if (rv.busy) return;
    const missing = rv.entries.filter((e) => !e.audio);
    if (!missing.length) { say('Every saved entry already has audio.', 'ok'); return; }
    rv.busy = true;
    let done = 0;
    try {
      for (const e of missing) {
        say(`Generating audio ${done + 1}/${missing.length} — "${e.pt}"…`);
        const url = await generateAudio(e.id);
        e.audio = url.split('/').pop();
        done++;
      }
      say(`✓ Generated ${done} audio clip${done === 1 ? '' : 's'}.`, 'ok');
      refresh();
    } catch (err) {
      say(`Stopped after ${done}: ${err.message}`, 'bad');
    } finally {
      rv.busy = false;
    }
  });

  async function exportAnki() {
    if (rv.busy) return;
    if (rv.stale) await refresh();
    if (!rv.entries.length) { say('Nothing to export yet.', 'bad'); return; }
    rv.busy = true;
    const withAudio = $('anki-audio').checked;
    say(withAudio ? 'Generating audio & syncing to Anki… (keep Anki open)' : 'Syncing to Anki… (keep Anki open)');
    setStatus('Syncing with Anki…');
    try {
      const res = await post('/api/anki/export', { withAudio });
      const data = await res.json();
      if (!res.ok) {
        say(data.error || 'Anki sync failed.', 'bad');
        return;
      }
      const bits = [`✓ Deck "${data.deck}": ${data.added} added, ${data.updated} updated`];
      if (data.audioGenerated) bits.push(`${data.audioGenerated} audio clips generated`);
      if (data.errors?.length) bits.push(`${data.errors.length} card errors`);
      if (data.audioErrors?.length) bits.push(`${data.audioErrors.length} audio errors`);
      say(bits.join(' · '), data.errors?.length || data.audioErrors?.length ? 'bad' : 'ok');
      setStatus('Anki sync finished.');
      if (data.errors?.length || data.audioErrors?.length) {
        console.warn('Anki export issues', data.errors, data.audioErrors);
      }
      refresh();
    } catch (err) {
      say('Server unreachable: ' + err.message, 'bad');
    } finally {
      rv.busy = false;
    }
  }
  $('btn-anki-export').addEventListener('click', exportAnki);

  // ---------- page lifecycle ----------

  window.T.review = {
    onShow() { if (rv.stale) refresh(); },
    markStale() { rv.stale = true; },
    exportAnki,
  };
})();
