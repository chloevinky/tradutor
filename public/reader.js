/* Tradutor — ebook reader page. Uses the shared helpers in window.T.
   Click a word to translate & save it; drag across several words to
   translate the phrase. Every lookup lands in the saved-words database. */
(() => {
  'use strict';
  const { $, esc, api, post, setStatus, showError, speakText } = window.T;

  const rd = {
    books: [],
    bookId: null,
    chapters: [],
    chapter: 0,
    loaded: false,
    posTimer: null,
    lastSelectionAt: 0,
    popupText: '',
  };

  const content = $('book-content');
  const list = $('book-list');
  const chapterSel = $('chapter-select');

  // ---------- library ----------

  async function refreshBooks() {
    const res = await api('/api/books');
    rd.books = (await res.json()).books || [];
    list.innerHTML = rd.books.length ? '' :
      '<div class="dim" style="padding:6px">Library is empty.<br>Use <b>Open ebook…</b> below.</div>';
    for (const b of rd.books) {
      const div = document.createElement('div');
      div.className = 'book-item' + (b.id === rd.bookId ? ' selected' : '');
      div.dataset.id = b.id;
      div.innerHTML = `<div class="bi-title">${esc(b.title)}</div>` +
        `<div class="bi-sub">${esc(b.author || b.format)} · ${b.chapterCount} ch</div>`;
      list.appendChild(div);
    }
  }

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.book-item');
    if (item) openBook(item.dataset.id);
  });

  $('btn-open-book').addEventListener('click', () => $('book-file').click());

  $('book-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    window.T.showPage('reader');
    setStatus(`Importing "${file.name}"…`);
    try {
      const res = await fetch('/api/books?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Could not read that file.'); return; }
      await refreshBooks();
      openBook(data.book.id);
      setStatus(`Imported "${data.book.title}" (${data.book.chapterCount} chapters).`);
    } catch (err) {
      showError('Upload failed: ' + err.message);
    }
  });

  $('btn-delete-book').addEventListener('click', async () => {
    if (!rd.bookId) { setStatus('Select a book first.'); return; }
    const book = rd.books.find((b) => b.id === rd.bookId);
    if (!confirm(`Remove "${book?.title}" from the library?`)) return;
    await api('/api/books/' + rd.bookId, { method: 'DELETE' });
    rd.bookId = null;
    rd.chapters = [];
    content.innerHTML = '<div class="dim book-empty">No book open.</div>';
    chapterSel.innerHTML = '';
    $('reader-legend').textContent = 'Reader';
    refreshBooks();
    setStatus('Book removed.');
  });

  // ---------- reading ----------

  async function openBook(id) {
    const res = await api('/api/books/' + id);
    if (!res.ok) { showError('Could not open that book.'); return; }
    const data = await res.json();
    rd.bookId = id;
    rd.chapters = data.chapters;
    $('reader-legend').textContent = data.book.title + (data.book.author ? ' — ' + data.book.author : '');

    chapterSel.innerHTML = '';
    rd.chapters.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i + 1}. ${c.title}`;
      chapterSel.appendChild(opt);
    });

    const pos = data.book.position || { chapter: 0, paragraph: 0 };
    renderChapter(Math.min(pos.chapter, rd.chapters.length - 1), pos.paragraph);
    refreshBooks();
  }

  function renderChapter(i, scrollToParagraph = 0) {
    if (!rd.chapters.length) return;
    rd.chapter = Math.max(0, Math.min(i, rd.chapters.length - 1));
    chapterSel.value = rd.chapter;
    const ch = rd.chapters[rd.chapter];
    let html = `<h2>${esc(ch.title)}</h2>`;
    ch.paragraphs.forEach((p, idx) => { html += `<p data-p="${idx}">${esc(p)}</p>`; });
    content.innerHTML = html;
    content.scrollTop = 0;
    if (scrollToParagraph > 0) {
      const p = content.querySelector(`p[data-p="${scrollToParagraph}"]`);
      if (p) p.scrollIntoView({ block: 'start' });
    }
    savePositionSoon();
  }

  chapterSel.addEventListener('change', () => renderChapter(Number(chapterSel.value)));
  $('btn-prev-ch').addEventListener('click', () => renderChapter(rd.chapter - 1));
  $('btn-next-ch').addEventListener('click', () => renderChapter(rd.chapter + 1));

  function firstVisibleParagraph() {
    const top = content.getBoundingClientRect().top;
    for (const p of content.querySelectorAll('p[data-p]')) {
      if (p.getBoundingClientRect().bottom > top + 4) return Number(p.dataset.p);
    }
    return 0;
  }

  function savePositionSoon() {
    if (!rd.bookId) return;
    clearTimeout(rd.posTimer);
    rd.posTimer = setTimeout(() => {
      post(`/api/books/${rd.bookId}/position`, {
        chapter: rd.chapter,
        paragraph: firstVisibleParagraph(),
      });
    }, 800);
  }
  content.addEventListener('scroll', savePositionSoon);

  // ---------- word / phrase lookup ----------

  const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

  function wordAtPoint(x, y) {
    let node, offset;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer;
      offset = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode;
      offset = p.offset;
    } else return null;

    if (node.nodeType !== Node.TEXT_NODE || !content.contains(node)) return null;
    const text = node.textContent;
    if (!text || offset >= text.length || !WORD_CHAR.test(text[offset] || '')) {
      if (offset > 0 && WORD_CHAR.test(text[offset - 1] || '')) offset -= 1;
      else return null;
    }
    let a = offset, b = offset;
    while (a > 0 && WORD_CHAR.test(text[a - 1])) a--;
    while (b < text.length && WORD_CHAR.test(text[b])) b++;
    const word = text.slice(a, b).replace(/^['’-]+|['’-]+$/g, '');
    if (!word) return null;

    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    return { word, rect: range.getBoundingClientRect(), paragraph: text, index: a };
  }

  // The sentence around `index` within the paragraph — context for the model & card.
  function sentenceAround(paragraph, index) {
    const enders = /[.!?…]/;
    let start = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (enders.test(paragraph[i])) { start = i + 1; break; }
    }
    let end = paragraph.length;
    for (let i = index; i < paragraph.length; i++) {
      if (enders.test(paragraph[i])) { end = i + 1; break; }
    }
    return paragraph.slice(start, end).trim().slice(0, 320);
  }

  content.addEventListener('mouseup', () => {
    // Drag-selection across several words → translate the phrase.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return;
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2 || text.length > 300) return;
      rd.lastSelectionAt = Date.now();
      const para = range.startContainer.textContent || '';
      const context = para.replace(/\s+/g, ' ').trim().slice(0, 320);
      lookup(text, context, sel.getRangeAt(0).getBoundingClientRect());
    }, 0);
  });

  content.addEventListener('click', (e) => {
    if (Date.now() - rd.lastSelectionAt < 400) return; // this click ended a drag
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = wordAtPoint(e.clientX, e.clientY);
    if (!hit) return;
    lookup(hit.word, sentenceAround(hit.paragraph, hit.index), hit.rect);
  });

  const pop = $('lookup-pop');

  function placePopup(rect) {
    pop.classList.remove('hidden');
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || 120;
    let x = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 8);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
  }

  async function lookup(text, context, rect) {
    rd.popupText = text;
    $('lp-pt').textContent = text;
    $('lp-en').innerHTML = '<span class="dim">translating…</span>';
    $('lp-note').textContent = '';
    $('lp-saved').textContent = '';
    placePopup(rect);
    setStatus(`Looking up "${text}"…`);
    try {
      const res = await post('/api/lookup', { text, context, bookId: rd.bookId });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'no_key') window.T.openSettings();
        $('lp-en').innerHTML = `<span class="dim">${esc(data.error || 'Lookup failed.')}</span>`;
        return;
      }
      const r = data.result;
      rd.popupText = r.pt || text;
      $('lp-pt').textContent = r.pt || text;
      $('lp-en').textContent = r.en || '';
      $('lp-note').textContent = [r.lemma && r.lemma !== r.pt ? `lemma: ${r.lemma}` : '', r.literal ? `literally: ${r.literal}` : '', r.note || '']
        .filter(Boolean).join(' · ');
      $('lp-saved').textContent = data.entry
        ? `✓ saved${data.entry.count > 1 ? ` (seen ${data.entry.count}×)` : ''}` : '';
      setStatus(`Saved "${r.pt || text}" to your review list.`);
      window.T.review?.markStale?.();
    } catch (err) {
      $('lp-en').innerHTML = `<span class="dim">${esc('Server unreachable: ' + err.message)}</span>`;
    }
  }

  $('lp-close').addEventListener('click', () => pop.classList.add('hidden'));
  $('lp-speak').addEventListener('click', () => speakText(rd.popupText));
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#lookup-pop') && !e.target.closest('#book-content')) {
      pop.classList.add('hidden');
    }
  });

  // ---------- page lifecycle ----------

  window.T.reader = {
    onShow() {
      if (!rd.loaded) {
        rd.loaded = true;
        refreshBooks().then(() => {
          // Reopen the most recently added book automatically.
          if (!rd.bookId && rd.books.length) openBook(rd.books[rd.books.length - 1].id);
        });
      }
    },
  };
})();
