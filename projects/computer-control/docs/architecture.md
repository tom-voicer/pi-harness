# UI Element Detection — Architecture & Implementation Plan

> **Status**: Research complete. Ready for implementation.
> **Date**: 2026-05-17
> **Context**: This document is the complete specification for `ui_detector.py` — a new module to detect UI elements (buttons, text inputs, windows, menus, etc.) near the gaze point of the existing eye tracker. A fresh agent with no prior context should be able to implement from this document alone.

---

## 1. Project Overview

### 1.1 Current State

`gaze_tracker.py` tracks eye movement via webcam (using EyeTrax + MediaPipe) and displays a **red dot** at the estimated gaze position on screen via a PyObjC `NSWindow` overlay. It runs at ~60 fps.

### 1.2 Goal

Add a new module `ui_detector.py` that, given screen coordinates (the gaze point), identifies what UI element the user is looking at — buttons, text fields, windows, menus, checkboxes, etc. — and returns structured information about it.

The detection should support:
- **Exact hit**: What element is directly under the gaze point?
- **Nearby elements**: What elements are within a small radius of the gaze point?
- **Window context**: What window and application contains the gaze point?

### 1.3 Key Constraint

Must run **fast enough for real-time** alongside the gaze tracker. The gaze loop runs at ~60 fps (16.7ms budget per frame). Detection must not block the loop.

---

## 2. Technology Choice & Rationale

### 2.1 Decision: macOS Accessibility API (AXUIElement)

**Primary API**: `AXUIElementCopyElementAtPosition` from the macOS Accessibility framework (ApplicationServices).

**Why this wins over every alternative**:

| Alternative | Problem |
|---|---|
| ML models (YOLO11n, OmniParser) | Requires GPU, 100–500ms latency, ~1GB+ model downloads, only gives visual boxes without semantic roles |
| Apple Vision OCR | ~386ms even on tiny 300×200 crop, 2000× slower than AX |
| Web scraping / DOM access | Only works for browsers, not native apps |
| Screenshot + template matching | Brittle, slow, no semantic info |

The Accessibility API is the same mechanism that powers VoiceOver and other assistive technologies. It exposes the **full UI element tree** of every application with:
- Semantic roles (`AXButton`, `AXTextField`, `AXWindow`, `AXMenu`, `AXCheckbox`, `AXSlider`, etc.)
- Real screen coordinates (position + size)
- Titles, labels, values, descriptions
- Enabled/focused state
- Parent/child hierarchy

**The core operation (hit-testing) takes ~0.18ms median** — 93× faster than needed for 60fps.

### 2.2 Supporting APIs

| API | Purpose | Frequency |
|---|---|---|
| `AXUIElementCopyElementAtPosition` | Hit-test at exact point | Every frame (~60 fps) |
| `AXUIElementCopyAttributeValue` | Read element properties | Every frame |
| Parent walk (`AXParent`) | Get window/app context | Every frame |
| `CGWindowListCopyWindowInfo` | Enumerate all visible windows | Periodic (~every 500ms) |
| `VNRecognizeTextRequest` (Vision) | OCR fallback for broken AX trees | On-demand only |

### 2.3 What We Do NOT Use (and why)

- **macapptree / py2mac / atomacos**: These are Python wrappers around the same AX APIs. They add heavy dependency chains (pyautogui, pyscreeze, pygetwindow, etc.) and abstract away only 3-4 function calls. We use raw PyObjC directly.
- **OmniParser / YOLO**: Massive overkill. Only useful as cross-platform fallback when Accessibility API is unavailable (i.e., Windows/Linux — but this project is macOS-only).
- **Swift helper process**: Unnecessary. PyObjC gives us direct access to all the same C/ObjC APIs from Python with no performance penalty.

---

## 3. Critical: Coordinate Systems

**This is the #1 gotcha. Get this wrong and nothing will work.**

There are **two coordinate systems** in play:

### 3.1 Cocoa / AppKit Coordinates (used by gaze tracker)

- **Origin**: Bottom-left of main screen
- **Y direction**: Upward (positive Y goes up)
- Used by: `NSScreen.frame()`, `NSWindow.setFrameOrigin_()`, the red dot overlay, and **the gaze coordinates from EyeTrax**

### 3.2 Accessibility / AX Coordinates (used by the AX API)

- **Origin**: Top-left of main screen
- **Y direction**: Downward (positive Y goes down)
- Used by: `AXUIElementCopyElementAtPosition`, `AXPosition` attribute values, `CGWindowListCopyWindowInfo` bounds

### 3.3 Conversion

```python
# Given a Cocoa (bottom-left) Y coordinate:
ax_y = screen_height - cocoa_y

# Given an AX (top-left) Y coordinate:
cocoa_y = screen_height - ax_y
```

The gaze tracker already handles this internally:
- `move_overlay()` flips Y: `y = self._sh - y` (line ~149 of gaze_tracker.py)
- The `latest_gaze` coordinates stored in the tracker are in **Cocoa (bottom-left) coordinates**
- When passing to `AXUIElementCopyElementAtPosition`, you MUST convert Y

### 3.4 AX Attribute Position Values

The `AXPosition` attribute on elements returns coordinates in **AX (top-left) coordinates**, relative to the main screen. So these need to be flipped before comparing with gaze coordinates, or the gaze needs to be flipped before hit-testing.

**Recommendation**: Keep all internal state in Cocoa (bottom-left) coordinates, and convert only at the AX API boundary. This matches what the gaze tracker does.

### 3.5 Multi-Monitor Note

`AXUIElementCopyElementAtPosition` uses the **global coordinate space** where (0,0) is the top-left of the main display. Secondary displays may have negative X or Y. The code should handle this, but for now the project targets single-display MacBooks.

---

## 4. Performance Benchmarks (Measured)

All measurements on macOS 15, Python 3.14, PyObjC 12.1, MacBook Pro.

| Operation | Median | Mean | Max | Notes |
|---|---|---|---|---|
| `AXUIElementCopyElementAtPosition` (raw) | 0.09 ms | 0.32 ms | — | Just the hit-test, no attribute reads |
| `AXUIElementCopyAttributeValue` — string attrs | 0.02 ms | 0.02 ms | — | AXRole, AXTitle, AXEnabled, etc. |
| `AXUIElementCopyAttributeValue` — **AXValue** | **15.2 ms** | 15.9 ms | — | ⚠️ Reading text content is 800× slower! |
| Full `hit_test_at()` (no AXValue) | **0.47 ms** | 0.65 ms | 8 ms | 8 attrs + position/size parse + parent walk |
| Full `hit_test_at()` (with AXValue) | ~17 ms | — | — | Avoid — only request when needed |
| `detect()` (Cocoa coords, no value) | **0.47 ms** | 0.60 ms | — | With coord conversion |
| 9-point `detect_nearby()` (no value) | **4.2 ms** | — | — | Well within 16.7ms frame budget |
| `CGWindowListCopyWindowInfo` | 28 ms | — | — | All on-screen windows. Too slow per frame |
| `VNRecognizeTextRequest` (300×200 crop) | 386 ms | — | — | OCR on small region. Fallback only |

### 🔑 The AXValue Bottleneck

**Reading `AXValue` on a text area is ~800× slower than other attributes.**

On a focused terminal text area, `AXUIElementCopyAttributeValue(elem, "AXValue", None)`
takes ~15 ms because it fetches the **entire text content** from the application.
All other attributes (AXRole, AXTitle, AXPosition, AXSize, AXEnabled, AXFocused)
take ~0.02 ms each.

**The fix**: `hit_test_at()` and `detect()` have an `include_value: bool = False`
parameter.  Only set it to `True` when you actually need text content.

**Conclusion**: Hit-testing (without AXValue) can run every frame at 0.47ms.
Window enumeration should be cached and refreshed periodically (~28ms, every 500ms).
OCR is on-demand only.

---

## 5. Module Design: `ui_detector.py`

### 5.1 File Structure

```
computer-control/
├── gaze_tracker.py          # Existing — modified to import ui_detector
├── ui_detector.py           # NEW — this module
├── requirements.txt          # Updated with new deps
└── docs/
    └── architecture.md       # This document
```

### 5.2 API Surface

`ui_detector.py` should expose:

```python
# Primary class
class UIDetector:
    def __init__(self, screen_width: int, screen_height: int): ...
    def detect(self, cocoa_x: float, cocoa_y: float) -> dict | None: ...
    def detect_nearby(self, cocoa_x: float, cocoa_y: float, radius: float = 50) -> list[dict]: ...
    def get_windows(self) -> list[dict]: ...
    def get_active_app_info(self) -> dict | None: ...

# Convenience function (stateless, no caching)
def hit_test_at(ax_x: float, ax_y: float) -> dict | None: ...
```

### 5.3 Return Dictionary Schema

Every element detection returns a dict with these keys (all optional — only what the AX API provides):

```python
{
    "role": str,              # AXRole — e.g., "AXButton", "AXTextField", "AXWindow"
    "role_description": str,  # AXRoleDescription — e.g., "standard window", "button"
    "title": str | None,      # AXTitle — the label/text of the element
    "description": str | None,# AXDescription — accessibility description
    "value": str | None,      # AXValue — current value (text field content, slider value, etc.)
    "position": (float, float),   # (x, y) in Cocoa coords (bottom-left origin)
    "size": (float, float),       # (width, height)
    "enabled": bool | None,   # AXEnabled
    "focused": bool | None,   # AXFocused
    "window_title": str | None,   # Title of parent AXWindow
    "app_name": str | None,       # Name of parent AXApplication
}
```

For window enumeration (from CGWindowListCopyWindowInfo):

```python
{
    "name": str,              # kCGWindowName
    "owner": str,             # kCGWindowOwnerName
    "layer": int,             # kCGWindowLayer (0 = normal window, higher = overlay)
    "x": float, "y": float,   # Top-left origin (AX coords)
    "width": float, "height": float,  # kCGWindowBounds
    "window_id": int,         # kCGWindowNumber
}
```

### 5.4 UIDetector Class Design

```python
class UIDetector:
    def __init__(self, screen_width, screen_height):
        self._sw = screen_width
        self._sh = screen_height
        self._system_wide = AXUIElementCreateSystemWide()
        self._window_cache = []         # list[dict], from CGWindowListCopyWindowInfo
        self._window_cache_time = 0.0   # monotonic timestamp of last refresh

    # --- Coordinate helpers ---
    def _cocoa_to_ax(self, cocoa_x, cocoa_y):
        """Convert Cocoa (bottom-left) to AX (top-left) coordinates."""
        return (cocoa_x, self._sh - cocoa_y)

    def _ax_to_cocoa(self, ax_x, ax_y):
        """Convert AX (top-left) to Cocoa (bottom-left) coordinates."""
        return (ax_x, self._sh - ax_y)

    # --- Core detection ---
    def detect(self, cocoa_x, cocoa_y) -> dict | None:
        """
        Hit-test at a single gaze point (Cocoa coords).
        Returns element dict or None if nothing found.
        ~1.5ms typical.
        """
        ax_x, ax_y = self._cocoa_to_ax(cocoa_x, cocoa_y)
        return hit_test_at(ax_x, ax_y)

    def detect_nearby(self, cocoa_x, cocoa_y, radius=50) -> list[dict]:
        """
        Sample a grid of points around (x, y) and return all unique elements.
        Grid size: 3x3 (9 points) centered on gaze, spaced by radius/2.
        Deduplicates by (role, position, size) tuple.
        ~3ms typical.
        """

    def _refresh_window_cache(self):
        """Call CGWindowListCopyWindowInfo and update cache. ~35ms."""

    def get_windows(self, force_refresh=False) -> list[dict]:
        """Return cached window list, refreshing if older than 500ms."""
```

### 5.5 Standalone `hit_test_at()` Function

This is the core primitive — a pure function with no state. It should be importable and usable independently:

```python
def hit_test_at(ax_x: float, ax_y: float) -> dict | None:
    """
    Hit-test at AX (top-left origin) coordinates.
    Returns element dict or None.

    Implementation:
    1. AXUIElementCreateSystemWide() → system-wide element
    2. AXUIElementCopyElementAtPosition(system, ax_x, ax_y, None) → element
    3. If error or null, return None
    4. Query attributes: AXRole, AXTitle, AXDescription, AXEnabled, AXFocused
    5. Query AXPosition → parse CGPoint via AXValueGetValue
    6. Query AXSize → parse CGSize via AXValueGetValue
    7. Walk up parents via AXParent to find AXWindow and AXApplication titles
    8. Return dict
    """
```

---

## 6. Exact PyObjC API Usage

### 6.1 Imports

```python
from ApplicationServices import (
    AXUIElementCreateSystemWide,
    AXUIElementCopyElementAtPosition,
    AXUIElementCopyAttributeValue,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)
```

The `ApplicationServices` module comes from `pyobjc-framework-ApplicationServices`.

### 6.2 Function Signatures (PyObjC Bindings)

#### `AXUIElementCopyElementAtPosition`

```python
# C signature:
# AXError AXUIElementCopyElementAtPosition(
#     AXUIElementRef application,   # use system-wide element
#     float          x,             # AX coords (top-left origin)
#     float          y,
#     AXUIElementRef *outElement    # None in Python, returned in tuple
# )

# PyObjC Python signature:
# Returns tuple: (AXError, AXUIElementRef or None)
error, element = AXUIElementCopyElementAtPosition(
    system_wide_element,  # from AXUIElementCreateSystemWide()
    float(x),
    float(y),
    None
)
# error == 0 means success (kAXErrorSuccess)
# error == -25201 means kAXErrorIllegalArgument
# error == -25202 means kAXErrorInvalidUIElement
# element may be None even if error == 0 (no element at that point)
```

#### `AXUIElementCopyAttributeValue`

```python
# Returns tuple: (AXError, value)
error, value = AXUIElementCopyAttributeValue(element, "AXRole", None)
# value could be:
#   - NSString (bridged to Python str) for AXRole, AXTitle, AXDescription
#   - NSNumber (bridged to Python bool) for AXEnabled, AXFocused
#   - AXValueRef for AXPosition, AXSize (needs AXValueGetValue to parse)
#   - NSArray for AXChildren
#   - AXUIElementRef for AXParent, AXWindow
#   - None if attribute doesn't exist
```

#### `AXValueGetValue`

```python
# For CGPoint (AXPosition):
_, cgpoint = AXValueGetValue(axvalue, kAXValueCGPointType, None)
# cgpoint is a CoreFoundation.CGPoint with .x and .y attributes
# Both in AX (top-left) coordinates

# For CGSize (AXSize):
_, cgsize = AXValueGetValue(axvalue, kAXValueCGSizeType, None)
# cgsize is a CoreFoundation.CGSize with .width and .height attributes
```

### 6.3 Attribute Keys

These are the string keys passed to `AXUIElementCopyAttributeValue`:

| Key | Type | Description |
|---|---|---|
| `"AXRole"` | str | `"AXButton"`, `"AXTextField"`, `"AXWindow"`, `"AXMenu"`, `"AXCheckbox"`, `"AXSlider"`, `"AXScrollArea"`, `"AXTextArea"`, `"AXGroup"`, `"AXStaticText"`, `"AXPopUpButton"`, `"AXMenuItem"`, etc. |
| `"AXRoleDescription"` | str | Human-readable: `"button"`, `"standard window"`, `"scroll area"` |
| `"AXTitle"` | str | Label/text of the element |
| `"AXDescription"` | str | Accessibility description |
| `"AXValue"` | varies | Current value (text in field, toggle state, slider value) |
| `"AXPosition"` | AXValue (CGPoint) | Position in AX (top-left) coords |
| `"AXSize"` | AXValue (CGSize) | Size in points |
| `"AXEnabled"` | bool | Whether the element is enabled |
| `"AXFocused"` | bool | Whether the element has keyboard focus |
| `"AXParent"` | AXUIElement | Parent element in hierarchy |
| `"AXChildren"` | list[AXUIElement] | Child elements |
| `"AXWindow"` | AXUIElement | Containing window |
| `"AXTopLevelUIElement"` | AXUIElement | Top-level element (often = window) |

### 6.4 CGWindowListCopyWindowInfo

```python
import Quartz

# Options to use (bitwise OR):
# kCGWindowListOptionOnScreenOnly = 1
# kCGWindowListExcludeDesktopElements = 0x10

window_list = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID,
)
# Returns list of dicts with keys:
#   kCGWindowName           — str, window title
#   kCGWindowOwnerName      — str, app name
#   kCGWindowOwnerPID       — int
#   kCGWindowNumber         — int, window ID
#   kCGWindowLayer          — int, 0 = normal window, 24+ = overlay
#   kCGWindowBounds         — dict with X, Y, Width, Height (AX coords, top-left origin)
#   kCGWindowAlpha          — float, 0.0–1.0
```

### 6.5 Parent Walk

To find the containing window and application from a hit-test result:

```python
def _get_parent_info(element):
    """Walk up the AX tree to find AXWindow and AXApplication."""
    result = {"window_title": None, "app_name": None}
    current = element
    for _ in range(10):  # safety limit
        _, parent = AXUIElementCopyAttributeValue(current, "AXParent", None)
        if not parent or parent == current:
            break
        _, role = AXUIElementCopyAttributeValue(parent, "AXRole", None)
        if role == "AXWindow" and result["window_title"] is None:
            _, result["window_title"] = AXUIElementCopyAttributeValue(parent, "AXTitle", None)
        elif role == "AXApplication" and result["app_name"] is None:
            _, result["app_name"] = AXUIElementCopyAttributeValue(parent, "AXTitle", None)
        if result["window_title"] and result["app_name"]:
            break
        current = parent
    return result
```

---

## 7. Nearby Sampling Strategy

When the gaze is slightly off a small button, the exact hit-test may return the parent container (AXGroup, AXWindow) instead of the button. The nearby sampling solves this:

### 7.1 Algorithm

```
1. Define a sampling grid centered on the gaze point:
   - 3×3 grid (9 points), spacing = radius / 2
   - Plus the center point itself

2. For each sample point:
   a. Convert to AX coordinates
   b. Call AXUIElementCopyElementAtPosition
   c. If found, extract element info

3. Deduplicate: elements with same (role, position, size) are merged

4. Sort by distance from gaze point

5. Filter: return only elements whose bounding box overlaps with the search radius
```

### 7.2 Sampling Grid Pattern

```
    •   •   •
      \ | /
    • — + — •     + = gaze point, • = sample points
      / | \
    •   •   •

   For radius=50px: offsets at (±25, 0), (0, ±25), (±25, ±25)
```

### 7.3 Performance

9 hit-tests × 0.2ms = ~1.8ms, plus attribute queries = ~3ms total. Well within the 16.7ms frame budget.

---

## 8. Integration with gaze_tracker.py

### 8.1 Import and Initialize

Add at module level, near the other imports:

```python
from ui_detector import UIDetector
```

Initialize `UIDetector` in `GazeTracker.__init__()`:

```python
# In GazeTracker.__init__:
self.detector = UIDetector(self._sw, self._sh)
```

### 8.2 Call in Main Loop

In `GazeTracker._update_overlay()`, after getting the gaze coordinates, optionally call the detector:

```python
def _update_overlay(self):
    with self.lock:
        gaze = self.latest_gaze

    if gaze is not None:
        self.move_overlay(*gaze)

        # NEW: Detect UI element at gaze point
        element = self.detector.detect(*gaze)
        if element:
            # For now, just print or store. Later: show in overlay.
            self._latest_element = element
```

### 8.3 Thread Safety

The AX APIs are generally thread-safe but should be called from the main thread when interacting with the Cocoa run loop. Since `_update_overlay()` already runs on the main thread (it's called from the polling loop that pumps `NSRunLoop`), AX calls from there are safe.

The camera thread (`_camera_loop`) should NOT call AX APIs directly — it should only update `self.latest_gaze`.

### 8.4 Optional: Window Cache Refresh

Add a periodic refresh in the main loop:

```python
# In the polling loop (around line ~186 of gaze_tracker.py):
last_window_refresh = 0
while self.running:
    self._update_overlay()
    # Refresh window cache every 500ms
    now = time.monotonic()
    if now - last_window_refresh > 0.5:
        self.detector.get_windows(force_refresh=True)
        last_window_refresh = now
    # Pump event loop
    NSRunLoop.currentRunLoop().runMode_beforeDate_(...)
```

---

## 9. Edge Cases & Gotchas

### 9.1 Accessibility Permission Required

The app must have **Accessibility permission** enabled in System Settings → Privacy & Security → Accessibility. If not granted:
- `AXUIElementCopyElementAtPosition` may return errors or empty results
- `CGWindowListCopyWindowInfo` still works without it (returns window metadata, not elements)

**Detection**: If all hit-tests return error -25201 (`kAXErrorAPIDisabled`), the permission is missing. Log a clear warning.

### 9.2 Broken Accessibility Trees

Some apps (notably: games, WebGL content, custom-drawn UIs, some Electron apps) expose poor or incomplete AX trees. Elements may:
- Return `AXRole = "AXUnknown"` or `"AXGroup"` for everything
- Return null titles/descriptions
- Have position/size = (0, 0, 0, 0)
- Have no parent chain to a window

The code should handle nulls gracefully at every step. Use `if value:` checks after every `AXUIElementCopyAttributeValue` call.

### 9.3 Overlay Window Interference

The red dot overlay window has `setIgnoresMouseEvents_(True)` and is at `NSFloatingWindowLevel`. However, `AXUIElementCopyElementAtPosition` returns **accessibility** elements, not just clickable ones. The overlay might be returned as the hit-test result if it has an accessible representation.

**Mitigation**: After getting the hit-test result, walk up the parent chain. If the top-level application is our own process (Python), skip that result and try a slightly offset position, or simply ignore elements belonging to our own app.

### 9.4 Python Process Self-Detection

When the gaze dot is over its own overlay, the hit-test might return elements from our own Python process. To filter these out:

```python
import os
self._my_pid = os.getpid()

# In parent walk, check if we reach an AXApplication with the same PID
# If so, discard the result
```

### 9.5 Coordinate Conversion Consistency

All AX API calls use top-left origin. All gaze tracker internals use bottom-left. **Always** convert at the boundary:

```
Gaze coords (Cocoa, bottom-left)
    └── ui_detector.detect(cocoa_x, cocoa_y)
            └── _cocoa_to_ax()  →  AX coords (top-left)
                    └── hit_test_at(ax_x, ax_y)
                            └── returns dict with AX coords
            └── _ax_to_cocoa()  →  convert position back
            └── return dict with Cocoa coords
```

The returned element dict should have `position` in **Cocoa** coordinates to match the gaze coordinate system.

### 9.6 Error Constants

Key AX error codes from `<HIServices/AXError.h>`:

| Constant | Value | Meaning |
|---|---|---|
| `kAXErrorSuccess` | 0 | No error |
| `kAXErrorFailure` | -25200 | Generic failure |
| `kAXErrorIllegalArgument` | -25201 | Bad argument |
| `kAXErrorInvalidUIElement` | -25202 | Invalid element ref |
| `kAXErrorAPIDisabled` | -25211 | Accessibility not enabled |

### 9.7 Handling `None` Values from AX

`AXUIElementCopyAttributeValue` returns (error_code, value). The `value` may be `None` for missing attributes, or it may be an `NSNull` bridged object. Check both:

```python
error, value = AXUIElementCopyAttributeValue(elem, attr, None)
if error == 0 and value is not None:
    # use value
```

### 9.8 Main Thread Requirement Caveat

Technically, AX APIs don't strictly require the main thread, but they can cause hangs if called from a background thread while the main thread is in a runloop wait. Since our main loop pumps `NSRunLoop`, calling AX APIs from the camera thread would be unsafe. Always call from `_update_overlay()` or add calls to the main polling loop.

---

## 10. Dependencies

### 10.1 New pip Dependencies

Add to `requirements.txt`:

```
pyobjc-framework-ApplicationServices>=12.1
```

Note: `pyobjc-core`, `pyobjc-framework-Cocoa`, and `pyobjc-framework-Quartz` are already installed (used by the gaze tracker overlay). `ApplicationServices` is the only new one needed.

### 10.2 Optional/Future Dependencies

For OCR fallback (not needed for MVP):

```
pyobjc-framework-Vision>=12.1
```

### 10.3 System Requirements

- macOS (any version ≥ 10.2 for AX API, but ≥ 12.3 if using ScreenCaptureKit later)
- Accessibility permission granted to Terminal (or whichever app runs Python)
- Existing requirements unchanged (Python 3.10+, EyeTrax, etc.)

---

## 11. Testing Plan

### 11.1 Manual Verification Script

Create a small test script that:
1. Takes no arguments
2. Gets screen dimensions
3. Runs hit-test at 5 known screen positions (center, corners, mid-edges)
4. Prints the detected element tree for each
5. Measures and reports timing

### 11.2 Things to Verify Before Integrating

- [ ] Hit-test works without errors on this machine
- [ ] Returns meaningful roles for browser content (AXWebArea, AXTextField, AXButton)
- [ ] Returns meaningful roles for native apps (TextEdit, Finder, System Settings)
- [ ] Parent walk successfully finds window and app names
- [ ] Coordinate conversion correct (verify by moving mouse to a known position and comparing)
- [ ] Performance is consistently sub-millisecond for individual hit-tests
- [ ] Accessibility permission is granted (if not, print clear error)

### 11.3 Known Limitations to Accept

- Some apps have empty/incomplete AX trees (games, custom-rendered content)
- Web content in browsers may expose different attribute names depending on the page's ARIA markup
- The "nearby" sampling may occasionally miss very small elements if the radius is too large and the spacing too coarse
- System UI elements (menu bar, Dock) are sometimes not in the AX tree of any app

---

## 12. Implementation Steps (For Fresh Agent)

1. **Create `ui_detector.py`** with:
   - Imports from `ApplicationServices`
   - `hit_test_at(ax_x, ax_y)` standalone function (core primitive, no state)
   - Coordinate conversion helpers `_cocoa_to_ax()` and `_ax_to_cocoa()`
   - `_get_parent_info(element)` for walking up to window/app
   - AxValue parsing helpers for CGPoint and CGSize
   - `UIDetector` class with `detect()` and `detect_nearby()` methods
   - Window cache methods using `Quartz.CGWindowListCopyWindowInfo`
   - Self-process filtering (avoid detecting own overlay)

2. **Update `requirements.txt`**: Add `pyobjc-framework-ApplicationServices>=12`

3. **Update `gaze_tracker.py`**:
   - Import `UIDetector` at top
   - Initialize `UIDetector` in `GazeTracker.__init__`
   - Call `detect()` in `_update_overlay()`
   - Store/cache elements for display
   - Add periodic window cache refresh

4. **Test manually**:
   - Run `python3 -c "from ui_detector import hit_test_at; ..."` to verify basic hit-testing
   - Run `python gaze_tracker.py` and verify element detection in the output
   - Verify accessibility permission is granted

5. **Polish** (future):
   - Display detected element info alongside/instead of the red dot
   - Add OCR fallback for broken AX trees
   - Add multi-window context awareness

---

## 13. Reference: Full Hit-Test Implementation (Verified Working)

This is the exact Python code that was tested and confirmed working on this machine:

```python
from ApplicationServices import (
    AXUIElementCreateSystemWide,
    AXUIElementCopyElementAtPosition,
    AXUIElementCopyAttributeValue,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)

def hit_test_at(ax_x, ax_y):
    """Hit-test at AX (top-left) coords. Returns dict or None."""
    system = AXUIElementCreateSystemWide()
    error, element = AXUIElementCopyElementAtPosition(
        system, float(ax_x), float(ax_y), None
    )
    if error != 0 or element is None:
        return None

    def get_attr(elem, attr):
        err, val = AXUIElementCopyAttributeValue(elem, attr, None)
        return val if err == 0 else None

    info = {
        "role": get_attr(element, "AXRole"),
        "title": get_attr(element, "AXTitle"),
        "description": get_attr(element, "AXDescription"),
        "role_description": get_attr(element, "AXRoleDescription"),
        "enabled": get_attr(element, "AXEnabled"),
        "focused": get_attr(element, "AXFocused"),
        "value": get_attr(element, "AXValue"),
        "position": None,
        "size": None,
        "window_title": None,
        "app_name": None,
    }

    # Parse position
    pos_v = get_attr(element, "AXPosition")
    if pos_v is not None:
        _, cgpt = AXValueGetValue(pos_v, kAXValueCGPointType, None)
        info["position"] = (cgpt.x, cgpt.y)

    # Parse size
    sz_v = get_attr(element, "AXSize")
    if sz_v is not None:
        _, cgsz = AXValueGetValue(sz_v, kAXValueCGSizeType, None)
        info["size"] = (cgsz.width, cgsz.height)

    # Walk up parents
    current = element
    for _ in range(10):
        parent = get_attr(current, "AXParent")
        if not parent:
            break
        role = get_attr(parent, "AXRole")
        if role == "AXWindow" and info["window_title"] is None:
            info["window_title"] = get_attr(parent, "AXTitle")
        elif role == "AXApplication" and info["app_name"] is None:
            info["app_name"] = get_attr(parent, "AXTitle")
        if info["window_title"] and info["app_name"]:
            break
        current = parent

    return info
```

This function takes AX (top-left) coordinates, returns a fully populated dict, and has zero dependencies beyond PyObjC ApplicationServices. It was tested at 5 different screen positions and correctly identified AXTextArea, AXGroup, AXButton, AXWindow, and AXApplication elements.

---

## 14. Appendix: Why Not Use Library X

| Library | Reason Not Used |
|---|---|
| **macapptree** | Pulls in pyautogui, pyscreeze, pygetwindow, pytest, unidecode. Fails to install on Python 3.14 due to pyobjc-core version conflict. Core functionality is just 3 AX calls we can write directly. |
| **py2mac** | Oriented toward LangChain/LLM agent use. Heavy abstraction. Our use case is a simple element-info dict at a coordinate. |
| **atomacos** | Designed for GUI testing (finding elements by role, clicking them). Heavy class hierarchy. Doesn't provide thin hit-test wrapper. |
| **pyax** | Nice CLI tree inspector, but library API is oriented toward querying by attribute, not hit-testing at coordinates. |
| **OmniParser** | YOLO + Florence-2 models (~1GB). GPU required for reasonable speed. Only gives visual boxes without semantic roles. Cross-platform but macOS already has better native APIs. |
| **YOLO11n CoreML** | Requires training data, model export, ~100ms+ inference. No semantic understanding. Only useful when AX API is completely unavailable. |
