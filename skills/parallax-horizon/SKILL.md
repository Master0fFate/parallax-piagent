---
name: parallax-horizon
description: Execute substantial multi-stage work through durable project-local plans, research, decisions, checkpoints, retries, and final audit. Use for long-running tasks that must survive compaction or session resume.
license: MIT
---

# Parallax Horizon

Launch with `/horizon <goal>` or switch with `/parallax horizon` and initialize `parallax_horizon_session`. Data lives under `.parallax/horizon/` in the current project.

1. **Research:** Inspect the real system and save only decision-relevant findings and sources.
2. **Plan:** Write milestones and atomic features with acceptance criteria. Keep one active feature at a time.
3. **Execute:** Call `parallax_horizon_advance` repeatedly. Each checkpoint delegates one feature, runs real project checks, reviews the actual result, scores it, and completes or retries it.
4. **Decide:** Resolve ordinary ambiguity from evidence and project conventions; log the decision. Pause only for a genuinely external blocker such as missing credentials or access.
5. **Recover:** Respect feature retry caps. After exhaustion, mark failure, record evidence, and continue only when downstream work remains valid.
6. **Audit:** Run a full Parallax verification and DEBUG pass, close milestones, and report completed, failed, and residual work.

In full autonomy, never ask whether to continue and never stop between runnable features. Semi autonomy pauses at milestone boundaries. Supervised autonomy pauses after each feature. Any mode may pause for exhausted retries or a genuinely external blocker.

Session skills are injected only for the active Horizon session, avoiding global skill collisions and prompt duplication.
