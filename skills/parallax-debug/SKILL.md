---
name: parallax-debug
description: Run an evidence-based post-build review for correctness, regressions, security, performance, and maintainability. Use after implementation or when asked to debug, audit, harden, or verify production readiness.
license: MIT
---

# Parallax Debug

Switch with `/parallax debug`.

1. Reproduce defects or identify a concrete failing invariant before editing.
2. Rank findings by material impact: critical, major, minor.
3. Trace each finding to a file, contract, runtime path, test, log, or measured behavior.
4. Fix root causes with the smallest change that preserves known-good behavior.
5. Test normal, boundary, malformed, interruption, and recovery paths that are material to the change.
6. Run `parallax` verification with `verificationScope: "full"` before closing.
7. Report actual checks and unresolved limitations; never substitute a score or confident prose for evidence.
