"""Entry point: PyQt6 overlay on the main thread, py-cord bot on a worker
thread with its own asyncio loop.

Run:  python main.py            (overlay)
      python main.py --headless (captions to stdout — good for a first
                                 DAVE verification on a server without a GUI)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import threading

from dotenv import load_dotenv

from bot import build_bot
from stt import DeepgramConfig

log = logging.getLogger("legendas")


def load_config() -> dict:
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    load_dotenv()  # also pick up a .env in the current directory

    token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not token:
        sys.exit("DISCORD_TOKEN não definido. Copie .env.example para .env e preencha.")

    dg_key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    dg_cfg = None
    if dg_key:
        dg_cfg = DeepgramConfig(
            api_key=dg_key,
            model=os.environ.get("DEEPGRAM_MODEL", "nova-3"),
            language=os.environ.get("DEEPGRAM_LANGUAGE", "pt-BR"),
        )
    else:
        print("AVISO: DEEPGRAM_API_KEY não definido — o bot conecta e o /dave "
              "diagnostica o DAVE, mas não haverá legendas.")

    guild_ids = None
    raw = os.environ.get("GUILD_IDS", "").strip()
    if raw:
        guild_ids = [int(x) for x in raw.replace(" ", "").split(",") if x]

    return {"token": token, "dg_cfg": dg_cfg, "guild_ids": guild_ids}


def start_bot_thread(emit, cfg: dict, paused_flag) -> tuple[threading.Thread, "asyncio.AbstractEventLoop", object]:
    """Build and run the bot on a dedicated thread; returns (thread, loop, bot_ref)."""
    loop = asyncio.new_event_loop()
    holder: dict = {}
    ready = threading.Event()

    def runner() -> None:
        asyncio.set_event_loop(loop)
        bot = build_bot(emit, cfg["dg_cfg"], paused_flag, cfg["guild_ids"])
        holder["bot"] = bot
        ready.set()
        try:
            loop.run_until_complete(bot.start(cfg["token"]))
        except Exception as exc:
            log.error("Bot terminou com erro: %s", exc)
            emit("status", {"text": f"Bot caiu: {exc}"})
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            finally:
                loop.close()

    thread = threading.Thread(target=runner, name="discord-bot", daemon=True)
    thread.start()
    ready.wait(timeout=10)
    return thread, loop, holder


def shutdown_bot(loop: asyncio.AbstractEventLoop, holder: dict, thread: threading.Thread) -> None:
    bot = holder.get("bot")
    if bot is None or not loop.is_running():
        return

    async def _close() -> None:
        sink = getattr(bot, "legenda_sink", None)
        if sink:
            try:
                await sink.aclose()
            except Exception:
                pass
        await bot.close()

    fut = asyncio.run_coroutine_threadsafe(_close(), loop)
    try:
        fut.result(timeout=10)
    except Exception:
        pass
    thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description="Legendas ao vivo de voz do Discord (pt-BR)")
    parser.add_argument("--headless", action="store_true",
                        help="sem overlay; legendas no terminal")
    parser.add_argument("--debug-voice", action="store_true",
                        help="log detalhado do handshake de voz/DAVE (MLS, transições)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    if args.debug_voice:
        logging.getLogger("discord.voice").setLevel(logging.DEBUG)

    cfg = load_config()

    if args.headless:
        def emit(name: str, p: dict) -> None:
            if name == "caption" and p["final"]:
                print(f"[{p['ts']}] {p['name']}: {p['text']}", flush=True)
            elif name == "status":
                print(f"-- {p['text']}", flush=True)
            elif name == "dave":
                ok = "✓" if p["proto"] > 0 else "✗"
                print(f"-- DAVE {ok} proto v{p['proto']} ready={p['ready']} "
                      f"channel=#{p['channel']}", flush=True)

        paused = threading.Event()
        bot = build_bot(emit, cfg["dg_cfg"], paused, cfg["guild_ids"])
        try:
            bot.run(cfg["token"])  # uses the loop py-cord bound at construction
        except KeyboardInterrupt:
            pass
        return

    from overlay import Bridge, run_overlay  # imports Qt — only in GUI mode

    paused = threading.Event()
    bridge = Bridge()
    thread, loop, holder = start_bot_thread(bridge, cfg, paused)
    code = run_overlay(bridge, paused, on_close=lambda: shutdown_bot(loop, holder, thread))
    sys.exit(code)


if __name__ == "__main__":
    main()
