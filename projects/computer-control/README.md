# Computer Control — Eye Gaze Tracker

Tracks your eye movement using the laptop's built-in webcam and displays
a **red dot** on screen at the estimated gaze position.

Uses [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
(478-point face mesh with iris keypoints) and lightweight gaze estimation.

## Quick Start

```bash
# 1. Create & activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Download the MediaPipe model
curl -L -o face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

# 4. Run
python gaze_tracker.py
```

Press **Ctrl+C** in the terminal to quit.

## How It Works

1. The webcam captures frames, which are mirrored for a natural view.
2. MediaPipe's Face Landmarker detects 478 face landmarks, including
   iris positions (landmarks 468–477).
3. For each eye the iris offset from the eye centre is computed and
   normalised by the eye width / height.
4. The two eyes are averaged, the result is mapped to screen
   coordinates, and a small transparent window showing a red dot is
   moved to that screen position.
5. The dot is smoothed over a few frames to reduce jitter.

## Notes

- Works best in **good, even lighting** and with the camera roughly at
  eye level.
- Eye tracking is approximate — it estimates where you're looking
  relative to the screen, not absolute screen coordinates with high
  precision.
- macOS: grant camera permission when prompted (System Settings →
  Privacy & Security → Camera).
