---
name: parallax-plan
description: Create grounded, execution-ready engineering plans without mutating files. Use for migrations, architecture changes, multi-file features, unclear requirements, or when the user asks to plan before implementation.
license: MIT
---

# Parallax Plan

Switch with `/parallax plan`. PLAN mode blocks `write`, `edit`, and unrecognized or mutating shell commands.

1. Inspect repository structure, instructions, configuration, callers, tests, and existing patterns.
2. Resolve only blocking ambiguity; state consequential assumptions.
3. Map state ownership, interfaces, dependencies, error paths, timing, security, and rollback.
4. Compare materially different approaches and recommend one default.
5. Use `parallax_hyperplan` only when complexity or risk justifies adversarial review; trivial plans should skip it.
6. Produce ordered tasks with dependencies and binary acceptance checks.
7. Remove duplicate tasks, speculative abstractions, and generic best-practice filler.

Switch to `/parallax build` only when the plan is executable without guessing.
