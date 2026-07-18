---
name: parallax-core
description: Evidence-first coding protocol for ambiguous, multi-file, high-risk, or quality-sensitive engineering. Use when state ownership, blast radius, timing, verification, or recovery materially affects correctness.
license: MIT
---

# Parallax Core

Use the `parallax` tool to record protocol progress. Do not perform check-ins as ceremony; investigate first and attach concrete evidence.

1. **Ambiguity:** Rate LOW, MEDIUM, or HIGH. Ask only questions whose answers materially change implementation. Record assumptions when safe defaults exist.
2. **Invariants:** Identify the exact state owner and truth source; feedback/error surface; deletion/import blast radius; and timing, ordering, cancellation, or race constraints.
3. **Gate:** Define observable acceptance checks, existing pattern evidence, security boundaries, and rollback or recovery.
4. **Execute:** Make the smallest coherent change. Parallax batches sibling file mutations and verifies once at turn end.
5. **Commit:** Choose full solution, pragmatic partial with explicit deferrals, or hold due to a named blocker.
6. **Summary:** State what changed, evidence from checks, edge cases covered, and remaining risk.

For trivial work, keep each step short. For complex plans, switch to PLAN mode and use `parallax_hyperplan`; for post-build review, switch to DEBUG mode.
