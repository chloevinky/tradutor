# Tradutor 🇧🇷 ↔ 🇬🇧

A local Brazilian-Portuguese ↔ English translator built for **learning**, not just
translating. Made for an English speaker learning informal Brazilian Portuguese — the
register of chat, Discord and WhatsApp (`vc`, `pq`, `tbm`, `kkkk`…). Translations are
powered by the Anthropic API (`claude-opus-4-8` by default) and streamed token-by-token
into a page you keep bookmarked at **http://localhost:4747**.

The UI is a deliberate throwback to early-2000s desktop software (GTK2/KDE3 era):
menu bar, icon toolbar, notebook tabs, bevelled buttons and a status bar.

## The three tabs

### Translator

- **One text box, one output box.** Type or paste into the text box, press
  **Ctrl+Enter** or the **Translate** button. Nothing translates automatically, and
  nothing ever empties the text box except the **Clear** button — the text stays
  editable after every translation.
- **Word-level hover gloss + click-for-morphology** — every Portuguese word (in the
  output, or in the annotated *vocabulário* copy shown under a PT→EN translation) is
  interactive: hover for the in-context gloss, click for lemma, tense/mood/person,
  conjugation table, gender/collocations.
- **Internet-Portuguese normalization** — chat abbreviations expanded inline
  (`vc → você`, `tô → estou`, `kkkk → laughter`).
- **Options menu:** *Blur reveal* (PT→EN output arrives blurred; click to reveal —
  reveals feed your review list), *Progressive mode* (known words stay untranslated
  inside the English), *Critique mode* (corrections + "a Brazilian would more likely
  say…" for Portuguese you wrote yourself).
- **Ambiguity flags, false-friend & structure warnings, register variants** for EN→PT.
- **Ask box** — follow-up questions about the current translation.
- **🔊 Speak** — reads the Portuguese side aloud in pt-BR (OpenAI TTS; set an OpenAI
  key in Settings).

### Reader

- **Open ebooks**: EPUB, MOBI (non-DRM), FB2, HTML and TXT. Files are parsed locally
  into a library (`data/books/`); reading position is remembered per book.
- **Click a word** → it's translated in context and **saved to the database**.
  **Drag across several words** → the phrase is translated and saved. A little
  dictionary popup shows the translation, lemma/literal reading and a teaching note,
  with a 🔊 button to hear it.

### Review & Export

- Table of every saved word/phrase: Portuguese, English, note, the sentence it came
  from, source book, lookup count, per-row audio (▶/♪) and delete.
- **Sync to Anki** — creates or updates the deck (name in Settings) via
  **AnkiConnect**: front = pt-BR (+ audio), back = English (+ note + context).
  Re-syncing updates existing cards instead of duplicating them. Requires the Anki
  desktop app running with the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159)
  (add-on code `2055492159`).
- **attach TTS audio** — generates pt-BR speech for cards that don't have it yet and
  attaches it to the card front (needs an OpenAI key).
- **Export TSV file…** — the old file-based Anki import still works too.

## Setup

Requires [Node.js](https://nodejs.org) 18+.

```
git clone <this repo>
cd tradutor
npm install
npm start
```

Open **http://localhost:4747**. On first launch you'll be prompted for your Anthropic
API key (get one at https://console.anthropic.com). Optionally add an **OpenAI API
key** in the same Settings dialog to enable pt-BR speech and Anki card audio, pick a
TTS voice, and set the Anki deck name.

Repeated translations and lookups are served from a local cache (no API cost).

## Start on Windows boot (zero-friction)

Two launchers are included:

| File        | What it does |
| ----------- | ------------ |
| `start.bat` | Visible: starts the server, shows logs, opens the browser. |
| `start.vbs` | Silent: starts the server hidden in the background (logs to `data/server.log`). |

To register Tradutor to start silently at login:

```
npm run install-startup
```

This creates a shortcut to `start.vbs` in your `shell:startup` folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). Remove it with
`npm run uninstall-startup` — or manually: press `Win+R`, type `shell:startup`,
delete `Tradutor.lnk`.

## Where your data lives

Both directories are **gitignored**, so `git pull` updates never touch them:

| Path | Contents |
| ---- | -------- |
| `config/settings.json` | Anthropic + OpenAI API keys, model, TTS voice, Anki deck name. Never committed, never logged. |
| `data/known_words.json` | Words you've marked as known. |
| `data/word_stats.json` | Lookup counts per word. |
| `data/saved_words.json` | Words & phrases saved from the ebook reader (feeds Anki sync). |
| `data/books/` | Your imported ebook library + reading positions. |
| `data/audio/` | Generated pt-BR MP3s (card audio + Speak cache). |
| `data/history.json` | Translation history incl. reveal/dismiss outcomes. |
| `data/cache/` | Cached API responses. Safe to delete. |

## Tuning the prompts

The system prompts are plain files — edit them without touching code:

- `prompts/translate.md` — translation + annotation behavior (JSON schema lives here).
- `prompts/critique.md` — critique-mode behavior.
- `prompts/ask.md` — how follow-up questions in the Ask bar are answered.
- `prompts/lookup.md` — the reader's click-a-word dictionary entries.

Prompt edits automatically invalidate the response cache (the cache key includes a
hash of the prompt).

## Troubleshooting

- **"Invalid API key"** — re-paste the key in Settings; it's validated against the API
  before saving.
- **"Could not reach Anki"** — start the Anki desktop app and make sure the
  AnkiConnect add-on is installed (code `2055492159`), then sync again.
- **Speech errors** — add/re-check the OpenAI key in Settings; TTS uses
  `gpt-4o-mini-tts`.
- **MOBI won't open** — HUFF/CDIC-compressed or DRM'd MOBI files aren't supported;
  convert to EPUB with Calibre.
- **Rate limited (429)** — wait a few seconds and hit Retry; the SDK also retries
  automatically.
- **Port conflict** — change `port` in `config/settings.json` (or set `PORT=…`).
- **Model errors** — the model name is editable in Settings; default is
  `claude-opus-4-8`.
