# Contributing to pidea

## Run from source

You need Node.js 22.19 or newer and pi 1.0.0 or newer.

```bash
npm install
npm run build
node dist/index.js setup    # point IntelliJ at this checkout
```

After you rebuild, open a new chat: IntelliJ reuses running agent processes, and Node keeps the old files loaded.

## Commands

```bash
npm run dev          # run from src with tsx
npm run build
npm run lint
npm run test         # unit, component, and end-to-end tests
npm run typecheck
npm run format
npm run check:pack   # pack, install with scripts/install.sh into a clean prefix, check the installed adapter starts
npm run smoke        # core stdio smoke tests against your real pi and model
npm run smoke:full   # full matrix; run this before a release
node scripts/check.mjs
```

To see what a client actually sends, set `PIDEA_DEBUG_ACP=1` and read `~/.pi/pidea/acp-debug.log`.

## Code layout

- `src/acp/` holds the ACP server and translation.
- `src/pi-rpc/` holds the pi subprocess wrapper.
- `src/pi-extension/` holds the pi extensions pidea loads into each session: the IDE bridge, tool approval, editor file access, and client hints.
- `src/setup.ts`, `src/update.ts` and `src/update-check.ts` implement `pidea setup`, `pidea update` and the update notice.

## Tests

- `test/e2e/` runs the real adapter against the real pi binary from `node_modules`, with a scripted model (pi-ai's faux provider, loaded by `test/e2e/fixtures/scripted-model.ts`). Scenarios script text, thinking, tool calls, stop reasons, and errors; no network or API keys. Start a fix with a failing scenario here.
- `test/component/` and `test/unit/` cover edge cases with a fake pi process. Its events are type-checked against pi's exported event types, so a renamed pi event fails `npm run typecheck`.
- `npm test` loads `test/setup.ts`, which turns off the update check so tests make no network calls.
- `npm run smoke:full` uses your own pi providers and is for release checks.

## CI

- `check.yml` runs the repository check, tests, lint, typecheck, build, and the packaging check on Linux (Node 22 and 24) and Windows (Node 24).
- `release.yml` runs on `v*` tags: the end-to-end tests against pi 1.0.0 and the latest pi, the same checks, a check that the tag matches the package version, and then it publishes a GitHub Release with the `npm pack` tarball, once as `pidea-<version>.tgz` and once as `pidea.tgz`, plus `scripts/install.sh` as `install.sh`. The fixed names keep the `releases/latest/download/` links in the README and the installer working.

## Releasing

1. Set `version` in `package.json` and run `npm install --package-lock-only`.
2. Run `npm run smoke:full` locally (it needs your pi providers, which CI does not have).
3. Commit, then tag and push: `git tag v<version>` and `git push origin main v<version>`.
