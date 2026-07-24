# Tradutor 🇧🇷 ↔ 🇬🇧

A local Brazilian-Portuguese ↔ English translator built for **learning**, not just
translating. Made for an English speaker learning informal Brazilian Portuguese — the
register of chat, Discord and WhatsApp (`vc`, `pq`, `tbm`, `kkkk`…). Translations are
powered by the Anthropic API (`claude-opus-4-8` by default) and streamed token-by-token
into a single two-pane page you keep bookmarked at **http://localhost:4747**.

## Features

- **Delayed / blurred reveal** — PT→EN output arrives blurred; you attempt to
  understand the Portuguese first, then click to reveal. What you had to reveal (vs.
  dismissed unrevealed) feeds your review list. Toggle it off in the toolbar.
- **Word-level hover gloss + click-for-morphology** — every Portuguese word (input or
  output) is interactive: hover for the in-context English gloss, click for a side
  panel with lemma, tense/mood/person, why that form is used, a conjugation table
  (verbs) or gender/number/collocations (nouns/adjectives).
- **Internet-Portuguese normalization** — chat abbreviations and spoken forms are
  expanded inline (`vc → você`, `tô → estou`, `kkkk → laughter`) both by a local
  dictionary (instant) and by the model (complete).
- **Known-word tracking + progressive code-switching** — mark words as known; unknown
  words are highlighted, known ones aren't. With **progressive** mode on, your known
  Portuguese words stay untranslated inside the English output, so translations become
  mixed-language as your vocabulary grows.
- **Ambiguity flags** — dotted-underline markers in the English where the Portuguese
  underdetermines it (dropped subjects, você/tu, preterite vs imperfect, gender).
  Click one to see what the model chose, the alternatives, and the context clue.
- **Naturalness critique mode** — flip the **critique** toggle when you wrote the
  Portuguese yourself: grammar verdict, diff-style corrections, "a Brazilian would more
  likely say: …" with a register note (formal / neutral / casual / gíria).
- **False-friend & structure warnings** — `esquisito ≠ exquisite`, plus light
  highlights for contractions (`pelo = por + o`), verb+preposition pairs (`gostar de`),
  personal infinitive, etc.
- **History → study export** — every translation, reveal and word lookup is logged
  locally. The **Review** panel shows your most-looked-up unknown words and the
  sentences you needed revealed, and exports an **Anki-importable TSV** (front: PT
  sentence with the target word bolded; back: gloss + translation).
- **Type in either pane** — the panes are bidirectional. Type Portuguese (or anything)
  on the left and the translation renders on the right; type English on the right and
  the Portuguese appears on the left. Direction is always auto-detected.
- **Ask box** — a follow-up question bar under the panes: ask things like *"why is this
  word used here?"* or *"could I say X instead?"* and the model answers about the
  current text/translation (prompt in `prompts/ask.md`).
- **Clear button** — resets both panes, annotations and the ask answer in one click.
- Register variants (casual + neutral) for EN→PT, chat-log-aware translation
  (message structure preserved), light/dark theme following the system.

## Setup

Requires [Node.js](https://nodejs.org) 18+.

```
git clone <this repo>
cd tradutor
npm install
npm start
```

Open **http://localhost:4747**. On first launch you'll be prompted for your Anthropic
API key (get one at https://console.anthropic.com). The key is validated and saved to
`config/settings.json` — see [Where your data lives](#where-your-data-lives).

### Usage

- Paste or type in **either pane** — the translation renders in the other one.
  Translation starts automatically when you pause typing; **Ctrl+Enter** translates
  immediately.
- Direction (pt→en / en→pt) is auto-detected; typing English in the right pane is the
  quickest way to go EN→PT-BR.
- Click a rendered translation to edit it (it's a real text box underneath).
- Use the **Ask** bar below the panes for follow-up questions about the current text.
- **Clear** (top right) empties both panes.
- Repeated translations are served instantly from the local cache (no API cost).

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

The idle server uses a few tens of MB of RAM and ~0% CPU; it only does work when you
translate.

## Where your data lives

Both directories are **gitignored**, so `git pull` updates never touch them:

| Path | Contents |
| ---- | -------- |
| `config/settings.json` | Anthropic API key + model name. Never committed, never logged. |
| `data/known_words.json` | Words you've marked as known. |
| `data/word_stats.json` | Lookup counts per word (feeds Review + Anki export). |
| `data/history.json` | Translation history incl. reveal/dismiss outcomes. |
| `data/cache/` | Cached API responses (hash of input → result). Safe to delete. |

## Tuning the prompts

The system prompts are plain files — edit them without touching code:

- `prompts/translate.md` — translation + annotation behavior (JSON schema lives here).
- `prompts/critique.md` — critique-mode behavior.
- `prompts/ask.md` — how follow-up questions in the Ask bar are answered.

Prompt edits automatically invalidate the response cache (the cache key includes a
hash of the prompt).

## Anki export

Review panel → **Export Anki TSV**, then in Anki: File → Import, pick the `.tsv`,
map field 1 → Front, field 2 → Back, and enable "Allow HTML in fields" so the bolded
target word renders.

## Troubleshooting

- **"Invalid API key"** — re-paste the key in Settings; it's validated against the API
  before saving.
- **Rate limited (429)** — wait a few seconds and hit Retry; the SDK also retries
  automatically.
- **Port conflict** — change `port` in `config/settings.json` (or set `PORT=…`).
- **Model errors** — the model name is editable in Settings; default is
  `claude-opus-4-8`.
