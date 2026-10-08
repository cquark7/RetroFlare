# Working on RetroFlare

RetroFlare is a collaborative retrospective app: a React/Vite client and a
Cloudflare Worker with a SQLite-backed, hibernatable Durable Object. This file
contains shared engineering decisions, not session history. Paths are relative
to the repository root; no personal tools or external agent configuration are
required.

## Start with the smallest useful context

1. Read the user request and inspect `git status` and the relevant diff. Existing
   changes may belong to someone else; preserve them and clarify ambiguous scope.
2. Use the map below to locate the owning layer. Read its contracts, caller, and
   nearest tests before expanding the search. Avoid loading the entire repository.
3. For non-trivial work, propose a short plan with the intended behavior and
   verification, and obtain approval before implementation. Small fixes and
   focused test additions may proceed directly. An approved plan need not be
   re-approved unless its scope changes.
4. Ask before adding dependencies, changing API/schema contracts, architecture,
   authentication/trust boundaries, or expanding the assigned scope. Identify
   trade-offs and challenge changes that weaken guarantees.
5. Reproduce a reported failure, make the smallest coherent correction, and run
   targeted checks before the completion gates below.

## Find the owning layer

| Concern | Start here |
| --- | --- |
| Domain, limits, wire/API/backup schemas, event reduction | `src/shared/` |
| Routes, navigation, identity, board/home controls | `src/client/App.tsx`, `BoardScreen.tsx`, `HomeScreen.tsx` |
| Draft scheduling, local recovery, conflicts, lifecycle coordination | `src/client/sync/board.ts`, `autosave.ts`, `drafts.ts` |
| Connection readiness, reconnects, batching | `src/client/sync/socket.ts` |
| Worker routing, assets, request/auth boundaries | `worker/index.ts`, `http.ts`, `auth/` |
| Socket attachments, fan-out, alarms, object runtime | `worker/TeamRetro.ts`, `socket-types.ts` |
| Authorized mutations, transactions, idempotency | `worker/commands.ts` |
| Persistence/migration, backup/import | `worker/storage.ts`, `backups.ts` |
| Music and GIF experiences | `src/client/FocusMusicPlayer.tsx`, `music/`, `GiphyExperience.tsx`, `GiphyOverlay.tsx` |
| Runtime/contract/auth tests | `tests/*.test.ts`, `vitest.config.ts` |
| Browser flows and shared helpers | `tests/e2e/README.md`, `fixtures.ts`, `*.spec.ts`, `playwright.config.ts` |
| Environment selection/deployment | `vite.config.ts`, `wrangler*.jsonc`, `scripts/deploy-example.sh`, `README.md` |

Current source and tests are the source of truth. Check `package.json` for actual
commands/versions and current upstream documentation for library-specific APIs.

## Preserve these guarantees

- Shared Zod schemas and inferred types are the protocol/domain source of truth.
  Validate boundaries; do not duplicate contracts or bypass them with type casts.
- Browser commands never carry the acting actor ID, role, or administrator claim.
  Server authority comes from the authenticated principal, including on sockets.
- Production authentication uses verified Cloudflare Access assertions and
  fails closed when its configuration is absent or invalid. Local identity is
  restricted to the Vite `serve` guard and local/E2E Wrangler configuration;
  headers, query values, or `DEV_AUTH` alone must never enable it in production.
- Use `crypto.randomUUID()` for opaque UUIDs. Keep board revisions, card versions,
  command idempotency, limits, event deltas, closing generations, and audit fields
  consistent across contracts, server behavior, and client reduction.
- Finish captures connected client IDs and gathers their saved drafts before
  finalization. Preserve offline drafts and explicit conflict choices; do not
  hide lifecycle failures with forced completion or silent overwrites.
- Persisted board history and ephemeral collaboration are separate. Presence
  and GIPHY shares must not mutate saved revisions/history. Music playback and
  preferences are local and opt-in; leaving/completing a board stops playback.
- Side effects must survive React StrictMode setup/cleanup probes. Avoid starting
  abandoned WebSocket upgrades; dispose controllers, subscriptions, and timers.
- Preserve the `TeamRetro` SQLite class, `team-v1` object name, asset routing, and
  append-only migration history. Treat storage/backup compatibility explicitly.

## Protect the developer's environment

- Keep caches, temporary work, runtime state, and Playwright browsers in this
  workspace: `.cache/`, `.tmp/`, `.wrangler/`. Use `.cache/npm` for npm cache when
  installing dependencies. Do not create nested repositories or track generated
  build/test artifacts, credentials, `.env.local`, or completed deployment vars.
- The manual server at `http://localhost:5173`, its browser profile/cookies, and
  `.wrangler/state` are user-owned. Do not stop/restart it, attach automation to
  its profile, clear cookies, or reset/move its state without explicit permission.
  Restarting the server invalidates process-local demo sessions.
- Browser tests use strict port 5174, `wrangler.e2e.jsonc`, disabled persistence,
  and fresh contexts. `npm run test:e2e` owns its server startup/cleanup. If 5174
  is occupied, report the conflict; never kill another process or fall back to 5173.

## Verify behavior efficiently

- After code changes run `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm run test`. For browser-visible or client/server integration changes also
  run `npm run test:e2e`. Documentation-only edits need path/content and diff checks.
- Start browser debugging with the affected file or `--grep` scenario. Use
  retained failure traces/screenshots before rerunning. Broaden once the focused
  fix passes; repeat only for changed behavior or unresolved reliability concerns.
- Keep E2E scenarios independent with fresh boards and test-scoped cleanup.
  Authenticate as setup, then perform product mutations through actual controls.
  Assert peer-visible behavior and reload/persistence where relevant. Use API
  reads to prove durability/idempotency, not to substitute for the user flow.
- Use retrying assertions and bounded waits for observable states. Avoid fixed
  sleeps, forced clicks, application-clock mocks, or weakening assertions to
  conceal failures. Stub external services deterministically, but exercise real
  app transport and local media playback. Inject only the intended socket fault.
- Respect real creation limits in `src/shared/constants.ts`. Distribute creator
  identities and repeat full suites in separate fresh server invocations;
  `--repeat-each` can exhaust the deployment budget. Do not disable product limits.
- The 15-client performance smoke is opt-in and runs separately; its exact
  command and measurement boundaries are in `tests/e2e/README.md`. Run it when
  changing fan-out, batching, rendering performance, or measured latency.
- Add tests for meaningful regression boundaries, not implementation mirrors.
  A failing real flow may be an application bug; establish the cause before
  changing the test's expectations.

## Keep handoffs and changes focused

- Record only durable rules here. Put detailed test guidance in `tests/e2e/README.md`
  and user/deployment instructions in `README.md`; link rather than duplicate.
- When context is running short, summarize the approved scope, changed paths,
  key decisions, observed failures, completed checks, and next action. Keep
  temporary diagnostics outside source and remove them before handoff.
- Report what changed, why, exact verification results, and any remaining blocker.
  Distinguish skipped tests and local smoke measurements from production evidence.
- Commit, push, or deploy only when explicitly requested. Before committing,
  inspect status, diff, and recent history; stage only intended files. Use concise
  semantic commit messages explaining the reason/non-obvious trade-off. Do not
  add generated/co-author trailers unless requested.
