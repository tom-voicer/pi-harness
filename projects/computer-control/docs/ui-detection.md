# UI Detection Module (`ui_detector.py`)

> **For coding agents**: read this before modifying the UI element
> detection logic.  Every function signature, coordinate convention,
> performance characteristic, and edge case is documented.

## Overview

Identifies macOS UI elements (buttons, text fields, windows, menus,
checkboxes, etc.) at or near a screen point using the **macOS
Accessibility API** (`AXUIElement`).  No AI models, no GPU, no
screenshots — pure system API calls with median latency **0.47 ms**
per hit-test.

## Quick Reference

```python
from ui_detector import UIDetector, hit_test_at

# Stateless hit-test (AX / top-left coords)
elem = hit_test_at(screen_x=500, screen_y=300)

# Stateful — nearby sampling + window cache
detector = UIDetector(screen_w=1512, screen_h=982)
elem = detector.detect(screen_x=500, screen_y=300)
nearby = detector.detect_nearby(screen_x=500, screen_y=300, radius=60)
windows = detector.get_windows()
```

## Coordinate System

**All public APIs use top-left screen coordinates** (y=0 at top,
y=screen_h at bottom).  This matches:
- The macOS Accessibility API (`AXUIElementCopyElementAtPosition`)
- EyeTrax gaze output
- `CGWindowListCopyWindowInfo` bounds

The highlighter in `computer_control.py` handles the Y-flip to Cocoa
(bottom-left) coordinates for NSView drawing.  No conversion happens
inside this module.

## Public API

### `hit_test_at(ax_x, ax_y, *, include_value=False) -> dict | None`

Pure function — no state, no caching.  Hit-tests the accessibility tree
at the given top-left screen coordinates.

**Parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `ax_x` | `float` | — | Screen X (left→right) |
| `ax_y` | `float` | — | Screen Y (top→bottom) |
| `include_value` | `bool` | `False` | If `True`, also read `AXValue` (text content, ~16 ms extra) |

**Returns:** `dict` with these keys (all `None` if unavailable):

| Key | Type | Example |
|---|---|---|
| `role` | `str` | `"AXButton"`, `"AXTextField"`, `"AXWindow"` |
| `role_description` | `str` | `"button"`, `"text entry area"` |
| `title` | `str` or `None` | `"OK"`, `"Search"` |
| `description` | `str` or `None` | Accessibility description |
| `value` | varies or `None` | Current text, toggle state, slider value |
| `position` | `(float, float)` | Top-left coordinates of the element |
| `size` | `(float, float)` | `(width, height)` in points |
| `enabled` | `bool` or `None` | Whether the element is enabled |
| `focused` | `bool` or `None` | Whether the element has keyboard focus |
| `window_title` | `str` or `None` | Title of the containing `AXWindow` |
| `app_name` | `str` or `None` | Name of the containing `AXApplication` |

Returns `None` if no element is found or the Accessibility API is
unavailable (permission not granted).

**Performance:** ~0.47 ms median without `include_value`, ~17 ms with.
The `AXValue` attribute is deliberately excluded by default because
reading text content from a large text area costs ~16 ms.

### `UIDetector(screen_width, screen_height)`

Stateful detector with:
- Self-process filtering (ignores elements belonging to the Python process)
- Window cache (periodic `CGWindowListCopyWindowInfo` refresh)
- Nearby element sampling

| Param | Type | Description |
|---|---|---|
| `screen_width` | `int` | Main display width (from `NSScreen.mainScreen()`) |
| `screen_height` | `int` | Main display height |

### `UIDetector.detect(screen_x, screen_y, *, include_value=False) -> dict | None`

Same as `hit_test_at()` but with self-process filtering.  Returns
`None` if the element belongs to the Python process (the overlay).

### `UIDetector.detect_nearby(screen_x, screen_y, radius=50, *, include_value=False) -> list[dict]`

Samples a **3×3 grid** centered on `(screen_x, screen_y)` with spacing
`radius / 2`.  Deduplicates elements by `(role, position, size)` and
sorts by Euclidean distance from the gaze point.

Performance: ~4 ms for 9 sample points (radius=60).

### `UIDetector.get_windows(force_refresh=False) -> list[dict]`

Returns cached list of on-screen windows.  Auto-refreshes every 500 ms.
Each window dict:

```python
{
    "name": str,        # kCGWindowName
    "owner": str,       # kCGWindowOwnerName (app name)
    "layer": int,       # 0 = normal, 24+ = overlay
    "window_id": int,   # kCGWindowNumber
    "x": float, "y": float,  # top-left origin
    "width": float, "height": float,
}
```

Performance: ~28 ms for `force_refresh=True`.

### `UIDetector.window_at(screen_x, screen_y) -> dict | None`

Returns the cached window containing the point.  Uses the window cache
(max 500 ms stale).

### `UIDetector.get_active_app_info() -> dict | None`

Hit-tests at screen center and returns `{"app_name": …, "window_title": …}`.

## Performance Benchmarks

Measured on macOS 15, Python 3.14, PyObjC 12.1, MacBook Pro M2.

| Operation | Median | Notes |
|---|---|---|
| `AXUIElementCopyElementAtPosition` (raw) | 0.09 ms | Single hit-test, no attribute reads |
| `AXUIElementCopyAttributeValue` for string attributes | 0.02 ms | AXRole, AXTitle, AXEnabled, etc. |
| `AXUIElementCopyAttributeValue` for **AXValue** | **15.2 ms** | ⚠️ Text content — 800× slower! |
| `hit_test_at()` without AXValue | **0.47 ms** | 8 attrs + position/size parse + parent walk |
| `hit_test_at()` with AXValue | ~17 ms | Avoid unless you need text |
| `detect()` (Cocoa coords, no value) | **0.47 ms** | With self-filtering |
| `detect_nearby()` radius=60 (9 points) | **4.2 ms** | Deduplicated, sorted |
| `CGWindowListCopyWindowInfo` | 28 ms | All on-screen windows |

## Internal Architecture

### Core API Calls

All calls go through `ApplicationServices` (PyObjC wrapper):

| C Function | PyObjC Call | Purpose |
|---|---|---|
| `AXUIElementCreateSystemWide()` | `AXUIElementCreateSystemWide()` | Root accessibility object |
| `AXUIElementCopyElementAtPosition()` | `AXUIElementCopyElementAtPosition(system, x, y, None)` | Hit-test at point |
| `AXUIElementCopyAttributeValue()` | `AXUIElementCopyAttributeValue(elem, attr, None)` | Read attribute |
| `AXValueGetValue()` | `AXValueGetValue(val, type, None)` | Parse CGPoint/CGSize |

### Attribute Keys Queried

| Key | Return Type | Parsing |
|---|---|---|
| `"AXRole"` | `str` (NSString) | Direct |
| `"AXTitle"` | `str` (NSString) | Direct |
| `"AXDescription"` | `str` (NSString) | Direct |
| `"AXRoleDescription"` | `str` (NSString) | Direct |
| `"AXEnabled"` | `bool` (NSNumber) | Direct |
| `"AXFocused"` | `bool` (NSNumber) | Direct |
| `"AXValue"` | varies | Direct, only when `include_value=True` |
| `"AXPosition"` | `AXValue (CGPoint)` | `AXValueGetValue(…, kAXValueCGPointType, …)` |
| `"AXSize"` | `AXValue (CGSize)` | `AXValueGetValue(…, kAXValueCGSizeType, …)` |
| `"AXParent"` | `AXUIElement` | Used in parent walk only |

### Position Normalisation

Scrolled text areas (e.g., terminal windows) report content-coordinate
positions that can be far off-screen (e.g., `y = -9944`).  When the raw
`AXPosition` Y is outside the `[-2000, 10000]` range, `hit_test_at()`
walks up the parent chain and uses the first ancestor with a reasonable
on-screen position.  If the element's size is >2× the parent's size
(clearly content-sized, not viewport-sized), it clamps the size to the
parent's size.

### Self-Process Filtering

`UIDetector._is_own_element()` checks if the detected element's
`app_name` contains `"python"`.  This prevents the red-dot overlay
window from being detected as a UI element.

## Edge Cases

### Accessibility Permission Not Granted

`AXUIElementCopyElementAtPosition` may return error `-25201`
(`kAXErrorAPIDisabled`).  All functions return `None` gracefully.

### Broken Accessibility Trees

Some apps (games, WebGL, custom-drawn UIs) expose incomplete AX trees.
Elements may have `role = "AXUnknown"`, null titles, or zero-sized
positions.  The code handles `None` at every attribute access.

### AXValue Performance

Reading `AXValue` on a focused terminal text area fetches the **entire
text content** from the application, costing ~16 ms.  This is 800×
slower than all other attributes combined.  Always use
`include_value=False` unless you explicitly need text content.

### Objective-C Class Conflicts

`AXUIElementCreateSystemWide()` is called once per `hit_test_at()`
invocation.  This is fine — it's a lightweight call that returns a
reference to the same system-wide object each time.

## Dependencies

* `pyobjc-framework-ApplicationServices` (AX API)
* `pyobjc-framework-Cocoa` (NSScreen, indirectly)
* `pyobjc-framework-Quartz` (CGWindowListCopyWindowInfo)
* No AI/ML dependencies
* **Does not import `gaze_tracker` or `computer_control`**

## Related Docs

* [Gaze Tracker Module](gaze-tracker.md) — the other core module
* [Architecture Research](architecture.md) — original design decisions, benchmarks, and rejected alternatives
