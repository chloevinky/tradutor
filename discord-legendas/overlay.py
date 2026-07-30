"""Always-on-top translucent PyQt6 overlay showing per-speaker live captions.

Styling, window flags, and controls are carried over from legenda.py; the feed
is extended with per-speaker colors and an in-place "live" area where partial
(interim) results update until Deepgram finalizes the utterance.
"""

from __future__ import annotations

import os
import platform
import time
from datetime import datetime

if platform.system() != "Windows":
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")  # XWayland -> keep-above works on KDE

from PyQt6.QtCore import Qt, QObject, QTimer, pyqtSignal
from PyQt6.QtGui import QFont, QTextCursor
from PyQt6.QtWidgets import (
    QApplication, QFileDialog, QHBoxLayout, QLabel, QPushButton, QSizeGrip,
    QSlider, QTextEdit, QVBoxLayout, QWidget,
)

SPEAKER_COLORS = [  # keep in sync with bot.PALETTE_SIZE
    "#7ee7c4", "#7ab8ff", "#ffb86c", "#ff79c6",
    "#c3a6ff", "#f1fa8c", "#6ce5e8", "#ff8a80",
]

STALE_PARTIAL_SECONDS = 6  # sweep live lines whose final never arrived

QSS = """
#root { background: rgba(16,14,20, %OP%); border: 1px solid rgba(126,231,196,0.25);
        border-radius: 12px; }
QLabel { color: #cfc8d8; }
QLabel#title { color: #7ee7c4; font-weight: 600; letter-spacing: 1px; }
QLabel#status, QLabel#e2ee { color: #8a8296; font-size: 11px; }
QLabel#e2ee[state="on"] { color: #7ee7c4; }
QLabel#e2ee[state="off"] { color: #ff8a80; }
QTextEdit { background: transparent; border: none; color: #f2eef7; }
QPushButton { background: rgba(126,231,196,0.12); color: #cfe9dd; border: none;
              border-radius: 6px; padding: 4px 10px; }
QPushButton:hover { background: rgba(126,231,196,0.25); }
QPushButton:checked { background: #7ee7c4; color: #10202a; }
QSlider::groove:horizontal { height: 3px; background: #3a3344; border-radius: 2px; }
QSlider::handle:horizontal { width: 10px; background: #7ee7c4; margin: -5px 0;
                             border-radius: 5px; }
"""


class Bridge(QObject):
    """Thread-safe funnel: the bot thread emits, Qt delivers on the GUI thread."""

    event = pyqtSignal(str, object)

    def __call__(self, name: str, payload: dict) -> None:
        self.event.emit(name, payload)


class Overlay(QWidget):
    def __init__(self, bridge: Bridge, paused_flag):
        super().__init__()
        self.paused_flag = paused_flag
        self.opacity_val, self.font_size = 0.88, 15
        self.lines: list[str] = []
        self._drag = None
        self._live: dict[int, tuple[QLabel, float]] = {}  # uid -> (label, last update ts)

        self.setWindowTitle("Legendas Discord")
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint |
                            Qt.WindowType.WindowStaysOnTopHint)
        self.resize(600, 340)

        root = QWidget(self); root.setObjectName("root")
        lay = QVBoxLayout(self); lay.setContentsMargins(0, 0, 0, 0); lay.addWidget(root)
        v = QVBoxLayout(root); v.setContentsMargins(12, 8, 12, 8); v.setSpacing(6)

        h = QHBoxLayout()
        self.dot = QLabel("●"); self.dot.setStyleSheet("color:#3a3344;")
        title = QLabel("LEGENDAS  ·  DISCORD  ·  PT-BR"); title.setObjectName("title")
        self.e2ee = QLabel("E2EE …"); self.e2ee.setObjectName("e2ee")
        h.addWidget(self.dot); h.addWidget(title); h.addStretch(); h.addWidget(self.e2ee)
        self.btn_pause = self._btn("Pause", True, self.toggle_pause)
        self.btn_pin = self._btn("Pinned", True, self.toggle_pin); self.btn_pin.setChecked(True)
        self.btn_ghost = self._btn("Ghost", True, self.toggle_ghost)
        self.btn_save = self._btn("Save", False, self.save_transcript)
        self.btn_close = self._btn("✕", False, self.close)
        for b in (self.btn_pause, self.btn_pin, self.btn_ghost, self.btn_save, self.btn_close):
            h.addWidget(b)
        v.addLayout(h)

        self.feed = QTextEdit(readOnly=True)
        self.feed.setFont(QFont("Sans", self.font_size))
        self.feed.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        v.addWidget(self.feed, 1)

        self.live_box = QVBoxLayout(); self.live_box.setSpacing(2)
        v.addLayout(self.live_box)

        f = QHBoxLayout()
        self.status = QLabel("iniciando…"); self.status.setObjectName("status")
        f.addWidget(self.status); f.addStretch()
        f.addWidget(QLabel("A"))
        s_font = QSlider(Qt.Orientation.Horizontal); s_font.setRange(10, 28)
        s_font.setValue(self.font_size); s_font.setFixedWidth(80)
        s_font.valueChanged.connect(self.set_font_size); f.addWidget(s_font)
        f.addWidget(QLabel("◐"))
        s_op = QSlider(Qt.Orientation.Horizontal); s_op.setRange(30, 100)
        s_op.setValue(int(self.opacity_val * 100)); s_op.setFixedWidth(80)
        s_op.valueChanged.connect(self.set_opacity); f.addWidget(s_op)
        f.addWidget(QSizeGrip(root))
        v.addLayout(f)

        self._apply_qss()
        bridge.event.connect(self.on_event)

        self._dot_timer = QTimer(self); self._dot_timer.setInterval(250)
        self._dot_timer.timeout.connect(lambda: self.dot.setStyleSheet("color:#3a3344;"))
        self._sweep = QTimer(self); self._sweep.setInterval(2000)
        self._sweep.timeout.connect(self._sweep_stale); self._sweep.start()

    # ---- events from the bot thread --------------------------------------
    def on_event(self, name: str, p: dict) -> None:
        if name == "caption":
            self._on_caption(p)
        elif name == "speaking":
            if p["on"]:
                self._pulse()
        elif name == "status":
            self.status.setText(p["text"])
        elif name == "dave":
            self._on_dave(p)

    def _on_caption(self, p: dict) -> None:
        color = SPEAKER_COLORS[p["color"] % len(SPEAKER_COLORS)]
        if p["final"]:
            self._drop_live(p["uid"])
            self.lines.append(f"[{p['ts']}] {p['name']}: {p['text']}")
            self.feed.append(
                f'<span style="color:#8a8296;font-size:11px;">{p["ts"]}</span> '
                f'<span style="color:{color};font-weight:600;">{_esc(p["name"])}</span>  '
                f'{_esc(p["text"])}')
            self.feed.moveCursor(QTextCursor.MoveOperation.End)
        else:
            label = self._live_label(p["uid"])
            label.setText(
                f'<span style="color:{color};font-weight:600;">{_esc(p["name"])}</span> '
                f'<span style="color:#b8b0c4;font-style:italic;">{_esc(p["text"])} …</span>')
        self._pulse()

    def _on_dave(self, p: dict) -> None:
        if p["proto"] > 0 and p["ready"]:
            self.e2ee.setText(f"E2EE ✓ v{p['proto']}"); state = "on"
        elif p["proto"] > 0:
            self.e2ee.setText(f"E2EE v{p['proto']} (formando grupo)"); state = "on"
        else:
            self.e2ee.setText("E2EE ✗"); state = "off"
        self.e2ee.setProperty("state", state)
        self.e2ee.style().unpolish(self.e2ee); self.e2ee.style().polish(self.e2ee)

    # ---- live partial lines ----------------------------------------------
    def _live_label(self, uid: int) -> QLabel:
        entry = self._live.get(uid)
        if entry:
            label = entry[0]
        else:
            label = QLabel(); label.setWordWrap(True)
            label.setFont(QFont("Sans", self.font_size))
            self.live_box.addWidget(label)
        self._live[uid] = (label, time.monotonic())
        return label

    def _drop_live(self, uid: int) -> None:
        entry = self._live.pop(uid, None)
        if entry:
            self.live_box.removeWidget(entry[0])
            entry[0].deleteLater()

    def _sweep_stale(self) -> None:
        now = time.monotonic()
        for uid, (_, ts) in list(self._live.items()):
            if now - ts > STALE_PARTIAL_SECONDS:
                self._drop_live(uid)

    # ---- controls (from legenda.py) --------------------------------------
    def _btn(self, text, checkable, cb):
        b = QPushButton(text); b.setCheckable(checkable); b.clicked.connect(cb); return b

    def _apply_qss(self):
        self.setStyleSheet(QSS.replace("%OP%", f"{self.opacity_val:.2f}"))

    def _pulse(self):
        if not self.paused_flag.is_set():
            self.dot.setStyleSheet("color:#7ee7c4;")
            self._dot_timer.start()

    def toggle_pause(self):
        if self.btn_pause.isChecked():
            self.paused_flag.set()
        else:
            self.paused_flag.clear()
        self.btn_pause.setText("Resume" if self.paused_flag.is_set() else "Pause")

    def toggle_pin(self):
        on = self.btn_pin.isChecked()
        self.btn_pin.setText("Pinned" if on else "Pin")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, on)
        self.show()

    def toggle_ghost(self):
        on = self.btn_ghost.isChecked()
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, on)
        self.show()
        if on:
            QTimer.singleShot(15000, self._unghost)

    def _unghost(self):
        if self.btn_ghost.isChecked():
            self.btn_ghost.setChecked(False)
            self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, False)
            self.show()

    def set_opacity(self, v):
        self.opacity_val = v / 100; self._apply_qss()

    def set_font_size(self, v):
        self.font_size = v
        self.feed.setFont(QFont("Sans", v))
        for label, _ in self._live.values():
            label.setFont(QFont("Sans", v))

    def save_transcript(self):
        if not self.lines:
            self.status.setText("Nada para salvar ainda."); return
        default = os.path.expanduser(f"~/legendas_discord_{datetime.now():%Y%m%d_%H%M}.txt")
        path, _ = QFileDialog.getSaveFileName(self, "Salvar transcrição", default, "Text (*.txt)")
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(self.lines) + "\n")
            self.status.setText(f"Salvei {len(self.lines)} linhas.")

    # ---- drag ------------------------------------------------------------
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag and e.buttons() & Qt.MouseButton.LeftButton:
            self.move(e.globalPosition().toPoint() - self._drag)

    def mouseReleaseEvent(self, e):
        self._drag = None


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def run_overlay(bridge: Bridge, paused_flag, on_close) -> int:
    app = QApplication([])
    w = Overlay(bridge, paused_flag)
    app.aboutToQuit.connect(on_close)
    w.show()
    return app.exec()
