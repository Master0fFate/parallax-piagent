# Design Notes

## Objective

Preserve Parallax's useful guarantees while fitting Pi's extension, session, trust, and package model directly.

## State ownership

- The extension closure owns live state for the active Pi session.
- Pi custom entries (`parallax-pi-state`) are the durable, branch-aware source of truth; trace history is persisted as deltas to avoid quadratic session growth.
- Project files contain exported traces and Horizon workflow artifacts, not a duplicate live protocol state.

## Feedback

- Footer status shows mode, protocol progress, and latest verification verdict.
- Tool results and notifications expose gate blocks and verification failures.
- Full oversized verification output is saved to `.parallax/verification/`.

## Timing

- Tool preflight enforces gates before built-in file and shell mutations.
- Successful file mutations and potentially partial shell mutations accumulate during the turn.
- `turn_end` runs one serialized verification pass for the batch and steers its evidence into the next model turn.
- Core actions, Horizon writes, and verification runs each use a queue to avoid concurrent state corruption.
- Generic delegates are read-only; the mutating worker is available only behind Horizon's strict gate and verification cycle.
- Delegates use isolated in-memory Pi sessions and share only explicit task/output boundaries.
- Horizon advances one feature per call so cancellation, retry, and resume always have a durable checkpoint.

## Boundaries

- `src/state.ts`: pure protocol/friction transitions and scoring.
- `src/verify.ts`: project detection and command execution.
- `src/horizon.ts`: contained durable project storage and validated runtime configuration.
- `src/delegate.ts`: in-process Pi SDK delegation with recursive extension loading disabled.
- `src/hyperplan.ts` / `src/hyperplan-runner.ts`: adaptive critique, automated debate, and de-duplicated synthesis.
- `src/trace-analytics.mjs`: shared scoring used by the extension and zero-build CLI.
- `bin/parallax-pi.mjs`: CI gates and trace analytics.
- `extensions/parallax/index.ts`: Pi event, UI, mode, and tool wiring.

## Trust boundary

- Project configuration, project-defined checks, Horizon plans, session skills, and workers are used only after Pi marks the project trusted.
- Delegated sessions disable extensions, skills, prompts, and themes to prevent recursive supervisors and unreviewed project instructions.

## Non-goals

- Reimplementing Pi's agent loop or spawning recursive Pi CLI processes.
- Running redundant checks after every sibling edit.
- Injecting entire auditor/planner manuals into every model request.
