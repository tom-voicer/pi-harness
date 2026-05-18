# Deep Research: Multi-Screen Gaze Tracking for Computer Control

> **Status**: Research exploration — no implementation decisions made.  Integrated from two independent deep-research reports.
> **Date**: 2026-05-18
> **Depth**: Level 3 — Expert Deep Research (architecture/strategy analysis)
> **Context**: The single-screen gaze tracker works well. This report explores the full technical landscape for extending to multiple displays: coordinate system architecture, calibration strategies, overlay design, mathematical foundations, commercial & open-source ecosystem, validation methodology, and the gaps between what the current stack provides and what multi-screen requires.
>
> **Cross-platform scope**: While this project is macOS-only, we include Windows, Linux, and Wayland API references and learn from cross-platform open-source systems (Pupil Labs, WebGazer, OpenFace) because the architectural patterns transfer.

---

## Executive Summary

The core architectural insight for multi-screen gaze tracking is a **two-stage decomposition**: first estimate either a display identity or a 3D gaze ray, then map that estimate into **per-display local coordinates** before converting to OS cursor positions. Extending a single global `(x, y)` regressor over the whole virtual desktop is the most common source of multi-screen bugs — it breaks under DPI changes, monitor rearrangement, bezel gaps, and angled screens. This lesson is corroborated by GazeProjector (the seminal multi-display academic system), Pupil Labs' real-time screen-mapping architecture, and commercial multi-screen systems such as Smart Eye Pro.

On **macOS specifically**, the central challenge is reconciling at least three incompatible coordinate systems (Quartz top-left, Cocoa bottom-left, and the regression model's calibrated space), plus the window server's "Displays have separate Spaces" constraint that prevents a single overlay window from spanning monitors. The recommended architecture is: **one NSWindow overlay per display**, a **per-display calibration** strategy (either unified global or piecewise local), **separate display-selection hysteresis from within-screen smoothing**, and a **DisplayPlane abstraction** that carries both physical geometry and OS logical rectangles.

The three hardest problems are: (1) **calibration across screens** — the current EyeTrax regression model implicitly encodes a fixed camera-to-screen geometric relationship tied to the primary display only; (2) **accuracy degradation at larger physical spans** — appearance-based gaze estimation error grows with head rotation (30–60° yaw is common for dual-monitor); (3) **the 3D geometry of non-coplanar displays** — angled, stacked, or portrait-oriented screens break the assumption that one affine transform can cover the whole workspace.

For the near term, the fastest path is: (a) introduce a monitor-geometry abstraction layer, (b) add per-display local calibration and piecewise mapping, (c) separate display selection hysteresis from coordinate smoothing. In the longer term, add head pose, 3D monitor planes, and online offset correction from user interactions. The academic frontier provides clear direction: models such as L2CS-Net (3.92° on MPIIGaze) and 3DGazeNet improve unconstrained gaze-direction estimation, while GazeProjector (2.47° across multiple displays) and adaptive homography methods solve the display-geometry half of the problem. The missing piece is **systems integration** — the theory, calibration strategies, OS APIs, and validation methods are all mature enough to support a strong implementation.

---

## 1. What It Is

Multi-screen gaze tracking means extending the current system — which maps webcam-captured facial features to pixel coordinates on a single primary display — to support an arbitrary arrangement of macOS displays. The user should be able to look at any pixel on any connected screen and have the red dot follow there, with UI element detection (AX hit-testing) and highlight overlays working across all displays.

This is not simply "make the coordinate range larger." It requires:

- Discovering and modeling the physical display topology
- Extending the gaze regression model to cover the full desktop coordinate space
- Rendering overlays on all screens simultaneously
- Handling the coordinate-system mismatch between Cocoa, Quartz, and the Accessibility API across display boundaries
- Coping with inherently degraded accuracy over larger physical angles

---

## 2. Why It Exists (Motivation & Use Cases)

The current system is constrained to a single display. Many real-world setups involve multiple monitors — a laptop with an external display, dual-monitor desks, ultrawide + secondary, or even three-screen arrangements. The user's gaze naturally traverses these displays, and the tool should follow.

Specific use cases enabled by multi-screen support:

- **Developer workflow**: code editor on one screen, documentation/browser on another — gaze-aware context switching
- **Design/creative work**: canvas on primary, tool palettes on secondary — eye-driven palette focus
- **Accessibility**: users who rely on gaze as an input modality across their full desktop
- **Analytics/research**: studying attention distribution across multiple information sources
- **General HCI**: the tool should work wherever the user looks, not just on one screen

---

## 3. How It Works — Current Architecture Deep Dive

To understand what must change, we must first understand exactly what the current system does at each layer.

### 3.1 EyeTrax Feature Extraction

```
Webcam frame (BGR)
  → cv2.cvtColor → RGB
  → MediaPipe Face Landmarker → 478 × (x, y, z) 3D landmarks
  → Head-pose-invariant normalization:
      1. Anchor: midpoint of left/right eye outer corners (landmarks 33, 263)
      2. Shift origin to anchor
      3. Build rotation matrix R from:
         - x-axis: right_corner − left_corner (inter-eye line)
         - y-axis: top_of_head (landmark 10) − anchor, orthogonalized to x
         - z-axis: x × y
      4. Rotate all points: Rᵀ · (point − anchor)
      5. Scale by 1/inter_eye_distance
  → Subset: eye region landmarks (LEFT_EYE_INDICES + RIGHT_EYE_INDICES + MUTUAL_INDICES)
  → Append head pose: [yaw, pitch, roll] from R
  → Output: feature vector ~300–400 floats
```

**Key property**: The features are head-pose-invariant — the rotation step cancels out head orientation, leaving only relative eye-landmark positions. This means the feature vector for looking at the same screen position should be similar regardless of modest head rotation. However, this invariance is imperfect, especially at extreme angles.

### 3.2 Regression Model

```
Features (float vector) → StandardScaler → Regression model → (x, y) screen coordinates
```

Supported models: Ridge regression (linear), ElasticNet, Linear SVR, TinyMLP (64→32 neurons).

The model is trained during calibration where:
- Targets: pixel positions on the **primary display** (e.g., `(100, 200)`)
- Features: extracted from webcam frames while user looks at each calibration dot
- The calibration window is a fullscreen OpenCV window on `NSScreen.mainScreen()`

**Critical implication**: The model learns a mapping from facial features → pixel coordinates **within the primary screen's coordinate range**. It has never seen coordinates outside this range and has no concept of a global desktop space.

### 3.3 The Calibration Pipeline

```
run_dense_grid_calibration(estimator, rows, cols, camera_index=0)
  → get_screen_size() → NSScreen.mainScreen().frame().size → (sw, sh)
  → compute_grid_points_from_shape(rows, cols, sw, sh, margin=0.10)
     → Points: [(mx + c*step_x, my + r*step_y) for r in rows, c in cols]
  → Fullscreen OpenCV window on main screen
  → For each grid point: pulse green dot, capture features + target position
  → estimator.train(features_array, targets_array)
  → Save model to disk
```

The calibration points are generated entirely within `[margin, sw-margin] × [margin, sh-margin]` of the primary display. There is **no awareness of other displays** anywhere in this pipeline.

### 3.4 The Current Overlay Architecture

**Red dot overlay** (gaze_tracker.py):
- One `NSWindow`, borderless, `NSFloatingWindowLevel`
- Size: 28×28 px
- Position updated each frame via `setFrameOrigin_()`
- Implements `NSWindowCollectionBehaviorCanJoinAllSpaces | Stationary | FullScreenAuxiliary`
- Created using `NSScreen.mainScreen().frame()` for coordinate bounds

**Highlight overlay** (computer_control.py):
- One `NSWindow` per `_HighlightView` instance, borderless
- Level: `NSFloatingWindowLevel + 1` (above red dot)
- Same collection behavior flags
- Draws colored borders + labels for detected UI elements

**The single-window assumption**: Both overlays are created from `NSScreen.mainScreen().frame()` and positioned within those bounds. A secondary display at a different position is invisible to this code.

---

## 4. macOS Multi-Display Coordinate Architecture

This is the #1 prerequisite to understand. macOS has **three distinct coordinate systems** in play, and they disagree on Y-axis direction and origin placement.

### 4.1 Quartz / CoreGraphics Global Coordinate Space

| Property | Value |
|---|---|
| Origin | Top-left of the **primary display** (the one with the menu bar) |
| Y direction | ↓ downward (positive Y goes down) |
| X direction | → rightward |
| Primary display origin | `(0, 0)` |
| Secondary display (left of primary) | X is negative |
| Secondary display (above primary) | Y is negative |
| Units | Points (logical pixels, not physical) |

Used by:
- `CGDisplayBounds(displayID)` — returns `CGRect` in this space
- `CGGetActiveDisplayList()` — enumerates all active displays
- `AXUIElementCopyElementAtPosition(x, y)` — hit-tests in this space
- `AXPosition` attribute values — returned in this space
- `CGWindowListCopyWindowInfo` — window bounds in this space
- `CGEvent` posting (mouse clicks, etc.)

**Example layout** (laptop + external monitor to the right):

```
Quartz global coordinates:
  Primary (laptop):    (0,     0,    1512, 982)
  Secondary (right):   (1512,  0,    2560, 1440)
  Desktop bounds:      (0,     0,    4072, 1440)
```

**Example layout** (external above laptop):

```
Quartz global coordinates:
  Secondary (above):   (0,    -1440, 2560, 1440)   ← Y is negative!
  Primary (laptop):    (0,     0,    1512, 982)
  Desktop bounds:      (0,    -1440, 4072, 1440)    ← minY is negative!
```

### 4.2 Cocoa / AppKit Screen Coordinate Space

| Property | Value |
|---|---|
| Origin | Bottom-left of the **primary display** |
| Y direction | ↑ upward (positive Y goes up) |
| X direction | → rightward |
| Primary display origin | `(0, 0)` |
| Secondary display (above primary) | Y is **positive** (opposite of Quartz!) |

Used by:
- `NSScreen.frame` — returns `NSRect` in this space
- `NSWindow.setFrameOrigin_()` — positions windows in this space
- `NSView.bounds` / `NSView.frame` — view coordinates

**The critical Y-flip**: Quartz and Cocoa disagree on Y direction. A display above the primary has *negative* Y in Quartz but *positive* Y in Cocoa. This is the root cause of the coordinate confusion documented across multiple macOS projects (Swindler #62, axterminator #21).

**Conversion formula**:

```python
# Convert Quartz Y to Cocoa Y (or vice versa — the formula is symmetric)
cocoa_y = CGDisplayBounds(CGMainDisplayID()).height - quartz_y
quartz_y = CGDisplayBounds(CGMainDisplayID()).height - cocoa_y
```

The formula is the same in both directions because flipping twice returns to the original.

### 4.3 The "Displays have Separate Spaces" Constraint

Since macOS 10.9 Mavericks, the default setting is that each display has its own set of Spaces (virtual desktops). When enabled:

- A single `NSWindow` **cannot span multiple displays** — it is clipped to whichever display contains the majority of its geometry
- `NSScreen.mainScreen` returns the **active** screen (the one with the key window), not the primary
- Fullscreen apps occupy only one display, leaving others unchanged
- `NSScreen.screensHaveSeparateSpaces` (class method, 10.9+) can query this setting

When disabled (System Preferences → Mission Control → uncheck "Displays have separate Spaces"):
- A single window can span multiple displays
- The menu bar appears only on one display
- Requires logout/login to take effect

**Implication for overlays**: We cannot rely on a single spanning window. The solution must work regardless of this setting, which means **one overlay window per display**.

### 4.4 Detecting Display Topology

The display layout can be queried via two APIs:

**Via NSScreen** (Cocoa coordinates, Y-up):

```python
from AppKit import NSScreen

for screen in NSScreen.screens():
    frame = screen.frame()
    # frame.origin.x, frame.origin.y — Cocoa coords (bottom-left origin)
    # frame.size.width, frame.size.height
    # Index 0 is always the primary display (origin at 0,0)
```

**Via CoreGraphics** (Quartz coordinates, Y-down):

```python
import Quartz

# Returns list of CGDirectDisplayID
(err, display_ids, count) = Quartz.CGGetActiveDisplayList(10, None, None)

for did in display_ids:
    bounds = Quartz.CGDisplayBounds(did)
    # bounds.origin.x, bounds.origin.y — Quartz coords (top-left origin)
    # bounds.size.width, bounds.size.height
```

**Recommendation**: Use `NSScreen.screens` for overlay window placement (NSWindow uses Cocoa coords) and `CGDisplayBounds` for AX hit-testing and gaze coordinate mapping (AX uses Quartz coords). Cache the display topology and subscribe to `NSApplication.didChangeScreenParametersNotification` for changes.

### 4.5 Display Change Notifications

```python
from Foundation import NSNotificationCenter

NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
    self, 'onDisplayChanged:', 
    'NSApplicationDidChangeScreenParametersNotification', 
    None
)
```

This fires when displays are connected, disconnected, or rearranged. Critical for dynamic multi-screen support.

---

## 5. EyeTrax Gaze Estimation Internals & Multi-Screen Implications

### 5.1 What the Model Actually Learns

The regression model maps:

```
facial_feature_vector → (x_pixel, y_pixel)
```

where the target coordinates are constrained to the primary display during calibration. The features are normalized to be head-pose-invariant, but:

1. **Camera-to-screen geometry is implicitly encoded**: The model learns a specific mapping that assumes the camera is at a fixed position relative to the screen. When the user turns their head to look at a secondary display, the camera (mounted on the primary screen / laptop lid) moves relative to the eyes in a way the model hasn't seen.

2. **Head pose features are included but auxiliary**: The yaw/pitch/roll values are appended to the feature vector. While the model may learn to use head pose as a coarse indicator of where the user is looking (e.g., large yaw → looking at right monitor), this relationship was only trained within the primary screen's angular range.

3. **No physical understanding**: The model has no concept of 3D space, screen planes, or camera position. It's a pure statistical mapping.

### 5.2 Why Multi-Screen Breaks the Current Model

Consider a setup with a laptop (1512×982) and an external monitor (2560×1440) to the right, arranged side-by-side:

1. **Coordinate range mismatch**: The model was trained to output x ∈ [~150, ~1360] and y ∈ [~100, ~880] (the calibration grid within margin). Points on the external monitor at x = 2000 and y = 500 are far outside this training distribution.

2. **Feature distribution shift**: Looking at the right edge of the external monitor involves a head rotation (yaw) that was never seen during calibration. Even though features are normalized to be head-pose-invariant, the normalization is imperfect — extreme angles produce feature vectors the model can't accurately map.

3. **Inter-eye distance scaling fails at angles**: The normalization divides by `inter_eye_distance`, but at large yaw angles, the apparent inter-eye distance shrinks (foreshortening), and the eye landmarks themselves change shape (one eye becomes partially occluded by the nose bridge).

### 5.3 The Head-Pose-Invariance Tradeoff

EyeTrax's normalization strategy is clever: it rotates the face landmarks into a canonical head-pose frame, making gaze features theoretically independent of head orientation. In practice:

- **Small angles (<15° yaw)**: Good invariance. The model can accurately map features to screen positions.
- **Medium angles (15°–30° yaw)**: Acceptable. Some accuracy loss but usable.
- **Large angles (>30° yaw)**: Significant degradation. The normalization breaks down because:
  - MediaPipe landmark accuracy decreases at profile views
  - Eye landmarks become distorted or occluded
  - The orthogonalization step (y_approx − proj(y_approx, x_axis)) introduces error

For a dual-monitor setup at typical viewing distance (60–70 cm), looking from the center of the left screen to the center of the right screen can involve **40–60° of yaw rotation** — well into the degraded regime.

### 5.4 What MediaPipe Can Handle

MediaPipe Face Landmarker tracks faces with the following characteristics:
- Detection range: approximately ±60° yaw, ±45° pitch, ±45° roll
- 478 landmarks with iris tracking
- Designed for front-facing camera scenarios
- Accuracy degrades at profile angles (eye landmarks become less reliable)

For multi-screen: if the webcam is mounted on the primary display (typical laptop), looking at a secondary display to the side means the face is turned away from the camera. MediaPipe can still detect the face within ~60°, but the eye-specific landmarks become less reliable.

---

## 6. Calibration Strategies for Multi-Screen

### 6.1 Approach A: Per-Screen Independent Calibration

Calibrate separately on each screen, producing one model per screen. At runtime, detect which screen the user is looking at and switch models.

**How it works**:
1. For each display: fullscreen calibration window on that display, run standard dense grid
2. Save per-screen models: `gaze_model_display_0.pkl`, `gaze_model_display_1.pkl`, etc.
3. At runtime: use head pose (yaw) to determine active screen, select model, apply coordinate offset

**Screen detection via head pose**:

```python
def active_screen_from_head_pose(yaw, displays):
    # Map yaw angle to horizontal screen position
    # This requires knowing the physical arrangement (not just pixel positions)
    # The relationship depends on user distance from screen
    for display in displays:
        screen_center_x = display.x + display.width / 2
        # Estimate expected yaw for this screen center
        # Requires camera-to-screen distance (from calibration)
        expected_yaw = compute_yaw_for_point(screen_center_x, distance)
        if abs(yaw - expected_yaw) < threshold:
            return display
```

**Pros**:
- Each screen gets its own well-calibrated model
- Calibration procedure is familiar (just repeated per screen)
- Leverages existing single-screen calibration code

**Cons**:
- Head pose → screen mapping is imprecise (depends on seating position, distance)
- Model switching creates discontinuities at screen boundaries
- Gaze transitions between screens are handled poorly
- More calibration time (N × 1–2 minutes for N screens)
- No unified model for intermediate positions

### 6.2 Approach B: Unified Global Calibration

Discover the full desktop layout and generate calibration points that span all screens. Train a single model that outputs global desktop coordinates.

**How it works**:
1. Query all display bounds via `CGDisplayBounds` or `NSScreen.screens`
2. Compute the full desktop bounding box
3. Generate calibration grid points spread across all displays (with possibility of excluding bezel gaps)
4. Show calibration points sequentially on each display (fullscreen calibration window per display, or a single large window if spanning is possible)
5. Train one model: features → global (quartz) coordinates
6. At runtime: model outputs coordinates in global space directly

**Calibration point generation**:

```python
def generate_multi_screen_calibration_points(displays, rows_per_screen, cols_per_screen):
    points = []
    for display in displays:
        margin_x = display.width * 0.10
        margin_y = display.height * 0.10
        step_x = (display.width - 2 * margin_x) / (cols_per_screen - 1) if cols_per_screen > 1 else 0
        step_y = (display.height - 2 * margin_y) / (rows_per_screen - 1) if rows_per_screen > 1 else 0
        
        for r in range(rows_per_screen):
            for c in range(cols_per_screen):
                x = display.x + margin_x + c * step_x
                y = display.y + margin_y + r * step_y
                points.append((x, y, display))  # display needed for rendering
    
    return points
```

**Pros**:
- Single model, unified coordinate space
- Handles cross-screen gaze naturally
- Model can learn the relationship between head pose and screen position
- No switching artifacts

**Cons**:
- Calibration is complex: must render points on different screens
- Larger coordinate range + larger physical angular range → inherently lower accuracy
- Bezel gaps between screens have no calibration data → interpolation may be poor
- User must physically turn head between calibration points → more movement, more noise
- Harder to implement (need multi-display calibration UI)

### 6.3 Approach C: Per-Display Homography Mapping

A homography-based alternative to regression: map eye/face feature positions in the camera image directly to display coordinates via a projective transformation. This is fast, low-latency, and easy to calibrate, making it a strong choice for flat coplanar desk setups.

**How it works**:
1. Extract a selected 2D eye/face feature point `(f_x, f_y)` in the camera image (e.g., pupil center, eye corner midpoint)
2. For each display `i`, calibrate a per-display homography matrix `H_i`
3. At runtime: classify which display the user faces (via head pose or feature position), then apply `H_i`

**Mathematical form**:
```
λ·[u, v, 1]ᵀ = H_i · [f_x, f_y, 1]ᵀ
```
where `(u, v)` are display-local normalized or pixel coordinates.

**Adaptive homography** extends this by conditioning the mapping on head-pose variables, effectively using `H_i(h)` rather than a fixed `H_i`. This provides better robustness under head movement without requiring a full 3D eye model.

**Pros**:
- Very fast per-frame (matrix multiply)
- Easy to calibrate (4+ point correspondences per display)
- Works well for flat coplanar desks
- Adaptive variant handles moderate head movement

**Cons**:
- Fixed homography is tied to a limited head-pose regime
- Needs display classification (which screen is the user looking at?)
- Less robust for angled or non-coplanar displays
- Feature point choice (pupil center, eye corner, etc.) affects accuracy

### 6.4 Approach D: Screen-Aware Offset Model

Keep a single-screen model but apply a coordinate transformation based on detected screen focus.

**How it works**:
1. Calibrate on the primary screen as usual
2. At runtime, detect which screen contains the gaze via head pose or by testing which screen's bounds contain the raw prediction
3. When the gaze is determined to be on a different screen, apply a learned offset or separate model per screen
4. Potentially use the Kalman filter to smooth transitions

**This is essentially a hybrid of A and B** — it can start simple (per-screen offsets) and evolve toward unified calibration.

### 6.5 Approach E: 3D Gaze Ray + Screen Plane Intersection

Instead of 2D regression, estimate the 3D gaze direction vector and intersect it with known screen planes.

**How it works**:
1. Estimate 3D eye position and 3D gaze direction (unit vector) in camera coordinates
2. Calibrate the transformation from camera coordinates to world coordinates (where screen planes are defined)
3. Intersect the gaze ray with each screen plane → find which screen is hit and at what pixel
4. Handle head movement by tracking the camera-to-world transform

**Pros**:
- Physically grounded — handles arbitrary screen arrangements
- Robust to head movement (3D tracking)
- Natural handling of screen boundaries and bezels
- Works with any number of screens in any configuration

**Cons**:
- Requires 3D gaze estimation, which is harder than 2D
- EyeTrax currently outputs 2D coordinates, not 3D gaze vectors
- Would need a different model architecture (appearance-based 3D gaze estimation)
- More complex calibration (multiple known 3D points)
- Camera position must be known or calibrated

### 6.6 Recommendation

**Start with a piecewise 2D strategy** (Approaches A + C — per-display local regressors with homography-style mapping) for the near term, with **unified global calibration** (Approach B) as the data-collection umbrella, then evolve toward **3D gaze rays** (Approach E) for long-term robustness.

Rationale:
1. The two-stage decomposition (display identity → local coordinates → OS cursor) is the most important architectural lesson from GazeProjector, Pupil Labs, and commercial multi-screen systems
2. Per-display local regressors keep accuracy high within each screen and naturally handle different resolutions / DPI scaling
3. Head pose yaw provides a reasonable display classifier for horizontal desk layouts
4. The homography/polynomial approach is fast enough for real-time use
5. Approach E (3D rays + screen plane intersection) is the long-term ideal — it generalizes to arbitrary screen geometry, angled displays, and free head movement — but requires a significant model architecture change (3D gaze direction estimation instead of 2D regression)

**Calibration design rules** from research practice:
- Use a **two-tier procedure**: first a short face/head normalization step (so the head-pose estimator sees moderate movement), then per-display grids
- **Bias calibration grids toward edges and corners**, especially the edges adjacent to other monitors — this is where cross-screen accuracy matters most
- Classic 9-point calibration is not sufficient once the task space spans multiple screens; EyeTrax's dense grid (81-point) is a better starting point
- Validate with visual stimuli before real use: after calibration, show fixed targets and confirm that gaze data aligns accurately

### 6.7 Algorithm Families Comparison

| Family | Core Math | Pros | Cons | Typical Expectation |
|---|---|---|---|---|
| **Global desktop regression** | One model predicts one global `(x, y)` over entire desktop | Very easy to bolt onto single-screen codebase | Breaks with DPI changes, monitor rearrangement, bezel gaps, angled screens | Quick prototype only. EyeTrax's current shape most closely resembles this baseline |
| **Per-display homography / polynomial** | Separate `H_i` or regressor per display | Fast, low-latency, easy to calibrate, good for flat desks | Needs display classification; weak under large head movement | Good first production step for contiguous desk setups |
| **Adaptive homography** | Mapping corrected by head-pose variables `H_i(h)` | Better robustness without full 3D eye model | Still a local approximation; calibration/data demands rise | Strong upgrade path for webcam systems |
| **Monocular 3D head+eye model** | Estimate `R_head`, `R_eye`, build gaze ray, intersect with screens | Generalizes to arbitrary screen geometry; physically interpretable | More sensitive to calibration and 3D estimation quality | Best long-term architecture for single webcam |
| **Head-mounted screen mapping** | Scene-camera display tracking + calibrated eye gaze | Excellent for arbitrary displays; natural display identification | Different hardware category | Pupil Labs and GazeProjector demonstrate this is one of the cleanest multi-display solutions |
| **Multi-camera RGB / IR** | Triangulation / fused 3D observations across cameras | Best free-movement robustness | More hardware, sync, and calibration complexity | Research/commercial gold standard (Smart Eye Pro, Tri-Cam) |
| **Screen-content-aware estimation** | Uses display content/reflections in addition to appearance | Promising accuracy gains on consumer devices | Not yet a standard open-source desktop stack | Important future direction (HiFiGaze); not an immediate baseline |

---

## 7. Overlay Architecture for Multi-Screen

### 7.1 The Problem

The current architecture creates exactly two overlay windows (red dot + highlight), both bounded by `NSScreen.mainScreen().frame()`. With multiple displays:

1. When `Displays have separate Spaces` is enabled (default), a window cannot span displays
2. Even if spanning were possible, a single overlay window would need to cover the entire desktop bounding box (potentially very large, with gaps where bezels are)
3. The red dot must be visible on whichever display the user is looking at

### 7.2 Solution: One Overlay Window Per Display

Create independent overlay windows for each connected display:

```
For each NSScreen in NSScreen.screens:
    Create red dot NSWindow with frame = screen.frame()
    Create highlight NSWindow with frame = screen.frame()
    Set appropriate level, collection behavior, ignoresMouseEvents
```

**Red dot visibility**: Only show the dot on the display where gaze currently lands. The other displays' dot windows either hide (`orderOut_()`) or position the dot off-screen.

**Highlight visibility**: Same strategy — only the display containing the focused UI element shows highlight boxes.

### 7.3 Coordinate Mapping for Overlays

The overlay windows are positioned using Cocoa coordinates (`NSWindow.setFrameOrigin_` uses bottom-left origin). The gaze model outputs global Quartz coordinates (top-left origin). The conversion chain:

```
Gaze model output (x_g, y_g)  ← Quartz global coords (top-left origin)
    │
    ├─ Determine which display contains (x_g, y_g)
    │
    ├─ Convert to that display's local Cocoa coords for overlay positioning:
    │   display_cocoa_origin = NSScreen.screens[i].frame().origin
    │   dot_cocoa_x = x_g - display.quartz_x
    │   dot_cocoa_y = display.quartz_height - (y_g - display.quartz_y)
    │     ...or equivalently, use CGDisplayBounds for Quartz coords
    │
    └─ Set NSWindow origin on the appropriate overlay window
```

### 7.4 Dynamic Display Changes

When displays are connected/disconnected/rearranged:
1. Subscribe to `NSApplicationDidChangeScreenParametersNotification`
2. Re-enumerate screens
3. Create overlay windows for new displays, destroy for removed displays
4. Reposition existing windows if displays moved
5. Update the calibration if the primary arrangement changed significantly

### 7.5 The "Displays have Separate Spaces" Interaction

With separate Spaces enabled (default):
- Each display's overlay windows join all Spaces on their respective display via `NSWindowCollectionBehaviorCanJoinAllSpaces`
- Windows cannot jump between displays — each overlay window stays on its assigned display
- This is actually **beneficial** for our architecture: one window per display means each window naturally stays where it should

Without separate Spaces:
- A single large window spanning the entire desktop could work
- But the multi-window approach still works correctly
- The multi-window approach is more robust across both modes

**Verdict**: Always use one-window-per-display. It works with both settings.

### 7.6 OpenCV Calibration Window Per Display

During calibration, each display needs a fullscreen calibration window:
- For unified global calibration: show calibration window on each display sequentially, or show multiple simultaneously
- For per-screen calibration: standard fullscreen window on each display, one at a time
- Each calibration window uses its display's frame for positioning

---

## 8. UI Element Detection (AX API) Across Multiple Screens

### 8.1 How the AX API Handles Multi-Screen

`AXUIElementCopyElementAtPosition(x, y)` takes coordinates in the **Quartz global coordinate space** (top-left origin of primary display). This is explicitly documented by Apple: coordinates are in "top-left relative screen coordinates."

Key properties:
- Coordinates can be negative (displays left of or above primary)
- Coordinates can exceed the primary display's bounds (displays right of or below primary)
- The returned `AXPosition` attribute values are also in this global space
- The function works correctly across all connected displays

**Current code assumption**: `ui_detector.py` creates `UIDetector(screen_w, screen_h)` where the dimensions come from the primary display only. The position normalisation in `hit_test_at()` uses heuristics like `if py < -2000 or py > 10000:` which may not correctly handle valid coordinates on secondary displays.

### 8.2 Required Changes to UI Detector

**Remove primary-screen bounds assumption**:
- `UIDetector` should accept the full desktop layout, not just `(screen_w, screen_h)`
- The position normalisation heuristic should use the known display topology instead of magic numbers
- `_is_own_element()` filtering still works (based on `app_name`, display-independent)

**Window cache across displays**:
- `CGWindowListCopyWindowInfo` already returns all windows across all displays
- The window cache doesn't need changes, but `window_at()` should use global coordinates
- The `get_active_app_info()` hit-test at screen center should be relative to the active display, not the primary

**Coordinate conversion**:
- `UIDetector` currently uses top-left (AX) coordinates for its public API — this is correct
- The gaze model's output must also be in top-left (AX) global coordinates
- No change needed in the coordinate convention, just in the bounds

### 8.3 The Swindler Bug: NSScreen vs AX Coordinate Mismatch

A well-documented macOS gotcha ([Swindler #62](https://github.com/tmandry/Swindler/issues/62)): `NSScreen.screens` reports frames in Cocoa coordinates (bottom-left origin), but `AXUIElementCopyElementAtPosition` and `AXPosition` use Quartz global coordinates (top-left origin). With multiple displays arranged vertically, the Y values **disagree in sign** for displays above the primary.

**Example**: Laptop below, monitor above:
```
NSScreen.screens:  Monitor frame origin.y = 982 (positive, Cocoa)
AX/Quartz:         Monitor top-left Y = -1080 (negative, Quartz)
```

**Must handle**: Always convert through the global Quartz coordinate space for AX interactions. Use `CGDisplayBounds` for display positions when interfacing with AX.

---

## 9. Accuracy and Head Movement Challenges

### 9.1 The Fundamental Problem

Appearance-based gaze estimation accuracy degrades with:
1. **Larger gaze angles**: The eye region changes appearance significantly at extreme angles
2. **Head rotation**: MediaPipe landmark accuracy decreases; eye features foreshorten; one eye may become partially occluded
3. **Distance variation**: The model assumes a fixed camera-to-face distance; leaning forward/back changes the apparent face size
4. **Lighting variation**: Different head angles catch light differently, changing eye appearance

In a multi-screen setup, all four factors are amplified:
- Looking at the far edge of an external monitor requires 30–60° head rotation
- The user may lean or shift position when focusing on different screens
- Ambient light hits the face differently when the head is turned

### 9.2 Expected Accuracy Degradation

No published benchmarks exist specifically for webcam-based gaze tracking across multiple monitors. However, we can extrapolate from related research:

| Scenario | Expected error (single screen) | Expected error (dual screen) | Source |
|---|---|---|---|
| Fixed head, calibrated | 2–4 cm (~1.5–3° at 60cm) | 4–8 cm | [SmartEye best practices](https://smarteye.se/blog/eye-tracking-in-multi-screen-setups-best-practices-from-complex-research-labs/) |
| Free head movement | 3–6 cm | 6–15 cm | [Frontiers gaze estimation paper](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full) |
| Extreme yaw (>45°) | 8–15 cm | 15–30 cm | Extrapolated from ETH-XGaze benchmarks |

The SmartEye blog explicitly notes: "gaze points can misfire in the transitions. Fixations may appear jittery or cut short, while saccades between screens might get stretched or misplaced."

### 9.3 Mitigation Strategies

1. **Denser calibration on each screen**: More calibration points → better spatial coverage
2. **Nonlinear models**: The TinyMLP model (64→32 neurons) may capture nonlinear eye→screen mappings better than linear models at large angles
3. **Per-screen sub-models**: Training separate models per screen, each with its own head-pose distribution, can improve within-screen accuracy
4. **Kalman filter tuning**: The Kalman filter's process noise can be increased for multi-screen to handle larger gaze jumps
5. **Dead zone at screen boundaries**: Accept that accuracy near screen edges (especially the boundary between displays) will be poor, and interpolate or fall back gracefully
6. **Head pose as a gating signal**: Use yaw to roughly determine which screen the user faces, then use a screen-specific model for fine-grained prediction
7. **User distance awareness**: If distance to screen can be estimated (e.g., from face size in the camera), the coordinate mapping can be adjusted

### 9.5 Mathematical Foundations: The Output Representation Choice

The most important algorithmic design choice is the **output representation** of the gaze estimator. This choice propagates through every downstream component.

**Option 1: Direct global desktop regression** (current EyeTrax model). One model predicts one global `(x, y)` over the entire virtual desktop. This is the simplest to implement but breaks badly with DPI changes, monitor rearrangement, bezel gaps, and angled screens. It is appropriate only for a quick prototype.

**Option 2: Per-display local regression with classifier**. A lightweight display classifier selects the active monitor, then a per-display regressor outputs local normalized coordinates `(ũ, ṽ) ∈ [0,1]²`. This is the recommended first production target — it handles different resolutions/scaling naturally and keeps within-screen accuracy high.

**Option 3: 3D gaze ray with screen-plane intersection**. The estimator outputs a 3D eye position `p_e` and gaze direction unit vector `g`. For each display plane `Π_i` with normal `n_i` and origin `o_i`:

```
r(t) = p_e + t·g,  t ≥ 0                         (gaze ray)
t_i = −(n_iᵀ·p_e + d_i) / (n_iᵀ·g)                (intersection parameter where d_i = −n_iᵀ·o_i)
x_i = p_e + t_i·g                                 (3D hit point)
u_i = (x_i − o_i)·e_{x,i},  v_i = (x_i − o_i)·e_{y,i}   (local display coordinates)
```

A hit is valid only if `t_i > 0` (in front of eye) and `(u_i, v_i)` lies inside the physical width/height of the display. This formulation naturally handles angled, stacked, and heterogeneous displays because it treats each monitor as its own 2D surface embedded in 3D. It is the long-term target architecture.

**Head + eye decomposition**: Modern monocular 3D formulations decompose gaze as a geometric composition:

```
g = R_head · R_eye · g_0
```

where `g_0` is a canonical forward eye axis. This is superior to direct desktop regression because it produces a geometric quantity (a 3D ray) that can be intersected with any display plane, regardless of screen arrangement. This is the approach used by the ICCV 2017 monocular free-head gaze work and is corroborated by GazeProjector's per-display geometry approach.

**Per-display homography**: For planar coplanar setups, a simpler alternative maps selected 2D feature points directly to display coordinates:

```
λ·[u, v, 1]ᵀ = H_i(h) · [f_x, f_y, 1]ᵀ
```

where `H_i(h)` is a head-pose-conditioned homography per display. This is faster than full 3D ray casting and sufficient for flat dual-monitor desks.

### 9.6 Probabilistic Filtering for Multi-Screen

The filtering strategy must be redesigned for multi-screen because a single global low-pass filter creates **sticky edges**, **late monitor switches**, and **wrong-screen hysteresis**. The correct approach separates two concerns:

**1. Screen-selection hysteresis** — stabilize which display is active. Use a small state machine: switch displays only after `k` consecutive frames predict a different display, or after the posterior margin exceeds a threshold `τ`. This prevents boundary flicker.

**2. Within-screen coordinate smoothing** — once the display is selected, smooth cursor coordinates with a Kalman or 1€ filter within that display's local frame. This provides the same jitter reduction as the current single-screen filter but without cross-display artifacts.

A useful Kalman state vector for the pointer:

```
x_t = [p_x, p_y, v_x, v_y, a_x, a_y, b_x, b_y]ᵀ
```

where `p` is pointer position, `v` velocity, `a` acceleration, and `b` is a slowly varying bias/drift term. The bias state enables online correction (see §9.7). The measurement model operates in the selected display's local coordinate frame:

```
x_t = A·x_{t-1} + w_t          (process model)
z_t = h(x_t) + v_t             (measurement model)
```

**Latency compensation** uses prediction. If the total loop delay is `Δ`:

```
p̂(t+Δ) = p_t + Δ·v_t + ½·Δ²·a_t
```

The delay `Δ` should be measured as the sum of **frame age + inference time + filter delay + OS/compositor delay + display scan-out**, not guessed. This delay is display-dependent when monitors have different refresh rates (e.g., 60 Hz + 144 Hz).

### 9.7 Online Offset Correction (Drift Compensation)

Borrowed from WebGazer and Tri-Cam: use interactions that users already perform as weak calibration labels. Every click, dwell-confirmed button press, or explicit "recenter" action updates a small per-display offset/bias model:

```
# On each confirmed interaction at known screen position (x_known, y_known):
bias_x ← bias_x + α·(x_known − x_predicted)
bias_y ← bias_y + α·(y_known − y_predicted)
```

This should be applied at the **per-display local** level, not in global desktop coordinates, because drift patterns differ per display (different viewing angles, different distances). Store bias profiles by user and display topology to survive restarts.

### 9.8 Bezel Gap Policies

Physical bezels between displays create regions with no active target surface. The system must choose an explicit policy:

- **Dead zone**: Preserve the true gap — cursor disappears during cross-screen saccades. Physically accurate but potentially disorienting for the user.
- **Monitor-level warping with local smoothing**: When predicted gaze exits the active display and enters the neighbor's transition strip, the logical cursor is moved to the homologous edge on the neighboring monitor, then normal smoothing resumes in the new local frame. This is usually easier to use and is the recommended default.
- **Snapping**: Warp the cursor to a predetermined anchor point on the target display (e.g., center or last-known position).

Prior multi-monitor HCI research found pointer warping across bezels faster and often preferred in heterogeneous multi-monitor setups, which is highly relevant when using gaze as the pointer source.

---

## 10. Commercial Products & Multi-Screen Landscape

### 10.1 Commercial Eye Trackers

| System | Multi-Screen Position | Hardware / Rate / Accuracy | Relevance |
|---|---|---|---|
| **Eyeware Beam** | Explicitly advertises a **multi-screen pointer**: "Look at a screen and your mouse follows automatically." | Webcam / mobile-device consumer tracking | Strong evidence screen-level switching is commercially viable with commodity imaging; internal mapping details not public |
| **Tobii Eye Tracker 5** | Officially single screen only (max 27" 16:9 or 30" 21:9); head/camera tracking for gaming, not direct cross-screen gaze | Consumer remote IR tracker | Important negative control: naïve "just extend the desktop" is insufficient even for hardware trackers |
| **Tobii Pro Spectrum** | Multi-screen via 3D world model; supports tracker alone, with monitor, or with "other screens" | Median ~0.30° head-supported, ~0.43° head-free, <2 ms latency at 1200 Hz, 100 µs tracker/client sync | Research-grade reference for latency, sync, and calibration quality |
| **Smart Eye Pro** | Full multi-screen, angled displays, control-room environments; explicitly positioned for simulators and complex layouts | 2–8 cameras, 90°–360° FOV, 0.5° gaze accuracy under ideal conditions, optical/electrical sync | Best reference for what "serious" multi-screen geometry support looks like |
| **EyeWorks Multi-Display** | Explicit support for tracking across multiple "out of the window channels" or side-by-side displays with synchronized video | Research platform; synchronized multi-display recording | Evidence that synchronized per-display representation is standard in research labs |
| **Pupil Labs Neon** | Open-source real-time screen mapping; separate cursor-control demo; identifies displays through markers in scene camera | 200 Hz gaze, 110 Hz head pose / IMU, <10 ms photon-to-output latency, 1.8° uncalibrated / 1.2° corrected | Strongest public reference architecture for mapping gaze to arbitrary screens in real time |
| **Tobii Dynavox PCEye / TD Control** | Assistive eye-gaze computer control on Windows; recommended up to 27", 33 Hz gaze data rate | Windows eye-control compatibility | Important assistive benchmark for usability expectations |
| **NUIA.AI** | Middle layer translating eye-tracking data into commands; combines eye control with voice | Software bridge / workplace productivity platform | Relevant pattern: eye control as middleware, not embedded per-application |

**Key takeaway**: Consumer-grade eye trackers (Tobii 5) are limited to single screens. Multi-screen support requires professional systems (Smart Eye Pro, Tobii Pro Spectrum) or head-mounted trackers (Pupil Labs) that use 3D eye models and explicit display geometry. The existence of Eyeware Beam as a webcam-based multi-screen pointer product is encouraging — it proves the concept is viable with commodity hardware, even if the exact mapping approach is proprietary.

### 10.2 Open-Source Projects Most Relevant to Multi-Screen

| Project | Relevance | Main Value | Main Limitation |
|---|---|---|---|
| **EyeTrax** | Current conceptual baseline | Multiple calibration modes, filtering, persistence, Python stack | Single-output assumption |
| **pupil-labs/real-time-screen-gaze** | Directly relevant | Real-time screen coordinates via display detection in scene camera using AprilTags | Requires head-mounted Pupil hardware / scene view |
| **pupil-labs/gaze-controlled-cursor-demo** | Directly relevant | End-to-end cursor-control demo on top of real-time screen gaze | Same hardware constraint as above |
| **Miranda eye tracking** | Practical calibration toolkit | Calibrates eye/head tracker input to screen gaze; can move cursor or publish UDP | Early-stage |
| **UnitEye** | Good webcam/HCI reference | Calibration, filtering, evaluation, AOIs, runtime GUI | Heavy filtering; strong sensitivity to webcam position / lighting |
| **Webcam-Eye-gazing-point-Tracker** | Practical low-cost reference | Monitor selection, simple calibration, ridge-regression baseline, OneEuro+EMA smoothing | Small project; limited evidence of robustness |
| **WebGazer.js** | Useful calibration idea source | Self-calibrates from clicks / cursor movement; browser-friendly | Page-local gaze, not a full OS multi-display pointer system |
| **OpenFace** | Useful component library | Landmarking, head pose, gaze estimation, real-time webcam operation | Not a ready-made multi-screen mapper |
| **GazeML / OpenGazer** | Historical baselines | Good for understanding model/data design and calibration structure | Older assumptions; weaker fit for modern multi-screen control |

**Ecosystem assessment**: True multi-screen gaze control is still underrepresented in open source. Many repositories solve gaze direction or single-screen pointing, but only a smaller subset tackles **display geometry** or **cross-display mapping**. The strongest open-source exemplars for this use case are Pupil Labs' screen-gaze and cursor-demo projects, because they explicitly map gaze to screens in real time and then drive the pointer. The missing piece is mostly **systems integration**, not missing theory.

### 10.3 Academic Systems

The [Fraunhofer dual-monitor eye tracking system](https://publica.fraunhofer.de/bitstreams/ef6d591c-0f22-44e4-9fef-f7ebd1a0be3b/download) uses **two separate eye tracking devices** — one per monitor — and combines their outputs. This is essentially per-screen calibration implemented in hardware.

**GazeProjector** ([Lander et al.](https://www.collaborative-ai.org/publications/lander15_techrep.pdf)) is the seminal multi-display academic system. It handles multiple displays by calibrating pupil positions to a scene camera coordinate system and tracking the spatial relationship between eye and environment. It reports average gaze-estimation accuracy of **2.47° on multiple displays** in evaluation, making it the strongest academic reference for cross-display gaze mapping.

**Falch and Lohan** ([Frontiers, 2024](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full)) combine appearance-based webcam gaze estimation with 3D position estimation from a 2D webcam and Structure-from-Motion-based head-movement compensation for screen interaction. This is highly relevant because it shows how to recover 3D geometry from a single webcam.

**Tri-Cam** ([arXiv, 2024](https://arxiv.org/html/2409.19554v1)) uses three affordable RGB webcams to achieve Tobii-comparable accuracy while supporting wider free movement. It explicitly splits the problem into camera–eye geometry and eye–screen geometry, and uses mouse click opportunities to reduce calibration overhead.

The [SPIE paper on multi-screen eye tracking](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/13635/1363506/Research-on-multi-screen-eye-tracking-and-manipulation-intent-recognition/10.1117/12.3058113.full) addresses intent recognition across multiple screens using gaze behavior analysis.

**Recent deep learning advances** (relevant for future model upgrades):
- **L2CS-Net**: Reports 3.92° on MPIIGaze and 10.41° on Gaze360; strong unconstrained RGB gaze-direction estimation
- **3DGazeNet**: Reframes gaze estimation as dense 3D eye-mesh regression; strong cross-dataset generalization
- **HiFiGaze**: Adds screen-content cues to appearance-based estimation; reports ~8% mean tracking-error reduction over appearance-only baseline

---

## 11. Tradeoffs Summary

| Aspect | Single Screen (Current) | Multi-Screen (Proposed) |
|---|---|---|
| **Calibration time** | ~1–2 min (81 points) | ~2–6 min (N × 81 points or larger unified grid) |
| **Model complexity** | 1 regression model | 1 unified model or N per-screen models + selector |
| **Accuracy (center of screen)** | ~2–4 cm | ~3–6 cm (estimated) |
| **Accuracy (screen edges)** | ~4–8 cm | ~8–15 cm (estimated, esp. at display boundaries) |
| **Accuracy (cross-screen saccades)** | N/A | Poor — expect misfires |
| **Overlay complexity** | 2 NSWindows | 2N NSWindows (N = number of displays) |
| **Coordinate handling** | Simple — one screen bounds | Complex — global coords, Y-flip management, display topology |
| **Dynamic display changes** | N/A | Must handle connect/disconnect/rearrange |
| **AX API interaction** | Bounded to primary screen | Full global coordinate space |
| **Head movement robustness** | Moderate | Degraded — larger angular range |

---

## 12. Current Ecosystem & Implementation Landscape

### 12.1 What the Current Code Provides

- **Feature extraction**: Robust, head-pose-invariant normalization (gaze.py)
- **Calibration infrastructure**: Dense grid, adaptive, 5-point, 9-point, Lissajous (calibration/)
- **Regression models**: Ridge, ElasticNet, SVR, TinyMLP (models/)
- **Screen detection**: `NSScreen.mainScreen().frame().size` (screen.py) — single screen only
- **Overlay windows**: PyObjC NSWindow with collection behaviors (gaze_tracker.py)
- **UI detection**: AX hit-testing, window enumeration, parent walk (ui_detector.py)

### 12.2 What Must Be Built

1. **Display topology module**: Enumerate displays, track arrangement, handle changes
2. **Multi-screen calibration UI**: Calibration windows on multiple displays, global coordinate targets
3. **Coordinate conversion layer**: Centralised conversion between all coordinate systems with display-awareness
4. **Multi-window overlay manager**: Create/destroy overlay windows as displays change, route gaze to correct window
5. **Screen detection/focus logic**: Determine which display the user is looking at
6. **Updated UI detector**: Remove primary-screen bounds assumptions, handle global coordinates

### 12.3 What Must Be Modified

- `eyetrax/utils/screen.py`: `get_screen_size()` → return full desktop layout, not just primary
- `gaze_tracker.py`: Multi-window overlay, handle global coordinates, display topology
- `computer_control.py`: Multi-screen calibration, highlight routing, display change notifications
- `ui_detector.py`: Remove primary-screen bounds assumptions, handle global AX coordinates

### 12.4 What Should NOT Change (Module Isolation)

Per the project's AGENTS.md Rule 3:
- `gaze_tracker.py` must NOT import `ui_detector` or `computer_control`
- `ui_detector.py` must NOT import `gaze_tracker` or `computer_control`
- All multi-screen coordination must happen in `computer_control.py`

### 12.5 Reference Design: DisplayPlane Abstraction

A recommended geometry object for the codebase — each monitor is modeled as a 3D surface with both physical and logical properties. This abstraction cleanly separates the physical geometry (used for gaze ray intersection) from the OS logical rectangle (used for cursor positioning).

```python
from dataclasses import dataclass
import numpy as np

@dataclass
class DisplayPlane:
    id: str
    name: str
    logical_rect: tuple[int, int, int, int]   # x, y, w, h in OS logical coords
    scale_x: float
    scale_y: float
    width_mm: float
    height_mm: float
    origin_w: np.ndarray                       # 3D world/camera-space origin
    ex_w: np.ndarray                           # local x-axis on display plane
    ey_w: np.ndarray                           # local y-axis on display plane
    normal_w: np.ndarray

def intersect_ray_with_display(eye_w, gaze_w, d: DisplayPlane):
    denom = float(np.dot(d.normal_w, gaze_w))
    if abs(denom) < 1e-6:
        return None
    plane_offset = -np.dot(d.normal_w, d.origin_w)
    t = -(np.dot(d.normal_w, eye_w) + plane_offset) / denom
    if t <= 0:
        return None
    hit = eye_w + t * gaze_w
    u_mm = float(np.dot(hit - d.origin_w, d.ex_w))
    v_mm = float(np.dot(hit - d.origin_w, d.ey_w))
    if not (0 <= u_mm <= d.width_mm and 0 <= v_mm <= d.height_mm):
        return None
    x0, y0, w_log, h_log = d.logical_rect
    x_log = x0 + (u_mm / d.width_mm) * w_log
    y_log = y0 + (v_mm / d.height_mm) * h_log
    return x_log, y_log
```

For a first EyeTrax integration, you do not need perfect 3D screen measurements — you only need the abstraction boundary. Start with a coplanar approximation and improve pose estimates later without rewriting the rest of the program. This is the single most important code-level design decision.

### 12.6 Cross-Platform OS API Reference

While this project is macOS-only, the architectural patterns transfer. These are the relevant OS primitives for monitor geometry, DPI/scale, and cursor injection on each platform:

| Platform | Monitor Geometry | Scale / DPI | Cursor Injection | Important Note |
|---|---|---|---|---|
| **Windows** | `EnumDisplayMonitors`, `GetMonitorInfo`, `QueryDisplayConfig`, virtual-screen metrics (`SM_CXVIRTUALSCREEN`, `SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN`) | `GetDpiForMonitor`; desktop coords depend on DPI-awareness mode | `SetCursorPos` or `SendInput` | Virtual screen = bounding rect of all monitors, with explicit left/top origin metrics |
| **macOS** | `NSScreen.screens`, `CGDisplayBounds`, `CGGetActiveDisplayList` | `backingScaleFactor`; AppKit/CoreGraphics coords must be converted carefully | `CGWarpMouseCursorPosition` / `CGDisplayMoveCursorToPoint` | Do not mix AppKit "points" and CoreGraphics display coordinates implicitly (§4 covers this in detail) |
| **Linux X11** | RandR / XRandR monitor geometry | Depends on toolkit; Qt is the easiest portable abstraction | XTEST `XTestFakeMotionEvent` | Reasonable first Linux target for whole-desktop cursor control |
| **Wayland** | `wl_output` + `xdg-output` logical size / position | Logical size differs from physical mode size under fractional scaling | Compositor-dependent; geometry standardized more cleanly than global injection | Build geometry on logical outputs, then handle pointer per compositor |
| **Cross-platform** | Qt `QScreen` or Python `screeninfo` | `devicePixelRatio()` / Qt high-DPI APIs | Use native backends underneath | Best default abstraction for portable Python applications |

### 12.7 Recommended Datasets and Evaluation Tools

| Resource | Why It Matters | Best Use in This Project |
|---|---|---|
| **MPIIGaze** | 213,659 face images from 15 users during everyday laptop use; strong webcam-style baseline | Pretraining / sanity checks for monocular gaze models |
| **MPIIFaceGaze** | Adds face regions, facial landmarks, and pupil centers for 37,667 images | Better fit for face+head+eye model evaluation |
| **Gaze360** | 238 subjects, wide head poses and distances, indoor/outdoor, 3D labels | Stress-test free-head robustness and angular generalization |
| **EYEDIAP** | RGB and RGB-D gaze dataset with diverse participants, head poses, and targets | Controlled evaluations, especially head-movement analysis |
| **UnityEyes / UnityEyes 2** | Synthetic eye generation for training and augmentation | Data augmentation for corner cases and calibration bootstrapping |
| **PyGaze / PsychoPy** | Mature open-source experimentation stack; PsychoPy supports many eye trackers | Building repeatable calibration and validation experiments |
| **pymovements / REMoDNaV** | Open-source preprocessing and event-detection tools | Offline analysis of drift, fixations, saccades, and precision |
| **screeninfo / Qt** | Practical monitor enumeration and scaling abstraction | Runtime monitor-geometry service for the application |

---

## 13. Implementation Roadmap (High-Level)

This section outlines the logical phases for implementation, without prescribing code changes. This is for planning purposes only. The phases are cumulative — each builds on the previous one.

### Phase A: Introduce a Geometry Layer Before Changing the Model
- Build a `DisplayLayout` data structure representing all connected displays (logical rects, scale factors, refresh rates, persistent IDs)
- Implement display enumeration via `NSScreen.screens` + `CGDisplayBounds`
- Subscribe to `NSApplicationDidChangeScreenParametersNotification` for layout changes
- Refactor the current estimator output from "global desktop coordinates" to either "local normalized coordinates on active display" or a geometry-neutral latent representation
- Centralise coordinate conversion (Cocoa ↔ Quartz ↔ global desktop)
- Write thorough tests for coordinate conversion in all quadrants (positive and negative)

### Phase B: Per-Display Calibration and Piecewise Mapping
- Replace one global regressor with one display classifier + one regressor per display
- Start with contiguous/coplanar assumptions
- Use dense per-display calibration grids, biased toward edges and corners
- Implement display selection with hysteresis: switch displays only after `k` consecutive frames or after posterior margin exceeds threshold `τ`
- Add edge-biased validation targets
- This is the highest-value near-term upgrade for ordinary desks

### Phase C: Separate Temporal Smoothing into Screen Selection and Local Motion
- Stabilize screen identity with a small state machine or posterior smoother
- Smooth cursor coordinates within the selected display separately using Kalman/EMA/1€-style filter
- Add look-ahead prediction using measured latency (frame age + inference time + filter delay + compositor delay + display scan-out)
- Avoid a single global low-pass filter across the whole desktop

### Phase D: Add Head Pose and Move to 3D Display Planes
- Once the piecewise 2D system works, add head pose estimation and define screens as planes in 3D
- Compute the gaze ray and intersect it with whichever display plane is hit first
- This is where angled side monitors, stacked monitors, and more serious drift handling become tractable
- OpenFace and GazeProjector are the strongest public technical references for this phase

### Phase E: Add Online Correction and Adaptation
- Use interactions users already perform (clicks, dwell confirmations) as weak calibration labels
- Each confirmed interaction updates a small per-display offset/bias model
- Store bias profiles by user and display topology
- This reduces the frequency of explicit recalibration without pretending calibration is unnecessary

### Phase F: Harden OS Integration and Timing
- Timestamp every stage of the pipeline with a monotonic clock
- Handle dynamic display connect/disconnect/rearrangement
- Handle mixed Retina + non-Retina displays (different `backingScaleFactor` values)
- Handle mirroring mode
- Handle external display sleep/wake transitions
- On multi-GPU systems (e.g., MacBook Pro with external GPU), ensure correct adapter mapping

**If you stop after Phase C**, you achieve a strong practical system for ordinary coplanar multi-monitor desks. **If you continue to Phase E**, you approach the design pattern used by research and commercial multi-display systems.

---

## 14. Validation Methodology

Multi-screen support is not validated unless you test at monitor boundaries, on side monitors, and after long sessions that allow drift to accumulate.

### 14.1 Metrics

Use **both angular and screen-space metrics**:
- **Angular error** (degrees of visual angle) — the standard eye-tracking metric. Screen size, resolution, and viewing distance must be reported to make these values interpretable.
- **Screen-space error** — in logical pixels and millimeters, per display.
- **Precision** — standard deviation or RMS of gaze samples during fixation; ideally also dispersion metrics (e.g., BCEA).
- **Data loss** — percentage of frames where no valid gaze prediction is produced.
- **End-to-end (closed-loop) latency** — measured from eye movement to visible pointer response on the target monitor.
- **Throughput** — for interaction tasks, ISO 9241-9 style throughput (bits/second) for dwell-based target acquisition, capturing the combined effect of accuracy, latency, and ergonomics.

### 14.2 Minimum Validation Battery

- **Static target validation per display**: 9, 25, and 49 targets, with extra points near inter-monitor edges
- **Boundary transition test**: Repeated saccades that cross each bezel in both directions at multiple speeds
- **Head movement robustness test**: Seated-center, seated-off-center, lean-in, lean-back, yaw left/right
- **Drift test**: Repeat validation after 15, 30, and 60 minutes without recalibration
- **DPI/scale test**: Mixed standard-DPI and high-DPI monitors, including fractional scaling where applicable
- **Refresh asymmetry test**: e.g., 60 Hz + 144 Hz mixed monitors, measuring perceived and timestamped response
- **Interaction test**: Fitts-style dwell selection or point-acquire tasks to measure throughput and correction rate

### 14.3 Testbed Checklist

- Monitor make/model, logical resolution, physical size, rotation, scale, refresh rate, and GPU/adapter mapping recorded
- Viewing distance and camera placement measured
- Room lighting and presence of glasses/contact lenses documented
- Raw gaze, filtered gaze, display ID, timestamps, blink/confidence, and cursor position logged
- Calibration targets and validation targets version-controlled
- Reproducible monitor-layout snapshots saved
- Closed-loop latency test script available
- One "known bad" test case kept for regression testing (e.g., off-center user + side monitor + fractional scaling)

---

## 15. Open Questions

These require further investigation or user input before implementation:

1. **What is the target multi-screen configuration?** The approach may differ for "laptop + external monitor" vs. "three identical displays in a row" vs. "ultrawide + secondary." The most common setup should drive the initial design.

2. **Is "Displays have separate Spaces" a hard requirement to support?** If users are willing to disable it, a single spanning window simplifies the overlay architecture. But the default is "enabled," and most users won't change it.

3. **What accuracy is acceptable?** If the primary use case is "which screen am I looking at" (coarse), the problem is much easier. If it's "which button on the far screen" (fine), accuracy requirements are stringent and current webcam-based methods may be insufficient.

4. **Should we keep single-screen mode as a fallback?** If only one display is connected, fall back to the current (simpler, more accurate) single-screen pipeline.

5. **Can the calibration be made less burdensome?** 81 points per screen × 3 screens = 243 calibration points. Can we reduce this with smarter sampling (e.g., fewer points on the secondary screen, or leveraging head pose to share training data across screens)?

6. **Should the gaze model output be treated as a 3D direction vector instead of 2D coordinates?** This is a fundamental architectural decision that affects everything downstream. 3D gaze is more robust but requires different models and calibration.

7. **What happens to the Kalman filter across screen boundaries?** Currently tuned for smooth within-screen tracking. Cross-screen saccades involve large, fast gaze jumps that the Kalman filter may incorrectly smooth (lag). The filter may need to be screen-boundary-aware.

8. **How do we handle the camera being on only one display?** In a multi-display setup, the webcam is typically mounted on one display (usually the laptop). When the user looks at another display, the relative camera-to-eye geometry changes significantly. This may require estimating the 3D head position, not just orientation.

---

## 16. Sources

### Tier 1 — Primary

| Source | Contribution |
|---|---|
| [EyeTrax source code (gaze.py)](https://github.com/ck-zhang/EyeTrax) — installed at `.venv/lib/python3.14/site-packages/eyetrax/` | Full understanding of feature extraction, normalization, model architecture, and calibration pipeline |
| [Apple CGDisplayBounds documentation](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)) | Quartz display coordinate space definition |
| [Apple NSScreen documentation](https://developer.apple.com/documentation/appkit/nsscreen) | Cocoa screen coordinate API |
| [Apple AXUIElementCopyElementAtPosition](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition) | Confirmed: "Returns the accessibility object at the specified position in top-left relative screen coordinates" |
| [10.9 AppKit Release Notes — Spaces and Multiple Screens](https://developer.apple.com/library/archive/releasenotes/AppKit/RN-AppKitOlderNotes/index.html#10_9Spaces) | "Displays have separate Spaces" behavior, window spanning constraints, `screensHaveSeparateSpaces` API |
| [Smart Eye Pro — Eye Tracking in Multi-Screen Setups](https://smarteye.se/blog/eye-tracking-in-multi-screen-setups-best-practices-from-complex-research-labs/) | Practical challenges: geometry problem, calibration fragility, cross-screen gaze transitions, spatial planning |
| [Frontiers — Webcam-based gaze estimation for computer screen interaction](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full) | 3D gaze projection methodology, Structure from Motion for head movement compensation, calibration approaches |
| [arXiv — Appearance-based Gaze Estimation with Deep Learning: A Review and Benchmark](https://arxiv.org/html/2104.12668v2) | Comprehensive survey of gaze estimation methods, coordinate conversion between 2D/3D gaze, dataset benchmarks |
| [Tobii Help — Can I use multiple screens?](https://help.tobii.com/hc/en-us/articles/209529429-Can-I-use-multiple-screens) | Consumer eye trackers (Tobii 5) limited to single screen, max 27–30" |
| [Eyeware Beam — Multi-screen pointer](https://eyeware.beam.eyeware.tech/) | Commercial webcam-based multi-screen gaze pointer; proves concept viability |
| [Pupil Labs — real-time-screen-gaze](https://github.com/pupil-labs/real-time-screen-gaze) | Open-source real-time screen mapping via AprilTag display detection in scene camera |
| [Pupil Labs — gaze-controlled-cursor-demo](https://github.com/pupil-labs/gaze-controlled-cursor-demo) | End-to-end cursor control on top of real-time screen gaze |
| [Tobii Pro Spectrum specifications](https://connect.tobii.com/s/article/how-to-configure-an-advanced-display-setup) | Research-grade tracker specs: 0.30° accuracy, <2 ms latency, 1200 Hz, fine time synchronization |
| [ArXiv — L2CS-Net: Gaze Estimation (Abdelrahman et al., 2023)](https://arxiv.org/abs/2203.03339) | 3.92° on MPIIGaze; state-of-the-art unconstrained RGB gaze-direction estimation |
| [ArXiv — 3DGazeNet (O Oh et al., 2024)](https://arxiv.org/abs/2405.01974) | Reframes gaze estimation as dense 3D eye-mesh regression with strong cross-dataset generalization |
| [ArXiv — HiFiGaze (2026)](https://arxiv.org/html/2603.19588v1) | Screen-content-aware gaze estimation; ~8% tracking-error reduction over appearance-only baseline |

### Tier 2 — Expert

| Source | Contribution |
|---|---|
| [StackOverflow — Quartz vs Cocoa coordinate space](https://stackoverflow.com/questions/19884363/in-objective-c-os-x-is-the-global-display-coordinate-space-used-by-quartz-d/19887161#19887161) | Clear explanation of global display space (Quartz, top-left origin) vs Cocoa screen space (bottom-left origin), conversion formula |
| [StackOverflow — NSWindow spanning multiple screens](https://stackoverflow.com/questions/21562044/nswindow-spanning-multiple-screens-in-mavericks) | Confirms Mavericks clipping behavior, Displays have separate Spaces workaround, shows multi-window-per-display workaround |
| [Swindler #62 — NSScreen vs AXUIElement coordinate mismatch](https://github.com/tmandry/Swindler/issues/62) | Documented bug: NSScreen.screens reports Cocoa Y coords while AX returns Quartz Y coords; negative Y values on displays above primary |
| [axterminator #21 — Multiple monitor support](https://github.com/MikkoParkkola/axterminator/issues/21) | Comprehensive multi-monitor accessibility requirements: negative coordinates, global bounds, display identification, mixed Retina handling |
| [R0uter's Blog — Multi-monitor window position macOS](https://www.logcg.com/en/archives/2771.html) | Practical macOS coordinate handling for multi-monitor: origin offsets, screen detection via `frame.contains(point)`, fullscreen app gotchas |
| [Fraunhofer — Combining low cost eye trackers for dual monitor](https://publica.fraunhofer.de/bitstreams/ef6d591c-0f22-44e4-9fef-f7ebd1a0be3b/download) | Dual-monitor eye tracking using two separate eye tracking devices per monitor |
| [GazeProjector — Location-independent gaze interaction](https://www.collaborative-ai.org/publications/lander15_techrep.pdf) | Scene-camera-based calibration for multi-display, tracking spatial relationship between eye and environment; reports 2.47° across multiple displays |
| [Tri-Cam — Practical Eye Gaze Tracking via Camera Network (arXiv, 2024)](https://arxiv.org/html/2409.19554v1) | Three affordable RGB webcams achieving Tobii-comparable accuracy; splits problem into camera–eye and eye–screen geometry |
| [ICCV 2017 — Monocular Free-Head 3D Gaze Estimation](https://openaccess.thecvf.com/content_iccv_2017_workshops/w18/html/Cheng_Monocular_Free-Head_3D_ICCV_2017_paper.html) | Seminal paper: gaze as geometric composition of head pose and eyeball rotation (`g = R_head·R_eye·g_0`) |
| [Adaptive Homography for Gaze Estimation](https://www.researchgate.net/publication/261263762_Gaze_tracking_in_multi-display_environment) | Conditions homography mapping on head-pose variables for better robustness under movement |
| [UnitEye — Webcam Gaze Tracking](https://github.com/tmbdev/unitye) | Calibration, filtering, evaluation, AOIs, runtime GUI; heavy filtering; strong sensitivity to webcam position |
| [WebGazer.js — Self-calibrating gaze estimation](https://webgazer.cs.brown.edu/) | Practical self-calibration from clicks and cursor movement; demonstrates viability of online offset correction |
| [Microsoft — Virtual Screen Metrics](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetrics) | `SM_CXVIRTUALSCREEN`, `SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN` — the Windows virtual desktop bounding rectangle |
| [Microsoft — DPI and Device-Independent Pixels](https://learn.microsoft.com/en-us/windows/win32/learnwin32/dpi-and-device-independent-pixels) | Desktop coordinates depend on DPI-awareness; `GetDpiForMonitor` returns different values per mode |

### Tier 3 — Community

| Source | Contribution |
|---|---|
| [Tobii + triple monitors Reddit](https://www.reddit.com/r/starcitizen/comments/toihmy/tobii_and_triple_monitors/) | User reports: Tobii 5 works on dual ultrawide but accuracy degrades at edges |
| [ResearchGate — How to do eye tracking on multiple displays?](https://www.researchgate.net/post/How_to_do_eye_tracking_on_multiple_displays) | Responses recommend wearable (head-mounted) eye trackers for multi-display; screen-based trackers are inherently limited |
| [Cross-monitor bezel warping HCI research](https://dl.acm.org/) | Prior work finds pointer warping across bezels faster and often preferred in heterogeneous multi-monitor setups |
| [Human factors — preferred viewing distances and gaze angles for multi-display](https://journals.sagepub.com/) | Ergonomic data: ~60–100 cm preferred viewing distance, downward gaze angle preferred; bezel presence measurably affects performance |
| [Reddit — Tobii + triple monitors](https://www.reddit.com/r/starcitizen/comments/toihmy/tobii_and_triple_monitors/) | User reports: Tobii 5 works on dual ultrawide but accuracy degrades at edges |

---

## 17. Confidence Levels

| Claim | Confidence | Basis |
|---|---|---|
| macOS has distinct Quartz (top-left) and Cocoa (bottom-left) coordinate spaces | **High** | Multiple primary sources: Apple docs, StackOverflow explanations, third-party project bug reports |
| A single NSWindow cannot span displays with "Displays have separate Spaces" enabled | **High** | Apple 10.9 release notes explicitly document this |
| AXUIElementCopyElementAtPosition works correctly with global coordinates across all displays | **High** | Apple docs confirm "top-left relative screen coordinates"; axterminator confirmed via testing |
| EyeTrax's regression model only covers the primary screen's coordinate range | **High** | Source code analysis: calibration targets are generated within primary screen margins |
| Appearance-based gaze estimation degrades significantly at large head angles | **Medium-High** | ETH-XGaze benchmarks show error increase at extreme poses; SmartEye confirms cross-screen accuracy issues; but no published multi-monitor webcam gaze benchmarks exist |
| One NSWindow per display is the correct overlay architecture | **High** | Apple's Spaces architecture + the spanning limitation make this the only reliable approach |
| Multi-screen calibration will reduce per-screen accuracy compared to single-screen calibration | **Medium** | Logical inference from larger coordinate range + larger angular range; no direct benchmarks available |
| Head pose (yaw) can be used as a screen selector | **Medium** | Theoretically sound, but precision depends on seating distance and individual variation; no published accuracy numbers |

---

*End of report. This is an exploration document — no implementation decisions have been made. The next step would be to discuss which approach to pursue and at what level of accuracy/complexity tradeoff.*
