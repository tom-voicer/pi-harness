# Gaze Tracker Module (`gaze_tracker.py`)

> **For coding agents**: read this to understand the eye-tracking engine
> before modifying it.  Every public method, coordinate convention, and
> thread-safety rule is documented.

## Overview

Pure module — no CLI, no orchestration.  Provides `GazeTracker`, a class
that captures webcam frames, runs EyeTrax gaze estimation, applies Kalman
filtering, and renders a red-dot overlay via a native macOS `NSWindow`.

The caller (typically `computer_control.py`) owns the run loop and calls
`start_camera()` + `update()` each frame.

## Public API

### `GazeTracker(estimator, *, tune=True)`

| Parameter | Type | Description |
|---|---|---|
| `estimator` | `eyetrax.GazeEstimator` | Pre-loaded / pre-calibrated estimator |
| `tune` | `bool` | If `True`, auto-tune the Kalman filter on startup |

Creates the red-dot overlay window and initialises the Kalman smoother.
Does **not** start the camera — call `start_camera()` for that.

### `start_camera()`

Launches a **daemon background thread** that reads webcam frames and
updates `self.latest_gaze`.  Thread-safe: the camera thread writes to
`self.latest_gaze` under a `threading.Lock()`.

### `update() -> tuple[int, int] | None`

**Must be called from the main thread** (the one pumping the Cocoa
run loop).  Reads `self.latest_gaze` under lock, calls `move_overlay()`
to reposition the red dot, and returns the current `(x, y)` gaze point.

Returns `None` if no gaze frame has been captured yet.

### `stop()`

Signals the camera thread to exit, joins it (timeout 1s), and releases
the camera.

### `screen_size -> tuple[int, int]`

Property returning the main display `(width, height)` in pixels.

### `latest_gaze -> tuple[int, int] | None`

Public attribute.  The most recent smoothed gaze point.  **Read under
`self._lock`** if accessing from a thread other than the one calling
`update()`.

## Coordinate System

| Component | Coordinates |
|---|---|
| EyeTrax output (`self.latest_gaze`) | **Top-left screen** (y=0 at top, y=screen_h at bottom) |
| `move_overlay(x, y)` input | Same — top-left screen |
| `update()` return value | Same — top-left screen |
| NSWindow overlay position (`setFrameOrigin_`) | **Cocoa bottom-left** (y=0 at bottom) |

`move_overlay()` internally converts top-left → Cocoa with
`y_flipped = screen_h - y`.

**Important**: the caller (`computer_control.py`) receives top-left
coordinates from `update()` and passes them directly to
`UIDetector.detect()`, which also expects top-left coordinates.

## Internal Architecture

```
_camera_loop() [background thread]
  │
  ├── cv2.VideoCapture(0)  →  frame
  ├── estimator.extract_features(frame)  →  478-point face mesh
  ├── estimator.predict(features)       →  raw (x, y)
  ├── KalmanSmoother.step(x_raw, y_raw) →  smoothed (x, y)
  └── self.latest_gaze = (x, y)  [under lock]

update() [main thread]
  │
  ├── read self.latest_gaze  [under lock]
  ├── move_overlay(x, y)     → NSWindow.setFrameOrigin_()
  └── return (x, y)
```

## Thread Safety

* **Camera thread** — writes `self.latest_gaze` under `self._lock`
* **Main thread** (`update()`) — reads `self.latest_gaze` under `self._lock`
* **Main thread** (`move_overlay()`) — calls `NSWindow.setFrameOrigin_()` (must be main thread for Cocoa)
* **Main thread** (`stop()`) — sets `self._running = False`, joins camera thread

Never call `move_overlay()` or any Cocoa API from the camera thread.

## Overlay Window Details

* Created by `_create_overlay()` called once in `GazeTracker.__init__`
* `_DotView` (NSView subclass) defined at module level to avoid ObjC class re-registration errors
* Window style: `NSBorderlessWindowMask` (borderless, transparent)
* Level: `NSFloatingWindowLevel` (always on top)
* Collection behavior: can join all Spaces, stationary, fullscreen auxiliary
* Ignores mouse events (`setIgnoresMouseEvents_(True)`)
* Dot size: 28×28 px, red fill (#FF2020) with darker outline

## macOS 15 Compatibility Note

`NSNonactivatingPanelMask` (0x80) is deprecated on macOS 15.  The overlay
uses `NSBorderlessWindowMask` alone — the collection behavior flags
handle floating + all-spaces behaviour.

## Key Implementation Details

### Why `_DotView` is at module level

Defining `class DotView(NSView)` inside `_create_overlay()` causes
`"DotView is overriding existing Objective-C class"` on the second
`GazeTracker` instantiation.  Module-level definition registers the
class once with the ObjC runtime.

### Why `move_overlay` flips Y

`NSWindow.setFrameOrigin_()` uses Cocoa (bottom-left) coordinates.
EyeTrax outputs top-left coordinates.  The flip is:
```python
cocoa_y = screen_h - top_left_y
```

### Kalman filter auto-tuning

`self.smoother.tune(estimator, camera_index=0)` captures a few seconds
of raw gaze predictions with the user looking at the screen center,
then fits the Kalman process/measurement noise parameters.  Skipped if
`tune=False`.

## Dependencies

* `eyetrax` (GazeEstimator, KalmanSmoother)
* `opencv-python` (webcam capture)
* `numpy`
* `pyobjc-framework-Cocoa` (NSWindow overlay)
* `mediapipe` (via EyeTrax)

**Does not import `ui_detector` or `computer_control`** — this module is
fully isolated from the rest of the project.

## Related Docs

* [UI Detection Module](ui-detection.md) — the other core module
* [Architecture Research](architecture.md) — original design decisions and benchmarks
