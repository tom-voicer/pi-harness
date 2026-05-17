# Computer Control — Eye Gaze Tracker

Tracks your eye movement using the laptop's built-in webcam and displays
a **red dot** on screen at the estimated gaze position.

Powered by **[EyeTrax](https://github.com/ck-zhang/EyeTrax)** for
head-pose-invariant gaze estimation (rotation-normalised face landmarks +
Ridge regression) and a native macOS overlay (PyObjC NSWindow) for the
red dot.

## Quick Start

```bash
# 1. Create & activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run (model downloads automatically on first run)
python gaze_tracker.py
```

Press **Ctrl+C** in the terminal to quit.

## CLI Options

```
python gaze_tracker.py [--recalibrate] [--rows N] [--cols N] [--calib-only]
```

| Flag | Description |
|---|---|
| `--recalibrate` | Force re-calibration even if a saved model exists |
| `--rows N` | Calibration grid rows (default 5, more = better accuracy) |
| `--cols N` | Calibration grid columns (default 5) |
| `--calib-only` | Only run calibration, don't start tracking |

Examples:

```bash
# Standard 25-point calibration
python gaze_tracker.py --recalibrate

# High-accuracy 49-point calibration
python gaze_tracker.py --recalibrate --rows 7 --cols 7
```

Calibration is **fully automatic** — look at each pulsing green dot, no
keypresses needed. The trained model is saved to `gaze_model.pkl`.

## How It Works

1. **EyeTrax GazeEstimator** captures webcam frames and runs MediaPipe
   Face Landmarker (478-point face mesh with iris keypoints).
2. Face landmarks are **rotationally normalized** — a 3D rotation matrix
   (built from eye corners + top of head) aligns the face to a canonical
   front-facing pose. This makes eye features **head-pose-invariant**:
   iris positions stay stable regardless of head tilt.
3. Landmarks are scaled to unit inter-eye distance for
   distance-invariance.
4. A **Ridge regression** model (with `StandardScaler`) maps the
   normalized landmark coordinates to screen (x, y) coordinates.
5. A **Kalman filter** smooths the predicted gaze position.
6. A **native macOS overlay** (PyObjC `NSWindow`, borderless +
   transparent) shows a red dot at the smoothed gaze point at ~60 fps.

## Architecture

```
Webcam → EyeTrax (GazeEstimator)
         ├─ extract_features()  → head-pose-invariant landmark vector
         ├─ predict()           → raw (x, y) screen coords
         └─ KalmanSmoother      → smoothed (x, y)
                                      │
                         PyObjC NSWindow overlay ← red dot
```

## Requirements

- Python 3.10+
- macOS (uses native Cocoa overlay; PyObjC required)
- Working webcam

## Notes

- Works best in **good, even lighting** and with the camera roughly at
  eye level.
- Eye tracking is approximate — it estimates where you're looking
  relative to the screen, not absolute screen coordinates with high
  precision.

### macOS Camera Permissions

- On first run, macOS will prompt for camera access — click **Allow**.
- If the dialog doesn't appear, check **System Settings → Privacy &
  Security → Camera** and ensure your terminal app is enabled.
- **Use Terminal.app** (not Warp). Warp's sandboxed process model can
  block the camera permission dialog from reaching Python child
  processes. Built-in Terminal.app works reliably.
- If permission was previously denied, reset with:
  ```bash
  tccutil reset Camera
  ```
  Then re-run — the dialog should appear.
