#!/usr/bin/env python3
"""
Computer Control — gaze-driven UI interaction.

Orchestrates the eye gaze tracker and UI element detector:

    python computer_control.py [--recalibrate] [--rows N] [--cols N]
                               [--model NAME] [--no-tune] [--calib-only]
                               [--no-ui-detection]

Press **Ctrl+C** to quit.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

from eyetrax import GazeEstimator
from eyetrax.calibration import run_dense_grid_calibration


# ============================================================================
#  Element highlighter — fullscreen transparent overlay for UI boxes
# ============================================================================

# Role → colour mapping for element borders
_ROLE_COLORS: dict[str, tuple[float, float, float]] = {
    "AXButton":       (0.2, 0.6, 1.0),   # blue
    "AXTextField":    (1.0, 0.7, 0.1),   # amber
    "AXTextArea":     (1.0, 0.5, 0.1),   # orange
    "AXCheckbox":     (1.0, 0.4, 0.7),   # pink
    "AXPopUpButton":  (0.4, 0.9, 0.3),   # green
    "AXMenuButton":   (0.4, 0.9, 0.3),   # green
    "AXSlider":       (0.8, 0.3, 1.0),   # purple
    "AXRadioButton":  (1.0, 0.4, 0.7),   # pink
    "AXMenuItem":     (0.2, 0.8, 0.8),   # teal
    "AXTabGroup":     (0.5, 0.5, 1.0),   # indigo
    "AXToolbar":      (0.6, 0.6, 0.6),   # grey
    "AXScrollArea":   (0.5, 0.5, 0.5),   # dim grey
    "AXWindow":       (1.0, 0.3, 0.3),   # red
    "AXGroup":        (0.5, 0.5, 0.5),   # grey
}

_FOCUSED_COLOR = (0.0, 1.0, 0.8)   # cyan — element under gaze
_NEARBY_COLOR  = (0.4, 0.4, 0.4)   # dim — nearby but not focused


def _role_color(role: str | None) -> tuple[float, float, float]:
    """Return an RGB colour tuple for an AX role."""
    if role is None:
        return (0.5, 0.5, 0.5)
    return _ROLE_COLORS.get(role, (0.7, 0.7, 0.7))


_highlight_counter = 0

class _HighlightView:
    """Fullscreen transparent NSView that draws element boxes + labels."""

    def __init__(self, screen_w: int, screen_h: int) -> None:
        global _highlight_counter
        from Cocoa import (  # type: ignore[import-untyped]
            NSApplication,
            NSApplicationActivationPolicyAccessory,
            NSBackingStoreBuffered,
            NSBezierPath,
            NSBorderlessWindowMask,
            NSColor,
            NSFloatingWindowLevel,
            NSFont,
            NSMakeRect,
            NSPoint,
            NSView,
            NSWindow,
            NSWindowCollectionBehaviorCanJoinAllSpaces,
            NSWindowCollectionBehaviorFullScreenAuxiliary,
            NSWindowCollectionBehaviorStationary,
        )

        self._sw = screen_w
        self._sh = screen_h

        # Mutable state read on the main thread (Cocoa drawRect callback).
        self._focused: dict[str, Any] | None = None
        self._nearby: list[dict[str, Any]] = []

        # Unique class name per instance to avoid ObjC class conflicts
        _highlight_counter += 1
        cls_name = f"_HighlightNSView{_highlight_counter}"

        # ---- Custom NSView ----------------------------------------------
        _outer = self  # capture for the inner class
        nsview_cls = type(cls_name, (NSView,), {
            "drawRect_": lambda _self, rect: _outer._draw(_self),
        })

        # ---- Window -----------------------------------------------------
        app = NSApplication.sharedApplication()
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

        rect = NSMakeRect(0, 0, screen_w, screen_h)
        style = NSBorderlessWindowMask
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, style, NSBackingStoreBuffered, False
        )
        self._window.setLevel_(NSFloatingWindowLevel + 1)  # above the red dot
        self._window.setOpaque_(False)
        self._window.setBackgroundColor_(NSColor.clearColor())
        self._window.setHasShadow_(False)
        self._window.setIgnoresMouseEvents_(True)
        self._window.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorFullScreenAuxiliary
        )

        self._view = nsview_cls.alloc().initWithFrame_(rect)
        self._window.setContentView_(self._view)
        self._window.orderFrontRegardless()

    # ------------------------------------------------------------------
    #  Public API
    # ------------------------------------------------------------------

    def set_elements(
        self, focused: dict[str, Any] | None,
        nearby: list[dict[str, Any]] | None = None,
    ) -> None:
        """Set the element(s) to highlight.  Call from main thread."""
        self._focused = focused
        self._nearby = nearby or []
        self._view.setNeedsDisplay_(True)

    def clear(self) -> None:
        """Remove all highlights."""
        self._focused = None
        self._nearby = []
        self._view.setNeedsDisplay_(True)

    # ------------------------------------------------------------------
    #  Drawing (called from Cocoa drawRect)
    # ------------------------------------------------------------------

    def _draw(self, view: Any) -> None:
        """Draw all element boxes on *view*."""
        from Cocoa import NSBezierPath, NSColor, NSFont, NSMakeRect

        # --- Nearby elements (dim, thinner) -------------------------------
        for elem in self._nearby:
            self._draw_box(
                elem, color=_NEARBY_COLOR, line_width=1.5,
                alpha=0.5, show_label=False,
            )

        # --- Focused element (bright, thick, with label) -----------------
        if self._focused:
            role = self._focused.get("role")
            color = _FOCUSED_COLOR
            self._draw_box(
                self._focused, color=color, line_width=3.0,
                alpha=0.9, show_label=True,
            )

    def _draw_box(
        self, elem: dict[str, Any], *,
        color: tuple[float, float, float],
        line_width: float, alpha: float, show_label: bool,
    ) -> None:
        """Draw one element box."""
        from Cocoa import NSColor, NSBezierPath, NSFont, NSMakeRect, NSPoint, NSString

        pos = elem.get("position")
        size = elem.get("size")
        if pos is None or size is None:
            return

        # *pos* is in top-left screen coords from ui_detector.
        # NSView uses bottom-left (Cocoa) coords → flip Y.
        tl_x, tl_y = pos
        w, h = size
        cx = tl_x
        cy = self._sh - tl_y - h  # top-left y → Cocoa bottom-left y

        rect = NSMakeRect(cx, cy, w, h)

        r, g, b = color

        # --- Border -------------------------------------------------------
        path = NSBezierPath.bezierPathWithRect_(rect)
        NSColor.colorWithRed_green_blue_alpha_(r, g, b, alpha).set()
        path.setLineWidth_(line_width)
        path.stroke()

        # --- Subtle fill --------------------------------------------------
        NSColor.colorWithRed_green_blue_alpha_(r, g, b, 0.08).set()
        path.fill()

        # --- Label --------------------------------------------------------
        if show_label:
            role = elem.get("role", "")
            title = elem.get("title") or ""
            # Strip "AX" prefix for readability
            short_role = role[2:] if role and role.startswith("AX") else role
            label = f"{short_role}"
            if title and len(title) < 30:
                label += f" \u2014 {title}"

            font_size = 11.0
            font = NSFont.systemFontOfSize_(font_size)
            # Cocoa attribute keys are NSString constants exposed as
            # unicode strings by PyObjC.
            attrs = {
                "NSFont": font,
                "NSColor":
                    NSColor.colorWithRed_green_blue_alpha_(r, g, b, 0.95),
            }
            label_y = cy + h + 4
            label_x = cx + 2

            ns_str = NSString.stringWithString_(label)
            txt_size = ns_str.sizeWithAttributes_(attrs)
            # Background pill for readability
            pill_rect = NSMakeRect(
                label_x - 3, label_y - 1,
                txt_size.width + 6, txt_size.height + 4,
            )
            NSColor.colorWithRed_green_blue_alpha_(0.0, 0.0, 0.0, 0.7).set()
            pill_path = NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
                pill_rect, 4.0, 4.0,
            )
            pill_path.fill()

            # Draw text in the element's colour
            ns_str.drawAtPoint_withAttributes_(
                NSPoint(label_x, label_y), attrs,
            )

    # ------------------------------------------------------------------
    #  Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Destroy the highlight window."""
        if self._window is not None:
            self._window.close()
            self._window = None

# ---------------------------------------------------------------------------
#  Project paths
# ---------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH = PROJECT_DIR / "gaze_model.pkl"
os.environ.setdefault(
    "EYETRAX_FACE_LANDMARKER_MODEL",
    str(PROJECT_DIR / "face_landmarker.task"),
)


# ============================================================================
#  Orchestrator
# ============================================================================

class ComputerControl:
    """Top-level orchestrator that wires gaze tracking + UI detection.

    Parameters
    ----------
    enable_ui_detection:
        When False, skips the UI detector entirely (gaze dot only).
    """

    def __init__(self, estimator: GazeEstimator, *, tune: bool = True,
                 enable_ui_detection: bool = True) -> None:
        # --- Gaze tracker -------------------------------------------------
        from gaze_tracker import GazeTracker

        self._tracker = GazeTracker(estimator, tune=tune)
        sw, sh = self._tracker.screen_size
        print(f"\U0001f5fa  Screen: {sw}\u00d7{sh}")

        # --- UI detector --------------------------------------------------
        self._ui_enabled = enable_ui_detection
        self._detector: Any = None
        self._highlighter: _HighlightView | None = None
        if enable_ui_detection:
            try:
                from ui_detector import UIDetector
                self._detector = UIDetector(sw, sh)
                self._highlighter = _HighlightView(sw, sh)
                print("   UI detector + highlighter: ready")
            except Exception as e:
                print(f"   UI detector: unavailable ({e})")
                self._ui_enabled = False

        self._running = False

    # ------------------------------------------------------------------
    #  Main loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Start tracking and enter the main event loop (blocks until Ctrl+C)."""
        self._tracker.start_camera()
        self._running = True

        from Cocoa import NSDate, NSDefaultRunLoopMode, NSRunLoop

        _last_window_refresh = 0.0

        print("\U0001f441  Tracking …  (Ctrl+C to quit)")
        try:
            while self._running:
                # --- 1. Move overlay to latest gaze -----------------------
                gaze = self._tracker.update()

                # --- 2. Detect UI element at gaze point -------------------
                if gaze is not None and self._detector is not None:
                    try:
                        focused = self._detector.detect(*gaze)
                        nearby = self._detector.detect_nearby(*gaze, radius=60)
                        # Remove the focused element from nearby list
                        if focused and nearby:
                            nearby = [
                                e for e in nearby
                                if e.get("position") != focused.get("position")
                                or e.get("role") != focused.get("role")
                            ]
                        if self._highlighter is not None:
                            self._highlighter.set_elements(focused, nearby)
                    except Exception:
                        pass

                # --- 3. Periodic window-cache refresh ---------------------
                now = time.monotonic()
                if (
                    self._detector is not None
                    and now - _last_window_refresh > 0.5
                ):
                    try:
                        self._detector.get_windows(force_refresh=True)
                    except Exception:
                        pass
                    _last_window_refresh = now

                # --- 4. Pump Cocoa event loop (renders the overlay) -------
                NSRunLoop.currentRunLoop().runMode_beforeDate_(
                    NSDefaultRunLoopMode,
                    NSDate.dateWithTimeIntervalSinceNow_(1.0 / 60.0),
                )
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self) -> None:
        """Stop tracking and clean up."""
        self._running = False
        self._tracker.stop()
        if self._highlighter is not None:
            self._highlighter.clear()
            self._highlighter.close()
        print("\n\U0001f44b  Shutting down …")


# ============================================================================
#  CLI
# ============================================================================

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Computer Control — gaze-driven UI interaction"
    )
    p.add_argument(
        "--recalibrate", action="store_true",
        help="Force re-calibration even if a saved model exists",
    )
    p.add_argument(
        "--calib-only", action="store_true",
        help="Only calibrate, don't start tracking",
    )
    p.add_argument(
        "--rows", type=int, default=9,
        help="Calibration grid rows (default 9, more = better accuracy)",
    )
    p.add_argument(
        "--cols", type=int, default=9,
        help="Calibration grid columns (default 9)",
    )
    p.add_argument(
        "--model", default="ridge",
        choices=["ridge", "elastic_net", "linear_svr", "tiny_mlp"],
        help="Gaze prediction model (default ridge)",
    )
    p.add_argument(
        "--no-tune", action="store_true",
        help="Skip Kalman filter auto-tuning",
    )
    p.add_argument(
        "--no-ui-detection", action="store_true",
        help="Disable UI element detection (red dot only)",
    )
    return p


def main(argv: list[str] | None = None) -> None:
    args = _build_parser().parse_args(argv)

    # ---- Estimator (load calibration or run new calibration) ------------
    estimator = GazeEstimator(model_name=args.model)

    if not args.recalibrate and MODEL_PATH.exists():
        print(f"\U0001f4c2  Loading saved model from {MODEL_PATH}")
        estimator.load_model(str(MODEL_PATH))
    else:
        grid = args.rows * args.cols
        print(
            f"\U0001f3af  Starting calibration "
            f"({args.rows}\u00d7{args.cols} = {grid} points) …"
        )
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

    # ---- Run ------------------------------------------------------------
    app = ComputerControl(
        estimator,
        tune=not args.no_tune,
        enable_ui_detection=not args.no_ui_detection,
    )
    try:
        app.run()
    except KeyboardInterrupt:
        app.stop()


if __name__ == "__main__":
    main()
