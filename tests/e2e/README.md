# Browser regression tests

Run the regular suite with `npm run test:e2e`. It starts its own strict-port
5174 server with disabled Worker persistence and fresh browser contexts.
The manual server on 5173 is independent.

## Coverage and boundaries

- `release-critical.spec.ts`: independent boards exercise collaboration,
  ownership, reactions, action owners, continuous
  autosave, offline recovery, same-actor tabs, lost ACK idempotency, revision
  recovery, board isolation, closing dirty drafts, history, export/duplicate
  import, and narrow layouts.
- `music-player.spec.ts`: real local MP3 decoding/playback, preference reload,
  private per-browser playback, stop-on-leave/close, and asset-error recovery.
- `giphy-sharing.spec.ts`: deterministic third-party API/media fixtures with
  real application search, socket fan-out, image decoding, expiry, and saved
  history invariance. It does not test GIPHY availability.
- `performance-smoke.spec.ts`: opt-in 15-client concurrent updates with 45
  server-processed-to-peer-render samples. Run separately with
  `RETROFLARE_RUN_15_CLIENT_PERF=1 npm run test:e2e -- tests/e2e/performance-smoke.spec.ts`.
  This is a local smoke budget, not a production load benchmark.

Authentication uses the local session endpoint as setup. Product mutations
use browser controls. API reads verify persistence and exactly-once writes;
socket routing only injects specific transport failures. Tests use observable
states rather than fixed sleeps or mocked application clocks.

The server enforces five board creations per actor/hour and twenty per
deployment/day. Creator identities are distributed across scenarios. For
repeatability checks, run `npm run test:e2e` in separate invocations so each
gets a fresh nonpersistent server; `--repeat-each` can exhaust the deployment
budget within a single server process. No test disables these product limits.

Two workers bound local CPU contention, especially for typing and media.
Failed tests retain traces and screenshots in `test-results/`. The performance
smoke writes its measured report to `.tmp/15-client-performance-report.json`.
