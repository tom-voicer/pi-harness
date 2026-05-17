#!/usr/bin/env python3
"""
UI Element Detector — identifies macOS UI elements under or near a screen point.

Uses the macOS Accessibility API (AXUIElement) for sub-millisecond hit-testing
and CGWindowListCopyWindowInfo for periodic window enumeration.

All coordinates are **top-left screen coordinates** (y-down from top),
matching the AX API and EyeTrax gaze output.

    from ui_detector import UIDetector, hit_test_at

    # Stateless hit-test
    elem = hit_test_at(screen_x=500, screen_y=300)

    # Stateful — nearby sampling + window cache
    detector = UIDetector(screen_w, screen_h)
    elem = detector.detect(screen_x, screen_y)
    nearby = detector.detect_nearby(screen_x, screen_y, radius=50)
"""

import os
import time
from typing import Any

# ---------------------------------------------------------------------------
#  PyObjC imports (macOS only)
# ---------------------------------------------------------------------------
from ApplicationServices import (  # type: ignore[import-untyped]
    AXUIElementCreateSystemWide,
    AXUIElementCopyElementAtPosition,
    AXUIElementCopyAttributeValue,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)

import Quartz  # type: ignore[import-untyped]


# ---------------------------------------------------------------------------
#  AxValue helpers
# ---------------------------------------------------------------------------

def _parse_cgpoint(axvalue: Any) -> tuple[float, float] | None:
    """Extract (x, y) from an AXValue CGPoint."""
    if axvalue is None:
        return None
    try:
        _, cgpt = AXValueGetValue(axvalue, kAXValueCGPointType, None)
        return (float(cgpt.x), float(cgpt.y))
    except Exception:
        return None


def _parse_cgsize(axvalue: Any) -> tuple[float, float] | None:
    """Extract (width, height) from an AXValue CGSize."""
    if axvalue is None:
        return None
    try:
        _, cgsz = AXValueGetValue(axvalue, kAXValueCGSizeType, None)
        return (float(cgsz.width), float(cgsz.height))
    except Exception:
        return None


# ---------------------------------------------------------------------------
#  Attribute access
# ---------------------------------------------------------------------------

def _get_attr(element: Any, attr_name: str) -> Any:
    """Read a single accessibility attribute.  Returns None on any error."""
    if element is None:
        return None
    try:
        err, val = AXUIElementCopyAttributeValue(element, attr_name, None)
        return val if err == 0 else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
#  Parent walk
# ---------------------------------------------------------------------------

def _parent_info(element: Any) -> dict[str, str | None]:
    """Walk up the AX tree to find the containing window and application."""
    info: dict[str, str | None] = {"window_title": None, "app_name": None}
    current = element
    for _ in range(10):
        parent = _get_attr(current, "AXParent")
        if parent is None or parent is current:
            break
        role = _get_attr(parent, "AXRole")
        if role == "AXWindow" and info["window_title"] is None:
            info["window_title"] = _get_attr(parent, "AXTitle")
        elif role == "AXApplication" and info["app_name"] is None:
            info["app_name"] = _get_attr(parent, "AXTitle")
        if info["window_title"] and info["app_name"]:
            break
        current = parent
    return info


# ---------------------------------------------------------------------------
#  Core hit-test
# ---------------------------------------------------------------------------

def hit_test_at(
    ax_x: float, ax_y: float, *, include_value: bool = False
) -> dict[str, Any] | None:
    """
    Hit-test the accessibility tree at AX **top-left origin** coordinates.

    Returns a dict of element properties, or *None* if nothing is found
    or the accessibility API is unavailable.  Per-call latency ≈ 0.2 ms
    when *include_value* is False (default).

    .. warning::

       Set *include_value* = True **only when you need the element's text
       content**.  Reading ``AXValue`` on a large text area (terminal,
       editor, …) costs ~16 ms by itself — 80× slower than all other
       attributes combined.

    Return keys (all optional — missing attributes are ``None``):

    * ``role`` — ``"AXButton"``, ``"AXTextField"``, ``"AXWindow"``, …
    * ``role_description`` — human-readable like ``"button"``
    * ``title``         — element label / name
    * ``description``   — accessibility description text
    * ``value``         — current value (text, toggle state, …) — only when
      *include_value* is True
    * ``position``      — ``(x, y)`` in **AX** (top-left) coordinates
    * ``size``          — ``(width, height)``
    * ``enabled``       — bool or None
    * ``focused``       — bool or None
    * ``window_title``  — parent AXWindow title
    * ``app_name``      — parent AXApplication name
    """
    system = AXUIElementCreateSystemWide()
    if system is None:
        return None

    try:
        error, element = AXUIElementCopyElementAtPosition(
            system, float(ax_x), float(ax_y), None
        )
    except Exception:
        return None

    if error != 0 or element is None:
        return None

    info: dict[str, Any] = {
        "role": _get_attr(element, "AXRole"),
        "title": _get_attr(element, "AXTitle"),
        "description": _get_attr(element, "AXDescription"),
        "role_description": _get_attr(element, "AXRoleDescription"),
        "enabled": _get_attr(element, "AXEnabled"),
        "focused": _get_attr(element, "AXFocused"),
        "value": _get_attr(element, "AXValue") if include_value else None,
        "position": _parse_cgpoint(_get_attr(element, "AXPosition")),
        "size": _parse_cgsize(_get_attr(element, "AXSize")),
    }

    # ---- Normalise position for scrollable content ---------------------
    # Scrolled text areas report content-coordinate positions that can
    # be far off-screen (e.g. y = -9944).  Walk up to the first ancestor
    # with a reasonable on-screen position.
    pos = info["position"]
    if pos is not None:
        px, py = pos
        # Heuristic: if the Y is far from a typical screen range, it's
        # probably a content-space coordinate.
        if py < -2000 or py > 10000:
            current = element
            for _ in range(10):
                parent = _get_attr(current, "AXParent")
                if parent is None:
                    break
                pp = _parse_cgpoint(_get_attr(parent, "AXPosition"))
                if pp is not None and -2000 <= pp[1] <= 10000:
                    # Use ancestor's position but keep element's size
                    # (clamped to ancestor's size if larger)
                    info["position"] = pp
                    ps = _parse_cgsize(_get_attr(parent, "AXSize"))
                    if info["size"] and ps:
                        ew, eh = info["size"]
                        pw, ph = ps
                        # If element is larger than parent, clamp
                        if eh > ph * 2:  # clearly content-sized, not viewport
                            info["size"] = ps
                    break
                current = parent

    info.update(_parent_info(element))
    return info


# ============================================================================
#  UIDetector — stateful wrapper with window cache & nearby sampling
# ============================================================================

class UIDetector:
    """High-level UI element detector.

    Parameters
    ----------
    screen_width, screen_height:
        Pixel dimensions of the primary display (from ``NSScreen.mainScreen()``).

    The detector uses **top-left (screen) coordinates** for its public API,
    matching the coordinate system of EyeTrax gaze output and the macOS
    Accessibility API.  Both input and output coordinates use this convention.

    .. note::

       The NSView-based highlighter in ``computer_control.py`` handles
       the Y-flip to Cocoa (bottom‑left) coordinates for drawing.
    """

    def __init__(self, screen_width: int, screen_height: int) -> None:
        self._sw = screen_width
        self._sh = screen_height
        self._system_wide = AXUIElementCreateSystemWide()
        self._my_pid = os.getpid()

        # Window cache (populated by CGWindowListCopyWindowInfo)
        self._window_cache: list[dict[str, Any]] = []
        self._window_cache_time = 0.0  # monotonic seconds

    # ------------------------------------------------------------------
    #  Self-filtering
    # ------------------------------------------------------------------

    def _is_own_element(self, element_info: dict[str, Any]) -> bool:
        """Return True if *element_info* belongs to our own process."""
        app = element_info.get("app_name")
        return bool(app and isinstance(app, str) and "python" in app.lower())

    # ------------------------------------------------------------------
    #  Detection
    # ------------------------------------------------------------------

    def detect(
        self, screen_x: float, screen_y: float, *, include_value: bool = False
    ) -> dict[str, Any] | None:
        """
        Return the UI element at *(screen_x, screen_y)* in **top-left
        screen coordinates** (matching EyeTrax gaze output), or *None*.

        The returned ``position`` is also in top-left coordinates.
        Call latency ≈ 0.2 ms without *include_value*, ~16 ms with.

        Only set *include_value* = True when you need text content.
        """
        info = hit_test_at(screen_x, screen_y, include_value=include_value)
        if info is None:
            return None

        if self._is_own_element(info):
            return None

        return info

    def detect_nearby(
        self,
        screen_x: float,
        screen_y: float,
        radius: float = 50.0,
        *,
        include_value: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Sample a 3×3 grid around *(screen_x, screen_y)* and return
        all unique UI elements found, sorted by distance from the gaze point.

        Coordinates are **top-left screen coordinates**.
        Elements are deduplicated by ``(role, position, size)``.

        Parameters
        ----------
        radius:
            Half-width of the sampling grid in pixels.  The grid spans
            ``gaze ± radius`` with spacing ``radius / 2`` (9 sample points).
        """
        if radius <= 0:
            info = self.detect(screen_x, screen_y)
            return [info] if info else []

        step = radius / 2.0
        offsets = [
            (dx, dy)
            for dx in (-step, 0, step)
            for dy in (-step, 0, step)
        ]

        seen: set[tuple] = set()
        results: list[dict[str, Any]] = []

        for dx, dy in offsets:
            info = self.detect(
                screen_x + dx, screen_y + dy, include_value=include_value
            )
            if info is None:
                continue
            if self._is_own_element(info):
                continue
            key = (
                info.get("role"),
                info.get("position"),
                info.get("size"),
            )
            if key in seen:
                continue
            seen.add(key)
            results.append(info)

        # Sort by Euclidean distance from the gaze point
        def _dist(elem: dict) -> float:
            pos = elem.get("position")
            if pos is None:
                return float("inf")
            return ((pos[0] - screen_x) ** 2 + (pos[1] - screen_y) ** 2) ** 0.5

        results.sort(key=_dist)
        return results

    # ------------------------------------------------------------------
    #  Window enumeration
    # ------------------------------------------------------------------

    def _refresh_window_cache(self) -> None:
        """Re-fetch the list of on-screen windows.  ~35 ms — call sparingly."""
        try:
            raw = Quartz.CGWindowListCopyWindowInfo(
                Quartz.kCGWindowListOptionOnScreenOnly
                | Quartz.kCGWindowListExcludeDesktopElements,
                Quartz.kCGNullWindowID,
            )
        except Exception:
            return

        windows: list[dict[str, Any]] = []
        for w in raw or []:
            bounds = w.get("kCGWindowBounds", {})
            windows.append({
                "name": w.get("kCGWindowName", ""),
                "owner": w.get("kCGWindowOwnerName", ""),
                "layer": int(w.get("kCGWindowLayer", 0)),
                "window_id": int(w.get("kCGWindowNumber", 0)),
                "x": float(bounds.get("X", 0)),
                "y": float(bounds.get("Y", 0)),
                "width": float(bounds.get("Width", 0)),
                "height": float(bounds.get("Height", 0)),
            })

        self._window_cache = windows
        self._window_cache_time = time.monotonic()

    def get_windows(self, force_refresh: bool = False) -> list[dict[str, Any]]:
        """Return the cached window list.  Refreshes automatically every 500 ms."""
        now = time.monotonic()
        if force_refresh or now - self._window_cache_time > 0.5:
            self._refresh_window_cache()
        return self._window_cache

    def window_at(self, screen_x: float, screen_y: float) -> dict[str, Any] | None:
        """
        Return the on-screen window containing *(screen_x, screen_y)*
        in **top-left screen coordinates**, or *None*.

        Uses the cached window list (max 500 ms stale).
        """
        for w in self.get_windows():
            wx, wy, ww, wh = w["x"], w["y"], w["width"], w["height"]
            if wx <= screen_x <= wx + ww and wy <= screen_y <= wy + wh:
                return w
        return None

    def get_active_app_info(self) -> dict[str, str | None] | None:
        """
        Hit-test at screen center to discover the frontmost app/window.

        Returns ``{"app_name": …, "window_title": …}`` or *None*.
        """
        info = hit_test_at(float(self._sw) / 2, float(self._sh) / 2)
        if info is None:
            return None
        return {
            "app_name": info.get("app_name"),
            "window_title": info.get("window_title"),
        }
