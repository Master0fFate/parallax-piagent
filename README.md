# Parallax for Pi

[![CI](https://github.com/Master0fFate/parallax-piagent/actions/workflows/ci.yml/badge.svg)](https://github.com/Master0fFate/parallax-piagent/actions/workflows/ci.yml)
[![Node.js ≥22](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Pi-native engineering supervisor with protocol gates, adaptive planning, batched verification, branch-aware traces, isolated delegation, and durable Horizon execution.

## Install

Parallax is a **Pi package**: an npm or Git package whose `pi` manifest tells Pi which extensions, skills, and prompts to load. `pi install` downloads/registers that package in Pi's settings; it is not the same as `npm install -g`, which only makes a Node CLI available and does not activate a Pi extension.

### 1. Install and authenticate Pi

Parallax requires Node.js 22 or later and Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
pi
```

In Pi, run `/login` and choose a provider, or configure that provider's API key as Pi documents. Confirm the provider has an available model with `/model`; Horizon delegates can only use authenticated models from the active model's provider.

### 2. Install Parallax

Install from Git (available now) into your user-level Pi configuration:

```bash
pi install git:github.com/Master0fFate/parallax-piagent
pi list
```

Restart Pi in the project you want to work on. Its startup header should list the Parallax extension, skills, and prompts. To install only for the current project and share the package reference through `.pi/settings.json`, use `-l`:

```bash
pi install -l git:github.com/Master0fFate/parallax-piagent
```

After an npm release is published, the equivalent install is `pi install npm:parallax-piagent@<version>`. Pin a Git tag or commit for reproducibility, for example `pi install git:github.com/Master0fFate/parallax-piagent@v0.2.0`; use `pi update --extensions` for unpinned packages, reinstall with `pi install git:github.com/Master0fFate/parallax-piagent@<new-ref>` to move a pinned Git ref, and `pi remove <source>` to uninstall.

### Local development

```bash
git clone https://github.com/Master0fFate/parallax-piagent.git
cd parallax-piagent
npm install
npm run check
pi install .
```

For a one-run extension test without registering the package, use `pi -e ./extensions/parallax/index.ts`.

Pi packages execute with your user permissions. Review extension source before installation, and trust a project only when you trust its project-local configuration and agent definitions.

Project documentation: [design](DESIGN.md) · [contributing](CONTRIBUTING.md) · [security](SECURITY.md) · [changelog](CHANGELOG.md)

## Design

- One session-scoped state model restored from Pi's branch-aware custom entries.
- One verification pass after all sibling mutations in a turn.
- Seven cohesive custom tools total, inactive while dormant; an explicit mode or an attempted mutation can activate supervision.
- Isolated in-process Pi SDK delegates with recursive extension loading disabled.
- Project-local Horizon state with safe IDs, serialized operations, and atomic writes.
- Recovery mode permits one corrective mutation per turn until checks pass.
- Concise runtime status plus on-demand skills instead of oversized recurring prompts.
- Package-script-aware Node checks plus Rust, Go, Python, and .NET detection.

## Commands

```text
/parallax                 Show status
/parallax <request>       Launch a Parallax-supervised implementation turn
/parallax health          Inspect runtime health
/parallax plan            Read-only planning mode
/parallax build           Implementation mode
/parallax debug           Audit/fix mode
/parallax horizon         Durable long-running execution mode
/horizon <goal>           Launch the Horizon autonomous supervisor
/horizon                  Resume the latest runnable Horizon session
/parallax verify          Run the full detected verification set
/parallax reset           Reset protocol and friction state
/parallax auto            Arm automatic mutation-triggered supervision
/parallax off             Disable supervision and auto-activation for this session
```

Mode shortcuts: `Ctrl+Alt+P` plan, `Ctrl+Alt+B` build, `Ctrl+Alt+D` debug, and `Ctrl+Alt+H` Horizon. Packaged prompt entrypoints are `/parallax-plan`, `/parallax-debug`, and `/parallax-horizon`.

## Core tool

The `parallax` tool consolidates protocol and trace operations:

- `status` / `health`
- `checkin` (`ambiguity`, `invariants`, `gate`, `design`, `commit`, `summary`)
- `mode` (`plan`, `build`, `debug`, `horizon`)
- `analyze`
- `verify` (`fast` or `full`)
- `trace` (`view`, `json`, or `pr`)
- `reset`

Parallax is dormant for ordinary prompts: they receive no Parallax instructions, expose no Parallax tools, and trigger no verification. By default it is safely armed: if the model attempts `write`, `edit`, or a potentially mutating shell command, Parallax blocks that first mutation, resets the task gates, activates BUILD supervision for the current agent run, and deactivates again only after Pi reports the run fully settled. Read-only tools do not activate it, so simple Q&A remains dormant unless the model unexpectedly attempts a mutation. Pi does not expose a built-in semantic “coding task” classifier, so activation uses observable mutation intent rather than fragile prompt keyword guessing.

Explicit `/parallax build|plan|debug|horizon`, `/parallax <request>`, `/horizon`, and mode shortcuts remain active until `/parallax off`. Use `/parallax auto` to re-arm dormant automatic activation; `/parallax off` disables both manual supervision and automatic activation for the rest of the session. Once active, default `standard` strictness requires evidence-backed ambiguity and invariants before `write` or `edit`. `strict` also requires the verification gate; `relaxed` requires only ambiguity. Unknown or mutating shell commands are conservatively treated as strict mutations so they cannot bypass protocol gates. Commit and summary check-ins remain blocked until verification passes.

## Configuration

Create `.parallax/config.json`:

```json
{
  "strictness": "standard",
  "adaptiveProtocol": true,
  "autoActivateOnMutation": true,
  "autoVerify": true,
  "designDocRequired": false,
  "minScore": 70,
  "maxRetries": 3,
  "verificationTimeoutMs": 120000,
  "trivialPatterns": ["*.md", "*.txt"],
  "highRiskPatterns": ["**/auth/**", "**/*.env*", "**/migrations/**"],
  "verifyCommand": "npm run check"
}
```

Project configuration is read only when Pi considers the project trusted. Project-defined verification commands and Horizon execution are also disabled before trust. Set `autoActivateOnMutation` to `false` for strictly manual, callable-only behavior. With adaptive protocol enabled, trivial paths use relaxed gates and high-risk paths always use strict gates.

## Verification behavior

When supervision is active, Parallax collects successful `write` and `edit` results plus shell mutations during a model turn, then runs one fast check at `turn_end`. The result is injected into the next model turn so failures are corrected before completion. Automatic supervision waits for `agent_settled`, so queued verification feedback and retries finish before its tools and prompt surface are removed. Manual `/parallax verify` runs the full detected set and activates supervision. A project `check` script is treated as canonical; otherwise Parallax discovers `typecheck`, `test`, and `lint` scripts in that order. Rust, Go, Python, and .NET checks are also detected, while any other toolchain can use `verifyCommand` in `.parallax/config.json`.

Verification runs through Pi's cross-platform local shell backend rather than hard-coded `cmd`, npm, or POSIX process launching. A completed exit code of `0` passes; a nonzero or killed/null exit, timeout, or startup error fails; user cancellation is propagated rather than mislabeled. Output text alone never overrides the process result, so custom checkers must return a nonzero exit code when they report failure. One deadline covers the full verification run, and large output is truncated in context and preserved under `.parallax/verification/`.

After consecutive failures exhaust the configured retries, Parallax enters recovery mode. It permits one corrective mutation per turn instead of blocking the operation needed to repair the build.

## Delegation

`parallax_delegate` activates in PLAN, DEBUG, and HORIZON modes after project trust. It runs isolated agents through Pi's typed SDK in the same process rather than spawning nested CLI processes. Each delegate receives an in-memory session, an explicit tool allowlist, project context files, and no extensions, skills, prompts, or themes. This prevents recursive Parallax loading while preserving cancellation, provider auth, token accounting, and streaming updates.

Built-in roles are `scout`, `planner`, `reviewer`, `worker`, and `critic`. Every delegate model is selected from the authenticated catalog of the active model's provider: low-risk `scout` and `critic` work use the least-cost text model with sufficient context, while planning, review, and implementation retain the active model unless their agent definition names an exact authenticated model from that same provider. This prevents cross-provider routing and avoids spending a premium model on reconnaissance by default. To override a role deliberately, set its Markdown frontmatter to `model: <exact-model-id>`; a missing, cross-provider, or unauthenticated model is rejected rather than silently routed elsewhere. Single, parallel, and `{previous}` chain workflows are supported. Generic delegation is read-only: agents with `write`, `edit`, or `bash` tools are rejected so they cannot bypass parent verification. The worker is enabled only inside `parallax_horizon_advance`, which owns the strict gate and full verification cycle. Trusted `.pi/agents/*.md` definitions can override built-ins when `scope` is `project` or `all`.

## Hyperplan

`parallax_hyperplan` activates in PLAN or HORIZON mode. `mode: "run"` performs adaptive parallel critique and synthesis in one tool call. It skips trivial plans, uses two critical reviewers for moderate plans, and five orthogonal reviewers for complex plans. `depth: "focused"` is the efficient default; `depth: "debate"` runs analysis, cross-attack, and defense. Generate/synthesize actions remain available for manual control.

## Horizon

Launch Horizon directly with `/horizon <goal>`. It is an orchestrator: it researches, plans, delegates execution to an isolated worker, verifies, reviews, self-corrects, and proceeds through durable feature checkpoints without asking whether to continue. Horizon requires Pi project trust because it loads project-local plans and executes implementation workers.

Horizon uses four cohesive surfaces:

- `parallax_horizon_session`: initialize, list, status, runtime configuration
- `parallax_horizon_plan`: plans, execution state, feature/milestone updates, evaluation
- `parallax_horizon_memory`: decisions, research, session skills, archived traces
- `parallax_horizon_advance`: execute one restart-safe feature checkpoint through worker → verification → reviewer → score

The active Pi session ID is the default Horizon ID, so callers do not repeat it on every operation. Session-created skills are injected only while that Horizon session is active. A new Pi session in Horizon mode discovers the latest resumable project session. Full autonomy automatically schedules the next agent turn between checkpoints until the durable plan is terminal or externally blocked; semi autonomy pauses at milestone boundaries; supervised autonomy pauses after each feature. One-feature advancement preserves cancellation and recovery boundaries instead of hiding a multi-hour process inside one uninterruptible tool call.

## CLI

The package exposes `parallax-pi`:

```bash
parallax-pi init
parallax-pi trace list
parallax-pi trace score <id>
parallax-pi trace trend
parallax-pi trace report
parallax-pi trace compare <a> <b>
parallax-pi trace compliance <id>
parallax-pi gate --min-score 70
parallax-pi pre-commit
```


## State and artifacts

```text
.pi session JSONL          Branch-aware Parallax state snapshots
.parallax/
  config.json              Optional trusted project configuration
  traces/<session>.json    Exported protocol and verification trace
  verification/*.log       Full output only when context output was truncated
  horizon/
    config.json
    index.json
    sessions/<id>/
      plan.json
      state.json
      decisions.jsonl
      research/
      skills/
      traces/
```

## Harness design

The project follows Pi 0.80.10's extension, package, SDK, session, compaction, TUI, trust, prompt-template, and keybinding contracts. Explicit modes keep the primary harness minimal. Worker isolation uses Pi SDK sessions rather than a second custom agent runtime. Project-local code and agents are honored only through Pi's trust boundary.

## License

MIT
