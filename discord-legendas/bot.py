"""Discord bot: joins voice, receives per-user DAVE-decrypted audio via a
py-cord Sink, and streams each speaker into their own Deepgram session.

Events are pushed to the UI through a thread-safe `emit(event, payload)`
callable (the PyQt6 overlay or the headless console). Event types:

  status   {"text": str}
  dave     {"proto": int, "ready": bool, "downgraded": bool, "channel": str}
  caption  {"uid": int, "name": str, "color": int, "text": str, "final": bool,
            "ts": "HH:MM:SS"}
  speaking {"uid": int, "name": str, "color": int, "on": bool}
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime

import discord
import numpy as np
from discord.sinks import Filters, Sink

from stt import DeepgramConfig, SpeakerTranscriber

log = logging.getLogger("legendas.bot")

PALETTE_SIZE = 8  # keep in sync with overlay.SPEAKER_COLORS


def _downmix_stereo_s16le(pcm: bytes) -> bytes:
    """48 kHz stereo s16le -> mono, averaging channels."""
    a = np.frombuffer(pcm, dtype=np.int16)
    if a.size % 2:
        a = a[:-1]
    mono = a.reshape(-1, 2).mean(axis=1).astype(np.int16)
    return mono.tobytes()


def _rms(pcm: bytes) -> float:
    a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


class SpeakerInfo:
    __slots__ = ("uid", "name", "color", "frames", "last_rms", "last_seen")

    def __init__(self, uid: int, name: str, color: int):
        self.uid = uid
        self.name = name
        self.color = color
        self.frames = 0
        self.last_rms = 0.0
        self.last_seen = 0.0


class LegendaSink(Sink):
    """Real-time sink: forwards each speaker's decoded PCM to Deepgram.

    `write()` runs on py-cord's packet-router thread; audio is handed to the
    bot's asyncio loop with run_coroutine_threadsafe. By the time a frame gets
    here it has already been transport-decrypted (AEAD) and DAVE-decrypted per
    user, then Opus-decoded to 48 kHz stereo s16le — so a nonzero RMS reading
    below is end-to-end proof that the DAVE receive path works.
    """

    __sink_listeners__ = [
        ("on_member_speaking_start", "on_member_speaking_start"),
        ("on_member_speaking_stop", "on_member_speaking_stop"),
    ]

    def __init__(self, loop: asyncio.AbstractEventLoop, emit, dg_cfg: DeepgramConfig | None,
                 paused_flag):
        super().__init__()
        self.loop = loop
        self.emit = emit
        self.dg_cfg = dg_cfg
        self.paused_flag = paused_flag
        self.speakers: dict[int, SpeakerInfo] = {}
        self.transcribers: dict[int, SpeakerTranscriber] = {}
        self.started = time.monotonic()

    # ---- identity & colors ----------------------------------------------
    def _speaker(self, user, packet_ssrc: int | None) -> SpeakerInfo:
        uid = getattr(user, "id", None) or (packet_ssrc or 0)
        info = self.speakers.get(uid)
        if info is None:
            name = getattr(user, "display_name", None) or getattr(user, "name", None) \
                or f"Falante {len(self.speakers) + 1}"
            info = SpeakerInfo(uid, name, len(self.speakers) % PALETTE_SIZE)
            self.speakers[uid] = info
        return info

    # ---- audio path ------------------------------------------------------
    @Filters.container
    def write(self, data, user):
        pcm = getattr(data, "pcm", None) or (data if isinstance(data, bytes) else b"")
        if not pcm:
            return
        ssrc = getattr(getattr(data, "packet", None), "ssrc", None)
        info = self._speaker(user, ssrc)
        info.frames += 1
        info.last_rms = _rms(pcm)
        info.last_seen = time.monotonic()

        if self.paused_flag.is_set() or self.dg_cfg is None:
            return
        mono = _downmix_stereo_s16le(pcm)
        asyncio.run_coroutine_threadsafe(self._ingest(info, mono), self.loop)

    async def _ingest(self, info: SpeakerInfo, mono: bytes) -> None:
        try:
            tr = self.transcribers.get(info.uid)
            if tr is None or tr.closed:
                tr = self._make_transcriber(info)
                self.transcribers[info.uid] = tr
            tr.feed(mono)
        except Exception:
            log.exception("Failed to ingest audio for %s", info.name)

    def _make_transcriber(self, info: SpeakerInfo) -> SpeakerTranscriber:
        assert self.dg_cfg is not None

        def on_partial(text: str) -> None:
            self.emit("caption", {"uid": info.uid, "name": info.name, "color": info.color,
                                  "text": text, "final": False,
                                  "ts": datetime.now().strftime("%H:%M:%S")})

        def on_final(text: str) -> None:
            self.emit("caption", {"uid": info.uid, "name": info.name, "color": info.color,
                                  "text": text, "final": True,
                                  "ts": datetime.now().strftime("%H:%M:%S")})

        def on_status(text: str) -> None:
            self.emit("status", {"text": text})

        log.info("Opening Deepgram session for %s (uid=%s)", info.name, info.uid)
        return SpeakerTranscriber(self.dg_cfg, on_partial, on_final, on_status,
                                  label=info.name)

    # ---- speaking events (py-cord SinkEventRouter) -----------------------
    def on_member_speaking_start(self, member) -> None:
        info = self._speaker(member, None)
        self.emit("speaking", {"uid": info.uid, "name": info.name,
                               "color": info.color, "on": True})

    def on_member_speaking_stop(self, member) -> None:
        info = self._speaker(member, None)
        self.emit("speaking", {"uid": info.uid, "name": info.name,
                               "color": info.color, "on": False})

    # ---- teardown --------------------------------------------------------
    async def aclose(self) -> None:
        for tr in list(self.transcribers.values()):
            await tr.close()
        self.transcribers.clear()

    def cleanup(self):  # called by py-cord when recording stops; keep it non-blocking
        self.finished = True


def dave_state(vc: discord.VoiceClient) -> dict:
    conn = vc._connection
    sess = getattr(conn, "dave_session", None)
    return {
        "proto": getattr(conn, "dave_protocol_version", 0) or 0,
        "ready": bool(sess and getattr(sess, "ready", False)),
        "downgraded": bool(getattr(conn, "downgraded_dave", False)),
        "channel": getattr(vc.channel, "name", "?"),
    }


def build_bot(emit, dg_cfg: DeepgramConfig | None, paused_flag,
              guild_ids: list[int] | None = None) -> discord.Bot:
    intents = discord.Intents.default()
    intents.members = True  # resolve display names for speakers (enable in the dev portal!)
    bot = discord.Bot(intents=intents)
    bot.legenda_sink = None  # type: ignore[attr-defined]

    def vc_of(ctx) -> discord.VoiceClient | None:
        return ctx.guild.voice_client if ctx.guild else None

    async def emit_dave(vc: discord.VoiceClient) -> None:
        emit("dave", dave_state(vc))

    @bot.event
    async def on_ready():
        try:
            import davey
            dave_note = f"DAVE proto v{davey.DAVE_PROTOCOL_VERSION} disponível"
        except ImportError:
            dave_note = "⚠️ pacote 'davey' AUSENTE — voz vai falhar com erro 4017"
        emit("status", {"text": f"Bot {bot.user} online · {dave_note} · use /join num canal de voz"})
        log.info("Ready as %s — %s", bot.user, dave_note)

    @bot.slash_command(name="join", description="Entrar no seu canal de voz e legendar",
                       guild_ids=guild_ids)
    async def join(ctx: discord.ApplicationContext):
        if not (ctx.author.voice and ctx.author.voice.channel):
            await ctx.respond("Entre num canal de voz primeiro.", ephemeral=True)
            return
        await ctx.defer(ephemeral=True)

        if not discord.opus.is_loaded():
            try:
                discord.opus._load_default()
            except Exception:
                await ctx.followup.send(
                    "libopus não encontrada — instale (Linux: `sudo apt install libopus0`).")
                return

        channel = ctx.author.voice.channel
        vc = vc_of(ctx)
        if vc and vc.channel != channel:
            await vc.move_to(channel)
        elif not vc:
            try:
                vc = await channel.connect(timeout=30)
            except discord.errors.ConnectionClosed as exc:
                if getattr(exc, "code", None) == 4017:
                    await ctx.followup.send(
                        "❌ Discord fechou a conexão com **4017 (DAVE E2EE obrigatório)**. "
                        "Instale `davey` e use o py-cord com suporte a DAVE — veja o README.")
                else:
                    await ctx.followup.send(f"❌ Conexão de voz falhou: {exc}")
                return
            except (asyncio.TimeoutError, TimeoutError):
                await ctx.followup.send(
                    "❌ Timeout ao conectar na voz. Se o log mostrar close code 4017, "
                    "é o DAVE E2EE faltando — veja o README.")
                return

        # give the MLS handshake a moment, then report the E2EE state honestly
        state = dave_state(vc)
        for _ in range(20):
            if state["ready"]:
                break
            await asyncio.sleep(0.5)
            state = dave_state(vc)
        await emit_dave(vc)

        if not vc.is_recording():
            loop = asyncio.get_running_loop()
            sink = LegendaSink(loop, emit, dg_cfg, paused_flag)
            bot.legenda_sink = sink  # type: ignore[attr-defined]
            # the extra None arg makes the after-callback fire on every py-cord
            # variant (2.8.1 released vs PR #3159 semantics)
            vc.start_recording(sink, _after_recording, None)

        if state["proto"] > 0 and state["ready"]:
            e2ee = f"🔐 DAVE E2EE ativo (proto v{state['proto']})"
        elif state["proto"] > 0:
            e2ee = (f"🔐 DAVE negociado (proto v{state['proto']}), grupo MLS ainda formando — "
                    "normal se o bot está sozinho no canal")
        else:
            e2ee = "⚠️ DAVE NÃO negociado (proto 0) — áudio provavelmente não vai chegar"
        stt = "Deepgram pronto" if dg_cfg else "sem DEEPGRAM_API_KEY — só diagnóstico (/dave)"
        emit("status", {"text": f"#{channel.name} · {e2ee.split('(')[0].strip()} · {stt}"})
        await ctx.followup.send(f"Legendando **#{channel.name}**\n{e2ee}\n{stt}")

    @bot.slash_command(name="leave", description="Parar de legendar e sair do canal",
                       guild_ids=guild_ids)
    async def leave(ctx: discord.ApplicationContext):
        vc = vc_of(ctx)
        if not vc:
            await ctx.respond("Não estou num canal de voz.", ephemeral=True)
            return
        await ctx.defer(ephemeral=True)
        sink: LegendaSink | None = getattr(bot, "legenda_sink", None)
        if vc.is_recording():
            vc.stop_recording()
        if sink:
            await sink.aclose()
            bot.legenda_sink = None  # type: ignore[attr-defined]
        await vc.disconnect()
        emit("status", {"text": "Saí do canal de voz."})
        await ctx.followup.send("Até mais! 👋")

    @bot.slash_command(name="dave", description="Diagnóstico do DAVE E2EE e da recepção de áudio",
                       guild_ids=guild_ids)
    async def dave_cmd(ctx: discord.ApplicationContext):
        vc = vc_of(ctx)
        if not vc:
            await ctx.respond("Não estou conectado a um canal de voz. Use /join.", ephemeral=True)
            return
        state = dave_state(vc)
        try:
            import davey
            davey_line = f"davey instalado · protocolo máx. v{davey.DAVE_PROTOCOL_VERSION}"
        except ImportError:
            davey_line = "❌ davey NÃO instalado (conexão de voz falharia com 4017)"

        lines = [
            f"**Canal:** #{state['channel']}",
            f"**{davey_line}**",
            f"**Protocolo negociado:** v{state['proto']}"
            + (" ✅" if state["proto"] > 0 else " ❌ (sem E2EE — Discord vai rejeitar)"),
            f"**Sessão MLS pronta:** {'✅ sim' if state['ready'] else '⏳ ainda não'}",
            f"**Downgrade de E2EE:** {'⚠️ sim' if state['downgraded'] else 'não'}",
        ]
        sink: LegendaSink | None = getattr(bot, "legenda_sink", None)
        if sink and sink.speakers:
            lines.append("\n**Áudio decifrado por falante** (frames · RMS recente):")
            now = time.monotonic()
            for info in sink.speakers.values():
                age = now - info.last_seen if info.last_seen else math.inf
                fresh = "🟢" if age < 5 else "⚪"
                lines.append(f"{fresh} {info.name}: {info.frames} frames · RMS {info.last_rms:.0f}")
            lines.append("_Frames subindo com RMS > 0 = decifração DAVE funcionando de ponta a ponta._")
        elif sink:
            lines.append("\nNenhum frame de áudio recebido ainda — fale algo no canal.")
        await ctx.respond("\n".join(lines), ephemeral=True)

    async def _after_recording(*args) -> None:
        # py-cord's after-callback signature differs across versions; accept anything
        err = next((a for a in args if isinstance(a, Exception)), None)
        if err:
            log.error("Recording stopped with error: %s", err)
            emit("status", {"text": f"Recepção de áudio parou com erro: {err}"})
        else:
            log.info("Recording stopped.")

    return bot
