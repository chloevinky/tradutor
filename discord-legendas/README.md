# Legendas Discord — live per-speaker pt-BR captions

A Discord bot + always-on-top PyQt6 overlay that shows **live Portuguese
captions per speaker**, each with their own color. Instead of capturing
desktop audio like `../legenda.py`, it receives **Discord's separated
per-user voice streams** (py-cord voice receive sinks) and streams each
speaker into their own **Deepgram Nova (pt-BR)** live session, so partial
results appear within a few hundred milliseconds and speakers never bleed
into each other.

```
Discord voice ──(DAVE E2EE + AEAD)──> py-cord VoiceClient
        └─ per-user RTP → DAVE decrypt → Opus decode → LegendaSink.write(pcm, user)
                └─ per-speaker Deepgram live WS (nova-3, pt-BR, interim results)
                        └─ PyQt6 overlay: colored partial/final captions
```

## The DAVE E2EE situation (read this first)

Discord's **DAVE** end-to-end encryption became **mandatory for voice on
March 2, 2026**. Clients that don't negotiate it get their voice connection
closed with **error 4017** — this is what killed `@discordjs/voice` receive
and most Python bots.

Verified state of py-cord (checked against the actual source, July 2026):

| Version | DAVE negotiate | DAVE receive/decrypt |
|---|---|---|
| ≤ 2.6.1 | ❌ no — dies with 4017 | ❌ |
| 2.7.x | send only | ❌ |
| 2.8.1 (PyPI) | ✅ with `davey` installed | ⚠️ code exists but **double-decrypts** → garbled audio |
| **PR [#3159](https://github.com/Pycord-Development/pycord/pull/3159)** | ✅ | ✅ fixed (DAVE decrypt before Opus decode, SSRC race handled) |

So `requirements.txt` installs py-cord **from PR #3159** until it ships in a
release (then switch to `py-cord[voice]>=2.8.2`). Two things are
non-negotiable:

1. **The `davey` package must be installed.** It contains the MLS/DAVE
   bindings. Without it py-cord advertises `max_dave_protocol_version: 0`
   and Discord closes the connection with 4017. (`pip install "py-cord[voice]"`
   pulls it; it has wheels for Windows/macOS/Linux, Python 3.10+.)
2. **Voice gateway v8** — handled automatically by py-cord 2.8+.

The bot verifies the receive path *at runtime*: the overlay shows an
**E2EE ✓ v1** badge once the MLS session is up, and the **`/dave`** slash
command reports negotiated protocol version, MLS session state, and
per-speaker decrypted frame counters with RMS levels — frames counting up
with RMS > 0 is end-to-end proof that DAVE decryption is producing real
audio, not silence.

## Setup

### 1. Create the bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (goes in `.env` as `DISCORD_TOKEN`).
3. Still on the Bot tab, under **Privileged Gateway Intents** enable
   **Server Members Intent** (used to resolve speakers' display names).
   Message Content is *not* needed.
4. **Installation** (or OAuth2 → URL Generator): scopes `bot` +
   `applications.commands`; bot permissions **Connect** and **View Channels**
   (the bot never speaks, so no other permission is needed). Open the
   generated URL and invite the bot to your server.

### 2. Deepgram API key

Create a key at <https://console.deepgram.com> (new accounts get free
credit). Put it in `.env` as `DEEPGRAM_API_KEY`. Default model is
`nova-3` with `language=pt-BR` (both configurable in `.env`; `nova-2` also
supports pt-BR if you need a fallback). Billing is per second of audio
actually streamed — silence isn't sent, and idle speaker sessions close
after 5 minutes.

### 3. Install

Python **3.10–3.13**, then:

```bash
cd discord-legendas
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # then fill in the two keys
```

Extra system bits:

- **Linux:** `sudo apt install libopus0` (Opus decoder; Windows/macOS builds
  of py-cord bundle it). The overlay needs an X11/Wayland session.
- **Windows:** nothing extra.
- `git` must be available for pip to install py-cord from the PR ref.

### 4. Run

```bash
python main.py              # overlay + bot
python main.py --headless   # no GUI, captions in the terminal (good for servers)
python main.py --debug-voice  # verbose DAVE/MLS handshake logging
```

Then, in Discord: join a voice channel and use **`/join`**. The reply tells
you the E2EE state; **`/dave`** shows live diagnostics; **`/leave`**
disconnects.

Tip: set `GUILD_IDS=<your server id>` in `.env` so the slash commands appear
instantly (global registration can take up to an hour).

### Overlay controls

Same scheme as `legenda.py`: drag anywhere to move, corner grip to resize,
**Pause** (stops streaming audio to Deepgram — also stops billing),
**Pin** (always-on-top), **Ghost** (click-through for 15 s), **Save**
(transcript to a .txt), sliders for font size and background opacity.
Partial results appear as an italic line per active speaker and get
promoted into the scrollback when Deepgram finalizes the utterance.

## Verifying DAVE before trusting the rest

Recommended first run (this is the check that my/your previous attempt
failed at):

1. `python main.py --headless --debug-voice`
2. `/join` from Discord while in a voice channel with at least one other
   person.
3. Watch for:
   - no `4017` close code in the log,
   - `-- DAVE ✓ proto v1 ready=True` printed by the bot,
   - `/dave` showing frame counters increasing and RMS > 0 while someone
     talks.

If all three hold, the DAVE receive path is working and captions are just a
Deepgram key away.

## Troubleshooting

### Connection closed with code 4017 (the classic)
Discord requires DAVE and your client didn't offer it.
- `python -c "import davey; print(davey.DAVE_PROTOCOL_VERSION)"` must print
  `1` (or higher). `ImportError` → `pip install "davey>=0.1.4"`.
- `python -c "import discord; print(discord.__version__)"` must print
  `2.8.1.dev…` (the PR build) — a plain `2.6.x`/`2.7.x` cannot receive.
  Reinstall with `pip install -r requirements.txt --force-reinstall`.
- Make sure no other requirement pinned `py-cord` back to an older version.

### Bot connects but captions never appear
- Run `/dave`. **No frames at all:** the members intent may be off (names
  can't resolve — check the portal toggle), or nobody is actually
  transmitting (Discord only sends packets while someone speaks).
- **Frames increase but RMS ≈ 0:** DAVE decryption is failing and py-cord
  is substituting silence — you are probably on stock 2.8.1 (double-decrypt
  bug). Reinstall from `requirements.txt`.
- **Frames + RMS fine, still no captions:** Deepgram side — check the
  terminal for `Deepgram recusou a conexão` (bad/expired API key) and your
  Deepgram console for remaining credit.

### "DAVE negociado, grupo MLS ainda formando"
Normal when the bot is alone in the channel — the MLS group completes when
another participant joins. If it persists with people present and
`--debug-voice` shows repeated `invalid commit` / `MLS proposals` errors,
someone's client forced a downgrade or a transition failed; `/leave` and
`/join` to re-init the session (py-cord also recovers automatically on the
next epoch).

### Garbled/robotic transcriptions of clear speech
Audio is being corrupted before Deepgram — same double-decrypt symptom as
above; verify you're on the PR build.

### `libopus` errors on `/join`
Linux: `sudo apt install libopus0`. Exotic setups: point py-cord at the
library with `discord.opus.load_opus("/path/to/libopus.so.0")` before
connecting.

### Overlay doesn't stay on top (Linux/Wayland)
Same caveat as `legenda.py`: the code forces `QT_QPA_PLATFORM=xcb`
(XWayland) so keep-above works on KDE/GNOME. If you removed that, the
Wayland compositor decides stacking, not Qt.

### Voice connects, then drops after a few minutes
Usually UDP keepalive being filtered (VPN/NAT). py-cord sends keepalives
every 5 s; if your firewall still kills the flow, the bot reconnects on the
next `/join`. Check `--debug-voice` for `ConnectionClosed` codes: 4014
(kicked/moved/channel deleted) and 4006/4009 (session invalid — py-cord
resumes) are the common benign ones.

## Costs & privacy notes

- Deepgram streams only while someone is actually speaking; per-speaker
  sessions self-close after 5 idle minutes.
- Everyone in the channel should know captioning is on: the bot is visibly
  in the voice channel, but tell people anyway — this pipes their speech to
  a third-party STT service. E2EE protects the transport; this bot is, by
  design, a decrypting endpoint.

## Files

| File | Role |
|---|---|
| `main.py` | entry point; Qt main thread + bot thread wiring |
| `bot.py` | py-cord bot, `LegendaSink` (per-user PCM → Deepgram), `/join` `/leave` `/dave` |
| `stt.py` | Deepgram live websocket client, per-speaker session + utterance aggregation |
| `overlay.py` | PyQt6 overlay (styling carried over from `../legenda.py`) |
