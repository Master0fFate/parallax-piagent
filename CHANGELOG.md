# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases will follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Mutation-triggered automatic supervision that blocks the first attempted mutation, remains dormant for read-only prompts, and deactivates after the agent run settles.
- `autoActivateOnMutation` configuration plus `/parallax auto` and session-level `/parallax off` controls.
- Pi-native Parallax supervisor with evidence-backed mutation gates.
- Batched verification with corrective feedback and branch-aware traces.
- Isolated read-only delegation and adaptive Hyperplan review.
- Durable Horizon planning, worker execution, verification, review, retries, and resume.
- Project-trust enforcement, CLI trace analytics, and CI validation.

### Fixed

- Parallax no longer injects protocol instructions, exposes supervisor tools, gates mutations, or auto-verifies ordinary prompts at session startup. Explicit controls and mutation-triggered task-scoped activation replace always-on supervision.
