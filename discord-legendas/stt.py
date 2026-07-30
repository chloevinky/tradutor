"""Deepgram live-streaming STT — one websocket session per Discord speaker.

Transport-only module: feeds 48 kHz mono s16le PCM in, emits partial/final
utterance text out via callbacks. No Discord or Qt imports here.

Auth uses the ["token", <key>] websocket subprotocol, which works across all
`websockets` library versions (extra_headers/additional_headers renamed between
v13 and v14).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from urllib.parse import urlencode

import websockets
import websockets.exceptions

log = logging.getLogger("legendas.stt")

DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen"

# handshake-rejection exception was renamed between websockets v13 and v14
_HANDSHAKE_ERRORS = tuple(
    exc for exc in (
        getattr(websockets.exceptions, "InvalidStatus", None),
        getattr(websockets.exceptions, "InvalidStatusCode", None),
    ) if exc is not None
)

KEEPALIVE_INTERVAL = 5.0     # Deepgram drops the socket after ~10 s without audio or KeepAlive
IDLE_CLOSE_SECONDS = 300.0   # close the websocket for speakers silent this long (reopened on demand)
QUEUE_MAX_FRAMES = 250       # ~5 s of 20 ms frames; drop oldest beyond this


class DeepgramConfig:
    def __init__(
        self,
        api_key: str,
        model: str = "nova-3",
        language: str = "pt-BR",
        sample_rate: int = 48000,
        endpointing_ms: int = 300,
        utterance_end_ms: int = 1000,
    ):
        self.api_key = api_key
        self.model = model
        self.language = language
        self.sample_rate = sample_rate
        self.endpointing_ms = endpointing_ms
        self.utterance_end_ms = utterance_end_ms

    def url(self) -> str:
        params = {
            "model": self.model,
            "language": self.language,
            "encoding": "linear16",
            "sample_rate": self.sample_rate,
            "channels": 1,
            "interim_results": "true",
            "smart_format": "true",
            "endpointing": self.endpointing_ms,
            "utterance_end_ms": self.utterance_end_ms,
        }
        return f"{DEEPGRAM_WS}?{urlencode(params)}"


class SpeakerTranscriber:
    """Owns one Deepgram live session for one speaker.

    Aggregation model: Deepgram emits rolling interim results; segments arrive
    with is_final=True and an utterance ends at speech_final=True (or an
    UtteranceEnd message). We keep finalized segments in a buffer and emit:
      on_partial(display_text)  — buffer + current interim, for live captions
      on_final(utterance_text)  — full utterance when the endpoint is reached
    Callbacks run on the asyncio event loop that created this transcriber.
    """

    def __init__(
        self,
        cfg: DeepgramConfig,
        on_partial: Callable[[str], None],
        on_final: Callable[[str], None],
        on_status: Callable[[str], None] | None = None,
        label: str = "?",
    ):
        self.cfg = cfg
        self.on_partial = on_partial
        self.on_final = on_final
        self.on_status = on_status or (lambda s: None)
        self.label = label

        self.closed = False
        self._closing = False
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=QUEUE_MAX_FRAMES)
        self._last_audio = time.monotonic()
        self._segments: list[str] = []
        self._interim = ""
        self._task = asyncio.get_running_loop().create_task(self._run())

    # ---- input -----------------------------------------------------------
    def feed(self, pcm_mono_s16le: bytes) -> None:
        if self.closed:
            return
        self._last_audio = time.monotonic()
        try:
            self._queue.put_nowait(pcm_mono_s16le)
        except asyncio.QueueFull:
            try:  # drop the oldest frame to stay realtime
                self._queue.get_nowait()
                self._queue.put_nowait(pcm_mono_s16le)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    async def close(self) -> None:
        self._closing = True
        self.closed = True
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass

    # ---- session ---------------------------------------------------------
    async def _run(self) -> None:
        backoff = 1.0
        while not self._closing:
            try:
                async with websockets.connect(
                    self.cfg.url(),
                    subprotocols=["token", self.cfg.api_key],
                    max_queue=None,
                ) as ws:
                    log.info("[%s] Deepgram session open (%s/%s)",
                             self.label, self.cfg.model, self.cfg.language)
                    backoff = 1.0
                    sender = asyncio.create_task(self._sender(ws))
                    keeper = asyncio.create_task(self._keepalive(ws))
                    try:
                        await self._receiver(ws)
                    finally:
                        sender.cancel()
                        keeper.cancel()
                if self.closed:
                    break
            except asyncio.CancelledError:
                return
            except _HANDSHAKE_ERRORS as exc:
                # 401/403: bad API key — no point retrying forever
                self.on_status(f"Deepgram recusou a conexão ({exc}). Verifique DEEPGRAM_API_KEY.")
                log.error("[%s] Deepgram handshake failed: %s", self.label, exc)
                self.closed = True
                return
            except Exception as exc:
                if self._closing:
                    return
                log.warning("[%s] Deepgram session error: %s — reconnecting in %.1fs",
                            self.label, exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 15.0)
        self.closed = True

    async def _sender(self, ws) -> None:
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                await ws.send(json.dumps({"type": "CloseStream"}))
                return
            await ws.send(chunk)

    async def _keepalive(self, ws) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            if time.monotonic() - self._last_audio > IDLE_CLOSE_SECONDS:
                log.info("[%s] idle %.0fs — closing Deepgram session", self.label,
                         time.monotonic() - self._last_audio)
                self.closed = True
                try:
                    self._queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
                return
            try:
                await ws.send(json.dumps({"type": "KeepAlive"}))
            except Exception:
                return

    async def _receiver(self, ws) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            mtype = msg.get("type")
            if mtype == "Results":
                self._handle_results(msg)
            elif mtype == "UtteranceEnd":
                self._flush_utterance()
            elif mtype == "Error":
                log.error("[%s] Deepgram error message: %s", self.label, msg)

    def _handle_results(self, msg: dict) -> None:
        try:
            text = msg["channel"]["alternatives"][0].get("transcript", "").strip()
        except (KeyError, IndexError):
            return
        if text:
            if msg.get("is_final"):
                self._segments.append(text)
                self._interim = ""
            else:
                self._interim = text
        if msg.get("speech_final"):
            self._flush_utterance()
        elif text:
            self.on_partial(self._display_text())

    def _display_text(self) -> str:
        return " ".join([*self._segments, self._interim]).strip()

    def _flush_utterance(self) -> None:
        full = self._display_text()
        self._segments.clear()
        self._interim = ""
        if full:
            self.on_final(full)
