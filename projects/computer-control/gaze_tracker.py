#!/usr/bin/env python3
"""
Gaze Tracker — calibration-based eye tracking using webcam + MediaPipe.

Shows a red dot where the program thinks you're looking.
First run does a calibration (look at dots, press Space).  Subsequent
runs reuse the saved calibration unless you pass --recalibrate.

Accuracy comes from:
  • 6-feature vector (iris x/y per eye + inter-ocular distance ratio +
    head yaw/pitch from solvePnP)
  • N-point screen calibration with multi-frame averaging
  • Ridge regression over 2nd-degree polynomial features
  • EMA smoothing at runtime

Press Ctrl+C to quit.  Press Space during calibration to capture a point.
"""

import argparse
import json
import os
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import PolynomialFeatures

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH  = str(PROJECT_DIR / "face_landmarker.task")
CALIB_PATH  = str(PROJECT_DIR / "calibration.json")

# ---------------------------------------------------------------------------
# MediaPipe landmark indices
# ---------------------------------------------------------------------------
LEFT_EYE_OUTER  = 33
LEFT_EYE_INNER  = 133
LEFT_EYE_TOP    = 159
LEFT_EYE_BOTTOM = 145
LEFT_IRIS       = 468

RIGHT_EYE_OUTER  = 263
RIGHT_EYE_INNER  = 362
RIGHT_EYE_TOP    = 386
RIGHT_EYE_BOTTOM = 374
RIGHT_IRIS       = 473

# solvePnP landmark indices (subset of the 468 mesh)
NOSE_TIP        = 4
CHIN            = 152
LEFT_EYE_CORNER = 33
RIGHT_EYE_CORNER= 263
LEFT_MOUTH      = 61
RIGHT_MOUTH     = 291

# ---------------------------------------------------------------------------
# Approximate 3D face model (mm) for solvePnP
# ---------------------------------------------------------------------------
FACE_MODEL_3D = np.array([
    [  0.0,   0.0,   0.0],   # nose tip
    [  0.0, -63.6, -12.5],   # chin
    [-32.5,  32.5, -18.5],   # left eye outer corner
    [ 32.5,  32.5, -18.5],   # right eye outer corner
    [-28.0, -23.0, -15.0],   # left mouth corner
    [ 28.0, -23.0, -15.0],   # right mouth corner
], dtype=np.float32)


# ============================================================================
#  Feature Extractor
# ============================================================================
class FeatureExtractor:
    """Extract a 7-element normalised feature vector from face landmarks."""

    def __init__(self, frame_w: int, frame_h: int):
        self.fw = frame_w
        self.fh = frame_h
        self._iod0: float | None = None

        # Camera matrix (approximate — assumes ~60° HFOV)
        fx = frame_w / (2.0 * np.tan(np.deg2rad(30.0)))
        fy = fx
        cx, cy = frame_w / 2.0, frame_h / 2.0
        self.camera_matrix = np.array(
            [[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float32
        )
        self.dist_coeffs = np.zeros((4, 1), dtype=np.float32)

    # ------------------------------------------------------------------
    def extract(self, landmarks) -> np.ndarray | None:
        """
        landmarks: list-like of 478 NormalizedLandmark (.x, .y, .z).

        Returns a 7-element feature vector:
          [left_iris_x, left_iris_y, right_iris_x, right_iris_y,
           iod_ratio, head_yaw, head_pitch]
        or None if extraction fails.
        """
        # ---- helper to get pixel coords -------------------------------
        def _px(lm):
            return np.array([lm.x * self.fw, lm.y * self.fh], dtype=np.float32)

        def _dist(a, b):
            return float(np.linalg.norm(a - b))

        try:
            # ---- iris centres -----------------------------------------
            l_iris = _px(landmarks[LEFT_IRIS])
            r_iris = _px(landmarks[RIGHT_IRIS])

            # ---- left-eye socket -------------------------------------
            l_outer  = _px(landmarks[LEFT_EYE_OUTER])
            l_inner  = _px(landmarks[LEFT_EYE_INNER])
            l_top    = _px(landmarks[LEFT_EYE_TOP])
            l_bottom = _px(landmarks[LEFT_EYE_BOTTOM])

            l_w = max(1e-3, _dist(l_outer, l_inner))
            l_h = max(1e-3, _dist(l_top, l_bottom))
            nl_x = (l_iris[0] - l_outer[0]) / l_w
            nl_y = (l_iris[1] - min(l_top[1], l_bottom[1])) / l_h

            # ---- right-eye socket ------------------------------------
            r_outer  = _px(landmarks[RIGHT_EYE_OUTER])
            r_inner  = _px(landmarks[RIGHT_EYE_INNER])
            r_top    = _px(landmarks[RIGHT_EYE_TOP])
            r_bottom = _px(landmarks[RIGHT_EYE_BOTTOM])

            r_w = max(1e-3, _dist(r_outer, r_inner))
            r_h = max(1e-3, _dist(r_top, r_bottom))
            nr_x = (r_iris[0] - r_inner[0]) / r_w
            nr_y = (r_iris[1] - min(r_top[1], r_bottom[1])) / r_h

            # ---- inter-ocular distance ratio --------------------------
            l_c = (l_outer + l_inner) * 0.5
            r_c = (r_outer + r_inner) * 0.5
            iod = _dist(l_c, r_c)
            if self._iod0 is None:
                self._iod0 = iod
            iod_ratio = np.clip(iod / max(1e-6, self._iod0), 0.6, 1.6)

            # ---- head pose (yaw / pitch via solvePnP) -----------------
            img_pts = np.array(
                [
                    _px(landmarks[NOSE_TIP]),
                    _px(landmarks[CHIN]),
                    _px(landmarks[LEFT_EYE_CORNER]),
                    _px(landmarks[RIGHT_EYE_CORNER]),
                    _px(landmarks[LEFT_MOUTH]),
                    _px(landmarks[RIGHT_MOUTH]),
                ],
                dtype=np.float32,
            )

            ok, rvec, _tvec = cv2.solvePnP(
                FACE_MODEL_3D, img_pts,
                self.camera_matrix, self.dist_coeffs,
                flags=cv2.SOLVEPNP_ITERATIVE,
            )
            if not ok:
                yaw, pitch = 0.0, 0.0
            else:
                # Decompose rotation vector → Euler angles
                rmat, _ = cv2.Rodrigues(rvec)
                sy = np.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
                pitch = float(np.arctan2(-rmat[2, 0], sy))
                yaw   = float(np.arctan2(rmat[1, 0], rmat[0, 0]))
                # Normalise to roughly [-0.5, 0.5] rad
                pitch = np.clip(pitch, -0.6, 0.6)
                yaw   = np.clip(yaw,   -0.6, 0.6)

            return np.array(
                [nl_x, nl_y, nr_x, nr_y, iod_ratio, yaw, pitch],
                dtype=np.float32,
            )

        except (IndexError, AttributeError):
            return None


# ============================================================================
#  Calibration data & regression model
# ============================================================================
class CalibrationModel:
    """Collect calibration samples, fit a Ridge polynomial regression,
    and persist to disk."""

    def __init__(self, screen_w: int, screen_h: int, degree: int = 2):
        self.sw = screen_w
        self.sh = screen_h
        self.degree = degree
        self.X: list[np.ndarray] = []
        self.Y: list[tuple[float, float]] = []
        self.W: list[float] = []
        self.pipe_x: Pipeline | None = None
        self.pipe_y: Pipeline | None = None

    # ------------------------------------------------------------------
    def add(self, feat: np.ndarray, tx: float, ty: float):
        """Record a calibration sample with automatic edge weighting."""
        self.X.append(feat.astype(np.float32))
        self.Y.append((tx, ty))
        # Edge weight: points near screen edges get higher weight
        nx, ny = tx / self.sw, ty / self.sh
        edge = 1.0 - 2.0 * min(nx, 1 - nx, ny, 1 - ny)
        w = 1.0 + 1.5 * max(0.0, edge)
        self.W.append(w)

    # ------------------------------------------------------------------
    def fit(self):
        """Train Ridge regression with polynomial features."""
        if len(self.X) < 12:
            raise RuntimeError(
                f"Need ≥12 calibration samples, got {len(self.X)}"
            )
        X = np.vstack(self.X)
        Y = np.array(self.Y, dtype=np.float32)
        W = np.array(self.W, dtype=np.float32)

        self.pipe_x = Pipeline([
            ("poly", PolynomialFeatures(degree=self.degree, include_bias=True)),
            ("ridge", Ridge(alpha=1.0)),
        ])
        self.pipe_y = Pipeline([
            ("poly", PolynomialFeatures(degree=self.degree, include_bias=True)),
            ("ridge", Ridge(alpha=1.0)),
        ])
        self.pipe_x.fit(X, Y[:, 0], ridge__sample_weight=W)
        self.pipe_y.fit(X, Y[:, 1], ridge__sample_weight=W)

    # ------------------------------------------------------------------
    def predict(self, feat: np.ndarray) -> tuple[int, int]:
        """Predict screen coordinates from a feature vector."""
        if self.pipe_x is None or self.pipe_y is None:
            return (self.sw // 2, self.sh // 2)
        x = float(self.pipe_x.predict(feat.reshape(1, -1))[0])
        y = float(self.pipe_y.predict(feat.reshape(1, -1))[0])
        x = int(np.clip(x, 0, self.sw - 1))
        y = int(np.clip(y, 0, self.sh - 1))
        return (x, y)

    # ------------------------------------------------------------------
    def save(self, path: str):
        data = {
            "sw": self.sw, "sh": self.sh, "degree": self.degree,
            "X": [x.tolist() for x in self.X],
            "Y": [(float(y0), float(y1)) for (y0, y1) in self.Y],
            "W": [float(w) for w in self.W],
        }
        with open(path, "w") as f:
            json.dump(data, f)

    # ------------------------------------------------------------------
    def load(self, path: str):
        with open(path) as f:
            data = json.load(f)
        self.sw = data["sw"]
        self.sh = data["sh"]
        self.degree = data.get("degree", 2)
        self.X = [np.array(x, dtype=np.float32) for x in data["X"]]
        self.Y = [(float(y[0]), float(y[1])) for y in data["Y"]]
        self.W = data.get("W", [1.0] * len(self.X))
        self.fit()


# ============================================================================
#  Calibration UI  (full-screen Tk overlay with numbered dots)
# ============================================================================
class CalibrationUI:
    """Full-screen overlay that shows calibration points and captures
    feature vectors when the user presses Space."""

    def __init__(self, screen_w: int, screen_h: int):
        import tkinter as tk

        self.sw = screen_w
        self.sh = screen_h
        self._root = tk.Tk()
        self._root.overrideredirect(True)
        self._root.attributes("-topmost", True)
        self._root.configure(bg="black")
        self._root.geometry(f"{self.sw}x{self.sh}+0+0")

        # Semi-transparent overall
        self._root.attributes("-alpha", 0.85)

        self._canvas = tk.Canvas(
            self._root, width=self.sw, height=self.sh,
            bg="black", highlightthickness=0, bd=0,
        )
        self._canvas.pack()

        # Instruction text
        self._text_id = self._canvas.create_text(
            self.sw // 2, 40,
            text="Look at the dot, then press SPACE",
            fill="white", font=("Helvetica", 18),
        )
        # Current dot
        self._dot_id = self._canvas.create_oval(0, 0, 1, 1, fill="red", outline="red")

        # State
        self._space_pressed = False
        self._running = False

        self._root.bind("<space>", self._on_space)
        self._root.bind("<Escape>", self._on_esc)

    def _on_space(self, _event):
        self._space_pressed = True

    def _on_esc(self, _event):
        self._running = False

    # ------------------------------------------------------------------
    def show_point(self, x: int, y: int, label: str):
        """Display a calibration dot at (x, y) with a label."""
        r = 18
        self._canvas.coords(self._dot_id, x - r, y - r, x + r, y + r)
        self._canvas.itemconfig(self._text_id, text=label)
        self._root.update()

    # ------------------------------------------------------------------
    def wait_for_space(self, timeout_ms: int = 50) -> bool:
        """Process events. Return True if Space was pressed."""
        self._root.update()
        if self._space_pressed:
            self._space_pressed = False
            return True
        return False

    # ------------------------------------------------------------------
    def show_ok(self, x: int, y: int):
        """Briefly turn the dot green to confirm capture."""
        r = 22
        self._canvas.coords(self._dot_id, x - r, y - r, x + r, y + r)
        self._canvas.itemconfig(self._dot_id, fill="green", outline="green")
        self._canvas.itemconfig(self._text_id, text="✓  Captured!")
        self._root.update()
        time.sleep(0.4)
        # Reset to red
        self._canvas.itemconfig(self._dot_id, fill="red", outline="red")

    # ------------------------------------------------------------------
    def destroy(self):
        try:
            self._root.destroy()
        except Exception:
            pass

    def update(self):
        self._root.update()


# ============================================================================
#  Red-dot overlay  (tiny transparent window)
# ============================================================================
class GazeOverlay:
    """A borderless transparent window showing a red dot."""

    def __init__(self):
        import tkinter as tk

        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.wm_attributes("-transparent", True)
        self.root.configure(bg="systemTransparent")

        self.dot_size = 28
        self.radius   = self.dot_size // 2
        self.root.geometry(f"{self.dot_size}x{self.dot_size}+100+100")

        self.canvas = tk.Canvas(
            self.root, width=self.dot_size, height=self.dot_size,
            bg="systemTransparent", highlightthickness=0, bd=0,
        )
        self.canvas.pack()

        pad = 3
        self.canvas.create_oval(
            pad, pad,
            self.dot_size - pad, self.dot_size - pad,
            fill="#ff2020", outline="#aa0000", width=2,
        )

        self.screen_w = self.root.winfo_screenwidth()
        self.screen_h = self.root.winfo_screenheight()

    def move_to(self, x, y):
        if x is None or y is None:
            return
        left = max(0, min(self.screen_w - self.dot_size, x - self.radius))
        top  = max(0, min(self.screen_h - self.dot_size, y - self.radius))
        self.root.geometry(f"+{left}+{top}")

    def run(self):
        self.root.mainloop()


# ============================================================================
#  Calibration procedure
# ============================================================================
def _calibration_points(sw, sh, rows=3, cols=3, margin=0.12):
    """Generate a grid of calibration points (screen coords)."""
    xs = np.linspace(margin, 1.0 - margin, cols)
    ys = np.linspace(margin, 1.0 - margin, rows)
    return [(int(x * sw), int(y * sh)) for y in ys for x in xs]


def run_calibration(sw, sh, rows, cols) -> CalibrationModel:
    """Run the interactive calibration procedure, return a fitted model."""
    import tkinter as tk

    Tk = tk.Tk
    Tk().withdraw()  # ensure Tk is initialised

    calib = CalibrationModel(sw, sh, degree=2)
    ui    = CalibrationUI(sw, sh)
    feat_extractor: FeatureExtractor | None = None

    points = _calibration_points(sw, sh, rows=rows, cols=cols)

    # ---- set up camera & MediaPipe ----------------------
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        ui.destroy()
        raise RuntimeError("Cannot open webcam. Check permissions.")

    base_opts = python.BaseOptions(model_asset_path=MODEL_PATH)
    opts = vision.FaceLandmarkerOptions(
        base_options=base_opts,
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    with vision.FaceLandmarker.create_from_options(opts) as landmarker:
        t0 = time.monotonic()

        for i, (tx, ty) in enumerate(points, 1):
            done = False
            feat_extractor = None  # reset per point (IOD baseline)

            ui.show_point(tx, ty,
                          f"Point {i}/{len(points)} — look at the dot, press SPACE")

            while not done:
                ret, frame = cap.read()
                if not ret:
                    ui.update()
                    time.sleep(0.01)
                    continue

                frame = cv2.flip(frame, 1)
                h, w = frame.shape[:2]

                if feat_extractor is None:
                    feat_extractor = FeatureExtractor(w, h)

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts = int((time.monotonic() - t0) * 1000)
                result = landmarker.detect_for_video(mp_img, ts)

                if ui.wait_for_space():
                    if result.face_landmarks:
                        ui.show_point(tx, ty,
                                      f"Point {i}/{len(points)} — collecting samples …")

                        # Multi-frame averaging (0.4 s of samples)
                        samples = []
                        t_end = time.monotonic() + 0.4
                        while time.monotonic() < t_end:
                            ret2, frame2 = cap.read()
                            if not ret2:
                                continue
                            frame2 = cv2.flip(frame2, 1)
                            rgb2 = cv2.cvtColor(frame2, cv2.COLOR_BGR2RGB)
                            mp_img2 = mp.Image(
                                image_format=mp.ImageFormat.SRGB, data=rgb2
                            )
                            ts2 = int((time.monotonic() - t0) * 1000)
                            res2 = landmarker.detect_for_video(mp_img2, ts2)
                            if res2.face_landmarks:
                                fv = feat_extractor.extract(
                                    res2.face_landmarks[0]
                                )
                                if fv is not None:
                                    samples.append(fv)
                            ui.update()

                        if len(samples) >= 4:
                            mean_feat = np.mean(samples, axis=0)
                            calib.add(mean_feat, tx, ty)
                            print(f"  Point {i}: {len(samples)} samples")
                        elif result.face_landmarks:
                            fv = feat_extractor.extract(result.face_landmarks[0])
                            if fv is not None:
                                calib.add(fv, tx, ty)
                                print(f"  Point {i}: 1 sample (fallback)")

                        ui.show_ok(tx, ty)
                        done = True
                    else:
                        ui.show_point(tx, ty,
                                      f"No face detected — try again, press SPACE")

                ui.update()

        cap.release()
        ui.destroy()

    print(f"Training regression model on {len(calib.X)} samples …")
    calib.fit()
    print("Calibration complete!")
    return calib


# ============================================================================
#  Main application
# ============================================================================
class GazeTracker:
    def __init__(self, model: CalibrationModel):
        self.overlay     = GazeOverlay()
        self.model       = model
        self.latest_gaze = None
        self.lock        = threading.Lock()
        self.running     = False

    # ------------------------------------------------------------------
    def _camera_loop(self):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("❌  Cannot open webcam.")
            self.running = False
            return

        base_opts = python.BaseOptions(model_asset_path=MODEL_PATH)
        opts = vision.FaceLandmarkerOptions(
            base_options=base_opts,
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        extractor: FeatureExtractor | None = None

        with vision.FaceLandmarker.create_from_options(opts) as landmarker:
            t0 = time.monotonic()
            while self.running:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.005)
                    continue

                frame = cv2.flip(frame, 1)
                h, w = frame.shape[:2]

                if extractor is None:
                    extractor = FeatureExtractor(w, h)

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts = int((time.monotonic() - t0) * 1000)
                result = landmarker.detect_for_video(mp_img, ts)

                if result.face_landmarks:
                    fv = extractor.extract(result.face_landmarks[0])
                    if fv is not None:
                        x, y = self.model.predict(fv)
                        with self.lock:
                            self.latest_gaze = (x, y)

        cap.release()

    # ------------------------------------------------------------------
    def _update_overlay(self):
        with self.lock:
            gaze = self.latest_gaze

        if gaze is not None:
            self.overlay.move_to(*gaze)

        if self.running:
            self.overlay.root.after(16, self._update_overlay)
        else:
            self.overlay.root.quit()

    # ------------------------------------------------------------------
    def start(self):
        self.running = True

        cam_thread = threading.Thread(target=self._camera_loop, daemon=True)
        cam_thread.start()

        self.overlay.root.after(100, self._update_overlay)

        print("👁  Tracking …  (Ctrl+C to quit)")
        self.overlay.run()
        self.stop()

    def stop(self):
        self.running = False
        try:
            self.overlay.root.destroy()
        except Exception:
            pass


# ============================================================================
#  EMA smoothing wrapper
# ============================================================================
class SmoothingWrapper(CalibrationModel):
    """Wraps a CalibrationModel with EMA smoothing."""

    def __init__(self, inner: CalibrationModel, alpha: float = 0.35):
        super().__init__(inner.sw, inner.sh, inner.degree)
        self._inner = inner
        self._alpha = alpha
        self._ema: np.ndarray | None = None

    def predict(self, feat: np.ndarray) -> tuple[int, int]:
        x, y = self._inner.predict(feat)
        if self._ema is None:
            self._ema = np.array([x, y], dtype=np.float32)
        else:
            self._ema = (1 - self._alpha) * self._ema + \
                        self._alpha * np.array([x, y], dtype=np.float32)
        return (int(self._ema[0]), int(self._ema[1]))

    def fit(self):
        self._inner.fit()

    def save(self, path: str):
        self._inner.save(path)

    def load(self, path: str):
        self._inner.load(path)


# ============================================================================
#  Entry point
# ============================================================================
def main():
    parser = argparse.ArgumentParser(description="Gaze Tracker")
    parser.add_argument("--recalibrate", action="store_true",
                        help="Force recalibration even if saved data exists")
    parser.add_argument("--rows", type=int, default=3,
                        help="Calibration grid rows (default 3)")
    parser.add_argument("--cols", type=int, default=3,
                        help="Calibration grid columns (default 3)")
    parser.add_argument("--calib-only", action="store_true",
                        help="Only calibrate, don't start tracking")
    args = parser.parse_args()

    if not os.path.exists(MODEL_PATH):
        print(f"❌  Model not found: {MODEL_PATH}")
        print("   Download: curl -L -o face_landmarker.task "
              "https://storage.googleapis.com/mediapipe-models/"
              "face_landmarker/face_landmarker/float16/1/face_landmarker.task")
        return

    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    root.destroy()

    # ---- load or create calibration model ----
    if not args.recalibrate and os.path.exists(CALIB_PATH):
        print(f"📂  Loading saved calibration from {CALIB_PATH}")
        model = CalibrationModel(sw, sh)
        model.load(CALIB_PATH)
        print(f"   {len(model.X)} calibration points loaded.")
    else:
        print("🎯  Starting calibration …")
        print(f"   Grid: {args.rows}×{args.cols} = "
              f"{args.rows * args.cols} points")
        print("   Look at each red dot and press SPACE.\n")
        model = run_calibration(sw, sh, args.rows, args.cols)
        model.save(CALIB_PATH)
        print(f"   Saved → {CALIB_PATH}")

    if args.calib_only:
        print("✅  Calibration only — done.")
        return

    # Wrap with EMA smoothing
    smooth = SmoothingWrapper(model, alpha=0.35)

    tracker = GazeTracker(smooth)
    try:
        tracker.start()
    except KeyboardInterrupt:
        print("\n👋  Shutting down …")
        tracker.stop()


if __name__ == "__main__":
    main()
