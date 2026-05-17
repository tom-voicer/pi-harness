#!/usr/bin/env python3
"""
Gaze Tracker — webcam eye tracking powered by EyeTrax.

Uses EyeTrax's GazeEstimator for accurate, head-pose-invariant gaze
prediction and a native macOS overlay to show a red dot on screen.

Calibration is automatic (EyeTrax handles it — no keypresses needed).
Model is saved to gaze_model.pkl for reuse.

Press Ctrl+C in the terminal to quit.
"""

import argparse
import os
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from eyetrax import GazeEstimator
from eyetrax.calibration import run_dense_grid_calibration
from eyetrax.filters import KalmanSmoother, make_kalman

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH = PROJECT_DIR / "gaze_model.pkl"

os.environ.setdefault(
    "EYETRAX_FACE_LANDMARKER_MODEL",
    str(PROJECT_DIR / "face_landmarker.task"),
)


# ============================================================================
#  Native macOS transparent red-dot overlay (PyObjC)
# ============================================================================
def _create_overlay():
    """Create a native macOS overlay window with a red dot.

    Uses PyObjC NSWindow because Tkinter crashes on Python 3.14 +
    macOS 15 (Tk calls the removed -[NSApplication macOSVersion]).
    """
    from Cocoa import (
        NSApplication,
        NSWindow,
        NSView,
        NSColor,
        NSBezierPath,
        NSMakeRect,
        NSPoint,
        NSScreen,
        NSBorderlessWindowMask,
        NSNonactivatingPanelMask,
        NSFloatingWindowLevel,
        NSBackingStoreBuffered,
        NSApplicationActivationPolicyAccessory,
    )

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

    frame = NSScreen.mainScreen().frame()
    screen_w = int(frame.size.width)
    screen_h = int(frame.size.height)

    DOT_SIZE = 28
    PAD = 3

    # ---- Dot NSView subclass -------------------------------------------
    class DotView(NSView):
        def drawRect_(self, rect):
            bounds = self.bounds()
            w, h = bounds.size.width, bounds.size.height
            dot_rect = NSMakeRect(PAD, PAD, w - 2 * PAD, h - 2 * PAD)

            # Red fill
            NSColor.colorWithRed_green_blue_alpha_(
                1.0, 0.125, 0.125, 0.9
            ).set()
            path = NSBezierPath.bezierPathWithOvalInRect_(dot_rect)
            path.fill()

            # Darker outline
            NSColor.colorWithRed_green_blue_alpha_(
                0.67, 0.0, 0.0, 0.9
            ).set()
            path.setLineWidth_(2.0)
            path.stroke()

    # ---- Window --------------------------------------------------------
    style = NSBorderlessWindowMask | NSNonactivatingPanelMask
    rect = NSMakeRect(100, screen_h - 100 - DOT_SIZE, DOT_SIZE, DOT_SIZE)
    window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        rect, style, NSBackingStoreBuffered, False
    )
    window.setLevel_(NSFloatingWindowLevel)
    window.setOpaque_(False)
    window.setBackgroundColor_(NSColor.clearColor())
    window.setHasShadow_(False)
    window.setIgnoresMouseEvents_(True)

    # Stay on top across all Spaces / fullscreen apps
    from Cocoa import (
        NSWindowCollectionBehaviorCanJoinAllSpaces,
        NSWindowCollectionBehaviorStationary,
        NSWindowCollectionBehaviorFullScreenAuxiliary,
    )
    window.setCollectionBehavior_(
        NSWindowCollectionBehaviorCanJoinAllSpaces
        | NSWindowCollectionBehaviorStationary
        | NSWindowCollectionBehaviorFullScreenAuxiliary
    )

    dot_view = DotView.alloc().initWithFrame_(rect)
    window.setContentView_(dot_view)
    window.orderFrontRegardless()

    return app, window, screen_w, screen_h, DOT_SIZE


# ============================================================================
#  Tracker
# ============================================================================
class GazeTracker:
    def __init__(self, estimator: GazeEstimator, tune: bool = True):
        _, window, sw, sh, dot_size = _create_overlay()
        self._window = window
        self._sw = sw
        self._sh = sh
        self._dot_size = dot_size
        self._radius = dot_size // 2

        self.estimator = estimator
        self.smoother = KalmanSmoother(make_kalman())

        if tune:
            print("   Auto-tuning Kalman filter …")
            try:
                self.smoother.tune(estimator, camera_index=0)
            except Exception as e:
                print(f"   (tuning skipped: {e})")

        self.latest_gaze = None
        self.lock = threading.Lock()
        self.running = False

    def move_overlay(self, x, y):
        if x is None or y is None:
            return
        from Cocoa import NSPoint

        y = self._sh - y  # flip Y for Cocoa coords
        left = max(0, min(self._sw - self._dot_size, x - self._radius))
        top = max(0, min(self._sh - self._dot_size, y - self._radius))
        self._window.setFrameOrigin_(NSPoint(left, top))

    def _camera_loop(self):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("\u274c  Cannot open webcam.")
            self.running = False
            return

        while self.running:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.005)
                continue

            features, blink = self.estimator.extract_features(frame)

            if features is not None and not blink:
                gaze = self.estimator.predict(np.array([features]))[0]
                x_raw, y_raw = map(int, gaze)
                x, y = self.smoother.step(x_raw, y_raw)
                with self.lock:
                    self.latest_gaze = (x, y)

        cap.release()

    def _update_overlay(self):
        with self.lock:
            gaze = self.latest_gaze

        if gaze is not None:
            self.move_overlay(*gaze)

    def start(self):
        self.running = True

        cam_thread = threading.Thread(target=self._camera_loop, daemon=True)
        cam_thread.start()

        print("\U0001f441  Tracking …  (Ctrl+C to quit)")

        # Polling loop that also pumps the Cocoa event loop so the
        # overlay window actually renders on screen.
        from Cocoa import NSDate, NSDefaultRunLoopMode, NSRunLoop

        try:
            while self.running:
                self._update_overlay()
                # Pump one event-loop iteration (renders the window)
                NSRunLoop.currentRunLoop().runMode_beforeDate_(
                    NSDefaultRunLoopMode,
                    NSDate.dateWithTimeIntervalSinceNow_(1.0 / 60.0),
                )
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self):
        self.running = False


# ============================================================================
#  Entry point
# ============================================================================
def main():
    parser = argparse.ArgumentParser(description="Gaze Tracker")
    parser.add_argument(
        "--recalibrate",
        action="store_true",
        help="Force recalibration even if saved model exists",
    )
    parser.add_argument(
        "--calib-only",
        action="store_true",
        help="Only calibrate, don't start tracking",
    )
    parser.add_argument(
        "--rows", type=int, default=9,
        help="Calibration grid rows (default 9, more = better accuracy)",
    )
    parser.add_argument(
        "--cols", type=int, default=9,
        help="Calibration grid columns (default 9)",
    )
    parser.add_argument(
        "--model", default="ridge",
        choices=["ridge", "elastic_net", "linear_svr", "tiny_mlp"],
        help="Gaze prediction model (default ridge)",
    )
    parser.add_argument(
        "--no-tune", action="store_true",
        help="Skip Kalman filter auto-tuning",
    )
    args = parser.parse_args()

    # ---- Load or create estimator ----
    estimator = GazeEstimator(model_name=args.model)

    if not args.recalibrate and MODEL_PATH.exists():
        print(f"\U0001f4c2  Loading saved model from {MODEL_PATH}")
        estimator.load_model(str(MODEL_PATH))
    else:
        grid = args.rows * args.cols
        print(f"\U0001f3af  Starting calibration ({args.rows}×{args.cols} = {grid} points) …")
        print("   Look at each green dot.  It will pulse, then capture.")
        print("   No keypresses needed — just keep looking at the dots.\n")
        run_dense_grid_calibration(
            estimator,
            rows=args.rows,
            cols=args.cols,
            camera_index=0,
        )
        estimator.save_model(str(MODEL_PATH))
        print(f"   Model saved \u2192 {MODEL_PATH}")

    if args.calib_only:
        print("\u2705  Calibration only — done.")
        return

    tracker = GazeTracker(estimator, tune=not args.no_tune)
    try:
        tracker.start()
    except KeyboardInterrupt:
        print("\n\U0001f44b  Shutting down …")
        tracker.stop()


if __name__ == "__main__":
    main()
