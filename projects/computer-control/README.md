# Computer Control — Gaze-Driven UI Interaction

Tracks eye movement via webcam and displays a **red dot** at the gaze
position, while **detecting and highlighting the UI element**
(button, text field, window, menu, etc.) the user is looking at.

## Quick Start

```bash
# 1. Create & activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run
python computer_control.py
```

Press **Ctrl+C** to quit.

> **Two permissions required** on first run:
>
> * **Camera** — System Settings → Privacy & Security → Camera
> * **Accessibility** — System Settings → Privacy & Security → Accessibility
>
> Add your terminal app to both. **Use Terminal.app** (not Warp) — Warp's
> sandbox blocks the permission dialogs from reaching Python.

## CLI Options

```
python computer_control.py [--recalibrate] [--rows N] [--cols N]
                           [--model NAME] [--no-tune] [--calib-only]
                           [--no-ui-detection]
```

| Flag | Default | Description |
|---|---|---|
| `--recalibrate` | — | Force re-calibration even if a saved model exists |
| `--rows N` | `9` | Calibration grid rows |
| `--cols N` | `9` | Calibration grid columns |
| `--model NAME` | `ridge` | Gaze prediction model (`ridge`, `elastic_net`, `linear_svr`, `tiny_mlp`) |
| `--no-tune` | — | Skip Kalman filter auto-tuning |
| `--calib-only` | — | Only run calibration, don't start tracking |
| `--no-ui-detection` | — | Disable UI element detection (red dot only, faster) |

### Models

| Model | Description |
|---|---|
| `ridge` | Ridge regression — linear, fast, works well **(default)** |
| `elastic_net` | ElasticNet — L1/L2 regularisation for sparse features |
| `linear_svr` | Linear SVR — robust to outliers |
| `tiny_mlp` | Small neural net (64→32) — captures nonlinear eye→screen mapping |

### Examples

```bash
# Standard 81-point calibration
python computer_control.py --recalibrate

# Neural net model (may help at screen edges)
python computer_control.py --recalibrate --model tiny_mlp

# Fast 25-point calibration
python computer_control.py --recalibrate --rows 5 --cols 5

# Red dot only (no UI detection overhead)
python computer_control.py --no-ui-detection
```

Calibration is **fully automatic** — look at each pulsing green dot; no
keypresses needed. The model is saved to `gaze_model.pkl`.

## What You See

* **Red dot** — follows your eye gaze in real time
* **Cyan border + label** — the UI element directly under your gaze (e.g. "TextArea", "Button — OK")
* **Dim grey borders** — nearby UI elements within ~60px radius

When `--no-ui-detection` is used, only the red dot is shown (same as the original gaze tracker).

## Architecture

```
computer_control.py   ← entry point / orchestrator
├── gaze_tracker.py    ← eye tracking engine (webcam → EyeTrax → Kalman → overlay)
└── ui_detector.py     ← UI element detection (AX hit-test + window cache)
```

| Module | Responsibility | Docs |
|---|---|---|
| `computer_control.py` | CLI, calibration, main loop, wires modules, draws highlight boxes | (this file) |
| `gaze_tracker.py` | Webcam capture, EyeTrax inference, Kalman smoothing, red-dot overlay | [docs/gaze-tracker.md](docs/gaze-tracker.md) |
| `ui_detector.py` | AX hit-testing, element properties, nearby sampling, window enumeration | [docs/ui-detection.md](docs/ui-detection.md) |

### Data Flow

```
Webcam
  │
  ▼
EyeTrax GazeEstimator
  ├─ extract_features()   → head-pose-invariant 478-point face mesh
  ├─ predict()            → raw (x, y) screen coordinates
  └─ KalmanSmoother       → smoothed gaze (x, y) @ ~60 fps
        │
        ├──▶ NSWindow red-dot overlay
        │
        └──▶ AXUIElementCopyElementAtPosition(x, y)  →  detected UI element
                    │
                    ▼
              NSWindow highlight overlay  (cyan border + label)
```

### Coordinate Conventions

| System | Origin | Y direction | Used by |
|---|---|---|---|
| **Top-left screen** | Top-left corner | ↓ down | EyeTrax gaze output, `ui_detector.py` I/O, AX API |
| **Cocoa / NSView** | Bottom-left corner | ↑ up | `gaze_tracker.py` red-dot overlay, `_HighlightView` drawing |

The Y-flip between systems (`cocoa_y = screen_h - top_left_y`) is handled
internally by `gaze_tracker.move_overlay()` and `_HighlightView._draw_box()`.
No other code needs to worry about it.

## Requirements

* Python 3.10+
* macOS (uses native Cocoa overlay; PyObjC required)
* Working webcam (built-in FaceTime camera works)
* macOS **Accessibility** permission (System Settings → Privacy & Security → Accessibility)
* macOS **Camera** permission (System Settings → Privacy & Security → Camera)

## Improving Accuracy

* **More calibration points** — `--rows 9 --cols 9` (81 points) is default; higher grids improve spatial coverage at the cost of longer calibration (~2 min)
* **Different models** — `--model tiny_mlp` may help at screen edges during large gaze shifts
* **Good lighting** — face the light source, avoid strong side-lighting
* **Camera position** — camera at eye level, centered horizontally with the screen
* **Sit still during calibration** — head movements during calibration inject noise

## Known Limitations

* Eye tracking is approximate — lab-grade precision is not expected
* Large, fast head movements reduce accuracy (model is trained on static head positions)
* Works best at the same distance from the screen as during calibration
* Some apps expose incomplete accessibility trees (games, WebGL, custom-drawn UIs); in these cases the highlight box may be missing or inaccurate
* The AXValue attribute (text content) is expensive to read (~16 ms) and is skipped by default; request it explicitly with `include_value=True` only when needed
