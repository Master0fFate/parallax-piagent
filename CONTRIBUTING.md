# Contributing

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- Pi coding agent 0.80.10 or newer for interactive validation

```bash
npm ci
npm run check
pi -e ./extensions/parallax/index.ts
```

## Change discipline

1. Keep changes focused and preserve unrelated behavior.
2. Add or update tests for every behavioral change.
3. Treat project trust, mutation gates, verification evidence, cancellation, and durable state as correctness boundaries.
4. Never let generic delegates mutate project files; worker mutation belongs behind Horizon advancement.
5. Update `README.md`, `DESIGN.md`, and `CHANGELOG.md` when public behavior changes.

## Pull requests

- Use a short imperative title.
- Explain the state owner, affected lifecycle events, failure behavior, and verification performed.
- Run `npm run check`, `npm audit --omit=dev`, and `npm pack --dry-run`.
- Keep generated `.parallax/`, coverage, package archives, and secrets out of commits.

## Commit style

Use concise conventional prefixes where practical:

- `feat:` new behavior
- `fix:` defect correction
- `refactor:` behavior-preserving structural change
- `test:` test-only change
- `docs:` documentation-only change
- `chore:` maintenance

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).
