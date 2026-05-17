# AGENTS.md — Documentation Rules for This Project

> **For all coding agents working on this project.**  Follow these rules
> when implementing features, fixing bugs, or refactoring code.

## Rule 1: Always Update the Docs

For **every implementation, feature, bug fix, or refactor**, update the
corresponding documentation before marking the task complete.

### Checklist

- [ ] **[README.md](../README.md)** — if the change affects how the
  project is run, configured, or understood at a high level
- [ ] **[docs/gaze-tracker.md](gaze-tracker.md)** — if the change affects
  `gaze_tracker.py` (API, behaviour, threading, overlay, coordinate
  handling)
- [ ] **[docs/ui-detection.md](ui-detection.md)** — if the change affects
  `ui_detector.py` (API, performance, attributes, coordinate conventions,
  edge cases)
- [ ] **[docs/architecture.md](architecture.md)** — if the change
  introduces a new architectural decision, dependency, or performance
  characteristic worth documenting for future reference
- [ ] **[requirements.txt](../requirements.txt)** — if the change adds
  or removes a Python dependency

## Rule 2: New Module = New Doc

When adding a **new Python module** (`.py` file) to the project:

1. Create a corresponding `docs/<module-name>.md` file
2. Document: purpose, public API, coordinate system (if relevant),
   performance characteristics, edge cases, dependencies, and
   relationship to other modules
3. Add a link to the new doc in the **Architecture** table in
   `README.md`
4. Update the module dependency section of the existing module docs if
   the new module interacts with them

## Rule 3: Module Isolation

The two core modules **must remain isolated** from each other:

* `gaze_tracker.py` must NOT import `ui_detector` or `computer_control`
* `ui_detector.py` must NOT import `gaze_tracker` or `computer_control`
* `computer_control.py` is the ONLY file that imports both modules

Verify this after any change:
```bash
grep -l 'ui_detector' gaze_tracker.py;  # should fail (no matches)
grep -l 'gaze_tracker' ui_detector.py;  # should fail (no matches)
```

## Rule 4: Coordinate System Documentation

Any variable, parameter, or return value representing a screen position
**must** be documented with its coordinate system.  Use these terms:

| Term | Origin | Y direction |
|---|---|---|
| **top-left screen** | Top-left corner | ↓ down |
| **Cocoa / NSView** | Bottom-left corner | ↑ up |

Never use ambiguous terms like "screen coordinates" or "window
coordinates" without specifying the origin.

## Rule 5: Doc Format for Coding Agents

All `docs/*.md` files should follow this structure:

1. `> **For coding agents**: …` — one-line summary of what to know
2. **Overview** — what the module does, in 2-3 sentences
3. **Quick Reference** — minimal import + usage example
4. **Public API** — every public class, method, and function with
   parameter tables and return types
5. **Coordinate System** — if relevant, specify the convention
6. **Performance Benchmarks** — measured latencies for key operations
7. **Internal Architecture** — diagrams, call chains, data flow
8. **Edge Cases** — known gotchas, error handling, platform quirks
9. **Dependencies** — what the module imports
10. **Related Docs** — cross-references to other docs

The goal: a new coding agent with zero context should be able to read
the module doc and immediately understand how to modify the module
correctly.

## Project Structure

```
computer-control/
├── AGENTS.md              ← this file
├── README.md              ← project-level overview + quick start
├── requirements.txt       ← pip dependencies
├── computer_control.py    ← orchestrator (entry point)
├── gaze_tracker.py        ← eye tracking engine
├── ui_detector.py         ← UI element detection
├── face_landmarker.task   ← MediaPipe face model
├── gaze_model.pkl         ← saved calibration model
└── docs/
    ├── architecture.md    ← original research + design decisions
    ├── gaze-tracker.md    ← gaze_tracker module docs
    └── ui-detection.md    ← ui_detector module docs
```
