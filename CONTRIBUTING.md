# Contributing to RetroFlare

Thanks for helping teams run better retrospectives. Bug reports, thoughtful feature requests, documentation improvements, accessibility fixes, and code contributions all help.

## Before you start

- Search [existing issues](https://github.com/cquark7/RetroFlare/issues) before opening a new one. Use the issue forms for bugs and feature ideas; a regular issue is fine for setup questions.
- For a substantial feature, new dependency, or protocol/storage/authentication change, discuss the approach in an issue before implementing it. Small fixes and documentation improvements can go straight to a pull request.
- Report vulnerabilities privately using the process in [SECURITY.md](SECURITY.md), not a public issue.
- Be kind, specific, and constructive. Do not post private team data, credentials, or other people's personal information.

## Local setup

Fork the repository on GitHub, then clone your fork. Requires **Node.js 22.12+** and npm.

```sh
git clone https://github.com/YOUR-USERNAME/RetroFlare.git
cd RetroFlare
npm ci --cache .cache/npm
npm run dev
```

Open <http://localhost:5173>. No Cloudflare account or production credentials are needed. The **Demo as** selector switches local identities; use separate browser sessions (such as a normal and private window) to try multi-user collaboration. GIF search is optional; see the [README](README.md#run-locally) for configuration.

Keep caches and temporary work in `.cache/` and `.tmp/`. Do not commit `.env.local`, completed deployment settings, local Worker state, browser profiles, or exported backups. Do not clear `.wrangler/state` or restart another contributor's running server without asking.

## Find the right code

| Area | Location |
| --- | --- |
| React screens, controls, and styles | `src/client/` |
| Draft recovery, autosave, and socket coordination | `src/client/sync/` |
| Domain types, validation schemas, and wire contracts | `src/shared/` |
| Request routing and authentication | `worker/index.ts`, `worker/auth/` |
| Durable Object and WebSocket runtime | `worker/TeamRetro.ts` |
| Authorized mutations and persistence | `worker/commands.ts`, `worker/storage.ts` |
| Unit, contract, and runtime tests | `tests/*.test.ts` |
| Browser flows and test helpers | `tests/e2e/` |

The client uses React and Vite; the backend uses Cloudflare Workers and a SQLite-backed Durable Object. Shared Zod schemas are the source of truth for data and protocol contracts. See [AGENTS.md](AGENTS.md) for the full engineering agreements; they apply whether or not you use a coding agent.

## Keep changes focused

- Follow the surrounding code's style and reuse existing dependencies and patterns.
- Fix behavior at its owning layer and add regression coverage for meaningful failure paths.
- Preserve verified server-side identity, draft recovery, command idempotency, and existing backup/storage compatibility. Do not bypass validation or product limits to make a test pass.
- Do not mix unrelated cleanup into a fix. Explain migrations, security implications, or intentional behavior changes in the pull request.
- Documentation is a good starting point: improve an unclear setup step, reproduce an issue, or add a missing troubleshooting explanation. You do not need a large feature to contribute.

## Verify your change

For application code, run:

```sh
npm run typecheck
npm run lint
npm run test
npm run build
```

For UI or client/server integration changes, also install Chromium into the workspace and run the browser suite:

```sh
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npx playwright install chromium
npm run test:e2e
```

On Linux, Playwright may also require system libraries; follow its installation error's guidance for your environment. The E2E suite owns a separate server on strict port **5174**, uses nonpersistent storage and fresh browser contexts, and leaves the manual server on **5173** alone. If 5174 is busy, free it only if it is your process; do not kill someone else's server or fall back to 5173.

Start with the affected scenario while iterating, then run the required suites. See [browser test notes](tests/e2e/README.md) for coverage, rate-limit boundaries, and the separate opt-in performance smoke.

For documentation-only changes, check links, command accuracy, and `git diff --check`; application suites are not needed unless behavior also changed.

## Open a pull request

1. Create a descriptive branch in your fork and keep the change focused.
2. Use a clear commit title such as `fix(sync): preserve offline drafts` or `docs: clarify local setup`.
3. Explain the problem, approach, and related issue. Include before/after screenshots for visual changes, using fictional data.
4. List the checks you ran and anything you could not verify. Never claim an unrun test passed.

Contributions are made under the project's [MIT License](LICENSE). Bundled third-party assets retain their own licenses and attribution requirements; include provenance for any new assets.
