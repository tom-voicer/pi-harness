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
python gaze_tracker.py [--recalibrate] [--rows N] [--cols N]
                       [--model NAME] [--no-tune] [--calib-only]
```

| Flag | Default | Description |
|---|---|---|
| `--recalibrate` | – | Force re-calibration even if a saved model exists |
| `--rows N` | `9` | Calibration grid rows |
| `--cols N` | `9` | Calibration grid columns |
| `--model NAME` | `ridge` | Gaze prediction model (see [Models](#models)) |
| `--no-tune` | – | Skip Kalman filter auto-tuning |
| `--calib-only` | – | Only run calibration, don't start tracking |

### Models

| Model | Description |
|---|---|
| `ridge` | Ridge regression — linear, fast, works well in practice **(default)** |
| `elastic_net` | ElasticNet — combines L1/L2 regularization for sparse features |
| `linear_svr` | Linear SVR — support vector regression, robust to outliers |
| `tiny_mlp` | Small neural net (64→32) — captures nonlinear eye→screen mapping at edges |

Examples:

```bash
# Standard 81-point calibration (9×9 grid, ridge model)
python gaze_tracker.py --recalibrate

# Try the neural net model (may help at screen edges)
python gaze_tracker.py --recalibrate --model tiny_mlp

# Fast 25-point calibration
python gaze_tracker.py --recalibrate --rows 5 --cols 5
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
4. A **regression model** (default: Ridge with `StandardScaler`) maps
   the normalized landmark coordinates to screen (x, y) coordinates.
5. A **Kalman filter** smooths the predicted gaze position (auto-tuned
   after calibration to match prediction noise characteristics).
6. A **native macOS overlay** (PyObjC `NSWindow`, borderless +
   transparent) shows a red dot at the smoothed gaze point at ~60 fps.

## Improving Accuracy

- **More calibration points**: `--rows 9 --cols 9` (81 points) is the
  default. Higher grids capture finer spatial coverage at the cost of
  longer calibration (~2 min).
- **Different models**: `--model tiny_mlp` may help if accuracy degrades
  at screen edges during large gaze shifts. The MLP learns nonlinear
  iris→screen mappings.
- **Good lighting**: Face the light source, avoid strong side-lighting
  that creates shadows on one side of the face.
- **Camera position**: Camera at eye level, centered horizontally with
  the screen.
- **Sit still during calibration**: Head movements during calibration
  inject noise. Sit naturally and keep your head stable while looking
  at each dot.

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
- Working webcam (built-in FaceTime camera works)

## Notes

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

### Known Limitations

- Eye tracking is approximate — it estimates where you're looking
  relative to the screen, not absolute coordinates with lab-grade
  precision.
- Large, fast head movements reduce accuracy (the model is trained on
  static head positions at each calibration point).
- Works best at the same distance from the screen as during calibration.
