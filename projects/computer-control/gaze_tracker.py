#!/usr/bin/env python3
"""
Gaze Tracker — webcam eye tracking powered by EyeTrax.

Pure module — does **not** contain CLI entry points or orchestration.
Import ``GazeTracker`` and call ``start_camera()`` + ``update()`` from
your own run loop.

Uses EyeTrax's GazeEstimator for head-pose-invariant gaze prediction
and a native macOS overlay (PyObjC NSWindow) for the red dot.
"""

import threading
import time

import cv2
import numpy as np

from eyetrax.filters import KalmanSmoother, make_kalman


# ============================================================================
#  Native macOS transparent red-dot overlay (PyObjC)
# ============================================================================

# Dot NSView subclass — defined at module level so it is only registered
# once with the Objective-C runtime.  Defining it inside _create_overlay()
# would fail on the second call ("overriding existing Objective-C class").

from Cocoa import (  # type: ignore[import-untyped]
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSBackingStoreBuffered,
    NSBezierPath,
    NSBorderlessWindowMask,
    NSColor,
    NSFloatingWindowLevel,
    NSMakeRect,
    NSPoint,
    NSScreen,
    NSView,
    NSWindow,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowCollectionBehaviorFullScreenAuxiliary,
    NSWindowCollectionBehaviorStationary,
)


class _DotView(NSView):
    """NSView subclass that draws a pulsing red dot."""

    PAD = 3

    def drawRect_(self, rect):
        bounds = self.bounds()
        w, h = bounds.size.width, bounds.size.height
        dot_rect = NSMakeRect(
            self.PAD, self.PAD, w - 2 * self.PAD, h - 2 * self.PAD
        )
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


def _create_overlay():
    """Create a native macOS overlay window with a red dot.

    Returns ``(app, window, screen_w, screen_h, dot_size)``.
    """
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

    frame = NSScreen.mainScreen().frame()
    screen_w = int(frame.size.width)
    screen_h = int(frame.size.height)

    DOT_SIZE = 28

    # ---- Window --------------------------------------------------------
    # NSNonactivatingPanelMask (0x80) is deprecated on macOS 15.
    # Use NSBorderlessWindowMask alone — the collection behavior flags
    # below already handle floating + all-spaces behaviour.
    style = NSBorderlessWindowMask
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
    window.setCollectionBehavior_(
        NSWindowCollectionBehaviorCanJoinAllSpaces
        | NSWindowCollectionBehaviorStationary
        | NSWindowCollectionBehaviorFullScreenAuxiliary
    )

    dot_view = _DotView.alloc().initWithFrame_(rect)
    window.setContentView_(dot_view)
    window.orderFrontRegardless()

    return app, window, screen_w, screen_h, DOT_SIZE


# ============================================================================
#  GazeTracker
# ============================================================================

class GazeTracker:
    """Eye-tracking engine with native macOS overlay.

    Parameters
    ----------
    estimator:
        A pre-configured ``eyetrax.GazeEstimator`` (model loaded / calibrated).
    tune:
        If True, auto-tune the Kalman filter on the camera feed at startup.
    """

    def __init__(self, estimator, tune: bool = True) -> None:
        _app, window, sw, sh, dot_size = _create_overlay()
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

        self.latest_gaze: tuple[int, int] | None = None
        self._lock = threading.Lock()
        self._running = False
        self._cam_thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    #  Overlay
    # ------------------------------------------------------------------

    def move_overlay(self, x: float, y: float) -> None:
        """Move the red-dot overlay to Cocoa *(x, y)* (bottom-left origin)."""
        y_flipped = self._sh - y  # Cocoa → flipped for NSWindow
        left = max(0, min(self._sw - self._dot_size, int(x) - self._radius))
        top = max(0, min(self._sh - self._dot_size, int(y_flipped) - self._radius))
        self._window.setFrameOrigin_(NSPoint(left, top))

    # ------------------------------------------------------------------
    #  Camera
    # ------------------------------------------------------------------

    def _camera_loop(self) -> None:
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("\u274c  Cannot open webcam.")
            self._running = False
            return

        while self._running:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.005)
                continue

            features, blink = self.estimator.extract_features(frame)

            if features is not None and not blink:
                gaze = self.estimator.predict(np.array([features]))[0]
                x_raw, y_raw = map(int, gaze)
                x, y = self.smoother.step(x_raw, y_raw)
                with self._lock:
                    self.latest_gaze = (x, y)

        cap.release()

    def start_camera(self) -> None:
        """Launch the background camera thread."""
        self._running = True
        self._cam_thread = threading.Thread(target=self._camera_loop, daemon=True)
        self._cam_thread.start()

    # ------------------------------------------------------------------
    #  Per-frame update (call from main thread / run loop)
    # ------------------------------------------------------------------

    def update(self) -> tuple[int, int] | None:
        """Read the latest gaze and move the overlay.

        Must be called from the main thread (the one pumping the Cocoa
        run loop).  Returns the current ``(x, y)`` gaze point in Cocoa
        (bottom-left) coordinates, or *None* if no gaze is available yet.
        """
        with self._lock:
            gaze = self.latest_gaze

        if gaze is not None:
            self.move_overlay(*gaze)
        return gaze

    # ------------------------------------------------------------------
    #  Lifecycle
    # ------------------------------------------------------------------

    def stop(self) -> None:
        """Stop tracking and release the camera."""
        self._running = False
        if self._cam_thread is not None:
            self._cam_thread.join(timeout=1.0)

    @property
    def screen_size(self) -> tuple[int, int]:
        """Return the main screen ``(width, height)`` in pixels."""
        return (self._sw, self._sh)
