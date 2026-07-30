"""
Legenda — live pt-BR -> English subtitles overlay. Cross-platform (Linux + Windows).

Linux:   captures default sink monitor via ffmpeg/PulseAudio (PipeWire).
Windows: captures default speakers via WASAPI loopback (pyaudiowpatch).

Setup:
  Linux:   pip install PyQt6 faster-whisper numpy scipy nvidia-cublas-cu12 nvidia-cudnn-cu12
  Windows: pip install PyQt6 faster-whisper numpy scipy pyaudiowpatch
           (GPU: also nvidia-cublas-cu12 nvidia-cudnn-cu12; needs NVIDIA driver)
Run:
  python legenda.py
"""

import os, sys, platform

IS_WIN = platform.system() == "Windows"
if not IS_WIN:
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")  # XWayland -> keep-above works on KDE

import ctypes, glob, importlib.util, queue, subprocess, threading, time
from datetime import datetime


def _preload_cuda():
    for mod in ("nvidia.cublas", "nvidia.cudnn"):
        spec = importlib.util.find_spec(mod)
        if not spec or not spec.submodule_search_locations:
            continue
        base = list(spec.submodule_search_locations)[0]
        for sub in ("bin", "lib"):
            d = os.path.join(base, sub)
            if not os.path.isdir(d):
                continue
            if IS_WIN:
                os.add_dll_directory(d)
                for dll in sorted(glob.glob(os.path.join(d, "*.dll"))):
                    try:
                        ctypes.WinDLL(dll)
                    except OSError:
                        pass
            else:
                for so in sorted(glob.glob(os.path.join(d, "*.so*"))):
                    try:
                        ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass


_preload_cuda()

import numpy as np
from scipy.signal import resample_poly
from faster_whisper import WhisperModel
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QObject
from PyQt6.QtGui import QFont, QTextCursor
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QTextEdit, QSlider, QFileDialog, QSizeGrip,
)

# ---------------- config ----------------
MODEL_SIZE = "large-v3"
DEVICE = "cuda"            # "cpu" + COMPUTE="int8" if no NVIDIA GPU
COMPUTE = "float16"
SOURCE_LANG = "pt"
MONITOR_SOURCE = os.environ.get("MONITOR_SOURCE")

SILENCE_SECONDS, MIN_SECONDS, MAX_SECONDS = 0.6, 0.6, 10.0
SILENCE_RMS, SPEECH_RMS = 300, 350
RATE, FRAME_MS = 16000, 20
FRAME_BYTES = RATE * 2 * FRAME_MS // 1000
# ----------------------------------------


def rms(pcm: bytes) -> float:
    a = np.frombuffer(pcm, np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(a ** 2))) if a.size else 0.0


class Pipeline(QObject):
    line = pyqtSignal(str, str, float)
    status = pyqtSignal(str)
    level = pyqtSignal(float)

    def __init__(self):
        super().__init__()
        self.paused = False
        self._q: "queue.Queue[tuple[bytes, float]]" = queue.Queue()

    def start(self):
        threading.Thread(target=self._load_and_run, daemon=True).start()

    def _load_and_run(self):
        self.status.emit(f"Loading {MODEL_SIZE} onto {DEVICE}…")
        try:
            self.model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
        except Exception as e:
            self.status.emit(f"Model failed: {e}")
            return
        threading.Thread(target=self._capture_win if IS_WIN else self._capture_linux,
                         daemon=True).start()
        self._transcribe_loop()

    # ---- segmentation shared by both captures
    def _feed(self, chunk: bytes, state):
        buf, silence = state
        level = rms(chunk)
        self.level.emit(level)
        if self.paused:
            buf.clear(); return (buf, 0.0)
        buf.extend(chunk)
        silence = silence + FRAME_MS / 1000 if level < SILENCE_RMS else 0.0
        dur = len(buf) / 2 / RATE
        if buf and ((silence >= SILENCE_SECONDS and dur >= MIN_SECONDS) or dur >= MAX_SECONDS):
            self._q.put((bytes(buf), time.monotonic()))
            buf.clear(); silence = 0.0
        return (buf, silence)

    def _capture_linux(self):
        mon = MONITOR_SOURCE or subprocess.check_output(
            ["pactl", "get-default-sink"], text=True).strip() + ".monitor"
        self.status.emit(f"{MODEL_SIZE} · {DEVICE} · {mon.split('.')[-2][:24]} · listening")
        proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", mon,
             "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
            stdout=subprocess.PIPE)
        state = (bytearray(), 0.0)
        while True:
            chunk = proc.stdout.read(FRAME_BYTES)
            if not chunk:
                self.status.emit("Audio stream ended.")
                break
            state = self._feed(chunk, state)

    def _capture_win(self):
        import pyaudiowpatch as pyaudio
        pa = pyaudio.PyAudio()
        try:
            wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
            spk = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
            if not spk.get("isLoopbackDevice"):
                for d in pa.get_loopback_device_info_generator():
                    if spk["name"] in d["name"]:
                        spk = d; break
        except Exception as e:
            self.status.emit(f"WASAPI error: {e}")
            return
        in_rate, ch = int(spk["defaultSampleRate"]), int(spk["maxInputChannels"])
        self.status.emit(f"{MODEL_SIZE} · {DEVICE} · {spk['name'][:28]} · listening")
        frames = in_rate * FRAME_MS // 1000
        stream = pa.open(format=pyaudio.paInt16, channels=ch, rate=in_rate, input=True,
                         input_device_index=spk["index"], frames_per_buffer=frames)
        state = (bytearray(), 0.0)
        while True:
            raw = stream.read(frames, exception_on_overflow=False)
            a = np.frombuffer(raw, np.int16).astype(np.float32)
            if ch > 1:
                a = a.reshape(-1, ch).mean(axis=1)
            if in_rate != RATE:
                a = resample_poly(a, RATE, in_rate)
            state = self._feed(a.astype(np.int16).tobytes(), state)

    def _transcribe_loop(self):
        while True:
            pcm, t0 = self._q.get()
            if rms(pcm) < SPEECH_RMS:
                continue
            audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
            try:
                segments, _ = self.model.transcribe(
                    audio, task="transcribe", language=SOURCE_LANG,
                    vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500),
                    condition_on_previous_text=False, no_speech_threshold=0.6)
                text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
            except Exception as e:
                self.status.emit(f"Whisper error: {e}")
                continue
            if text:
                self.line.emit(datetime.now().strftime("%H:%M:%S"), text, time.monotonic() - t0)


QSS = """
#root { background: rgba(16,14,20, %OP%); border: 1px solid rgba(126,231,196,0.25);
        border-radius: 12px; }
QLabel { color: #cfc8d8; }
QLabel#title { color: #7ee7c4; font-weight: 600; letter-spacing: 1px; }
QLabel#status, QLabel#lat { color: #8a8296; font-size: 11px; }
QTextEdit { background: transparent; border: none; color: #f2eef7; }
QPushButton { background: rgba(126,231,196,0.12); color: #cfe9dd; border: none;
              border-radius: 6px; padding: 4px 10px; }
QPushButton:hover { background: rgba(126,231,196,0.25); }
QPushButton:checked { background: #7ee7c4; color: #10202a; }
QSlider::groove:horizontal { height: 3px; background: #3a3344; border-radius: 2px; }
QSlider::handle:horizontal { width: 10px; background: #7ee7c4; margin: -5px 0;
                             border-radius: 5px; }
"""


class Overlay(QWidget):
    def __init__(self, pipe: Pipeline):
        super().__init__()
        self.pipe = pipe
        self.opacity_val, self.font_size = 0.88, 15
        self.lines: list[str] = []
        self._drag = None

        self.setWindowTitle("Legenda")
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint |
                            Qt.WindowType.WindowStaysOnTopHint)
        self.resize(560, 300)

        root = QWidget(self); root.setObjectName("root")
        lay = QVBoxLayout(self); lay.setContentsMargins(0, 0, 0, 0); lay.addWidget(root)
        v = QVBoxLayout(root); v.setContentsMargins(12, 8, 12, 8); v.setSpacing(6)

        h = QHBoxLayout()
        self.dot = QLabel("●"); self.dot.setStyleSheet("color:#3a3344;")
        title = QLabel("LEGENDA  ·  PT → EN"); title.setObjectName("title")
        self.lat = QLabel(""); self.lat.setObjectName("lat")
        h.addWidget(self.dot); h.addWidget(title); h.addStretch(); h.addWidget(self.lat)
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

        f = QHBoxLayout()
        self.status = QLabel("starting…"); self.status.setObjectName("status")
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
        pipe.line.connect(self.add_line)
        pipe.status.connect(self.status.setText)
        pipe.level.connect(self._pulse)
        self._dot_timer = QTimer(self); self._dot_timer.setInterval(250)
        self._dot_timer.timeout.connect(lambda: self.dot.setStyleSheet("color:#3a3344;"))

    def _btn(self, text, checkable, cb):
        b = QPushButton(text); b.setCheckable(checkable); b.clicked.connect(cb); return b

    def _apply_qss(self):
        self.setStyleSheet(QSS.replace("%OP%", f"{self.opacity_val:.2f}"))

    def add_line(self, ts, text, latency):
        self.lines.append(f"[{ts}] {text}")
        self.feed.append(f'<span style="color:#8a8296;font-size:11px;">{ts}</span>  {text}')
        self.feed.moveCursor(QTextCursor.MoveOperation.End)
        self.lat.setText(f"{latency:.1f}s")

    def _pulse(self, level):
        if level >= SPEECH_RMS and not self.pipe.paused:
            self.dot.setStyleSheet("color:#7ee7c4;")
            self._dot_timer.start()

    def toggle_pause(self):
        self.pipe.paused = self.btn_pause.isChecked()
        self.btn_pause.setText("Resume" if self.pipe.paused else "Pause")

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
        self.font_size = v; self.feed.setFont(QFont("Sans", v))

    def save_transcript(self):
        if not self.lines:
            self.status.setText("Nothing to save yet."); return
        default = os.path.expanduser(f"~/legenda_{datetime.now():%Y%m%d_%H%M}.txt")
        path, _ = QFileDialog.getSaveFileName(self, "Save transcript", default, "Text (*.txt)")
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(self.lines) + "\n")
            self.status.setText(f"Saved {len(self.lines)} lines.")

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag and e.buttons() & Qt.MouseButton.LeftButton:
            self.move(e.globalPosition().toPoint() - self._drag)

    def mouseReleaseEvent(self, e):
        self._drag = None


def main():
    app = QApplication(sys.argv)
    pipe = Pipeline()
    w = Overlay(pipe)
    w.show()
    pipe.start()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
