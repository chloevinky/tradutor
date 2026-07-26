// AnkiConnect client (https://foosoft.net/projects/anki-connect/).
// Talks to the Anki desktop app on localhost:8765; Anki must be running with
// the AnkiConnect add-on (code 2055492159) installed.
import fs from 'fs';
import path from 'path';
import { AUDIO_DIR } from './store.js';

const ANKI_URL = process.env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765';

export async function anki(action, params = {}) {
  let res;
  try {
    res = await fetch(ANKI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch {
    const err = new Error('Could not reach Anki. Start the Anki desktop app (with the AnkiConnect add-on installed) and try again.');
    err.code = 'anki_unreachable';
    throw err;
  }
  const data = await res.json();
  if (data.error) throw new Error(`AnkiConnect: ${data.error}`);
  return data.result;
}

const stripSound = (s) => String(s || '').replace(/\[sound:[^\]]*\]/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Push saved entries into a deck: Basic notes, Front = pt-BR (+ audio),
// Back = English (+ context). Existing notes (matched on their pt-BR text)
// are updated in place, so re-exporting is always safe.
export async function exportEntries({ deck, entries }) {
  await anki('createDeck', { deck });

  // Map of existing notes in the deck, keyed by their Front text minus markup.
  const noteIds = await anki('findNotes', { query: `deck:"${deck.replace(/"/g, '\\"')}"` });
  const existing = new Map();
  if (noteIds.length) {
    const infos = await anki('notesInfo', { notes: noteIds });
    for (const info of infos) {
      const front = stripSound(info.fields?.Front?.value);
      if (front) existing.set(front.toLowerCase(), info.noteId);
    }
  }

  let added = 0, updated = 0;
  const errors = [];

  for (const e of entries) {
    try {
      let soundTag = '';
      if (e.audio) {
        const file = path.join(AUDIO_DIR, e.audio);
        if (fs.existsSync(file)) {
          const mediaName = `tradutor-${e.id}.mp3`;
          await anki('storeMediaFile', {
            filename: mediaName,
            data: fs.readFileSync(file).toString('base64'),
          });
          soundTag = `[sound:${mediaName}]`;
        }
      }
      const front = esc(e.pt) + (soundTag ? `<br>${soundTag}` : '');
      const back = esc(e.en)
        + (e.note ? `<br><span style="font-size:80%">${esc(e.note)}</span>` : '')
        + (e.context ? `<br><i style="font-size:80%;color:#555">${esc(e.context)}</i>` : '');

      const noteId = existing.get(stripSound(esc(e.pt)).toLowerCase());
      if (noteId) {
        await anki('updateNoteFields', { note: { id: noteId, fields: { Front: front, Back: back } } });
        updated++;
      } else {
        await anki('addNote', {
          note: {
            deckName: deck,
            modelName: 'Basic',
            fields: { Front: front, Back: back },
            options: { allowDuplicate: false, duplicateScope: 'deck' },
            tags: ['tradutor'],
          },
        });
        added++;
      }
    } catch (err) {
      if (err.code === 'anki_unreachable') throw err;
      errors.push(`"${e.pt}": ${err.message}`);
    }
  }
  return { added, updated, errors };
}
