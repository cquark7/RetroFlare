# RetroFlare

RetroFlare is a self-hosted, real-time retrospective app built with React and Cloudflare Workers. Create a board with **Went Well**, **Could Improve**, and **Shoutouts** columns, react to notes, and capture action items. Finished retros remain available as read-only history, with JSON backup and import.

## Cloudflare free tier

RetroFlare runs on Workers with a SQLite-backed Durable Object for shared state and WebSockets, and uses Cloudflare Access for sign-in. A small team can run it on Cloudflare's free plans without a custom domain. The Zero Trust free plan currently covers up to 50 users; Workers and Durable Objects are subject to [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/pricing/). Check current limits and your account's plan: free-tier limits can interrupt service, and paid plans may incur charges. GIPHY is optional and has its own terms and limits.

## Run locally

Requires Node.js 22.12.0 or newer and npm.

```sh
npm ci --cache .cache/npm
npm run dev
```

Open <http://localhost:5173>. Local development uses demo identities and local Worker storage; it does not use your Cloudflare account. To enable GIF search locally, add `VITE_GIPHY_API_KEY=your-web-sdk-key` to an untracked `.env.local` file and restart the server. The rest of the app works without it.

## Deploy to Cloudflare

You need a Cloudflare account with Workers and Zero Trust enabled and a hostname for the app. The default `workers.dev` subdomain works; a custom domain is optional. A [GIPHY Web SDK key](https://developers.giphy.com/) is optional; without one, GIF search is disabled.

1. Choose a Worker name and the hostname users will open. For the default `workers.dev` hostname, use `retroflare.<your-subdomain>.workers.dev`. **Choose a name not used by another Worker**: deploying to an existing name updates that Worker. If you already deployed this app, keep its existing Worker name to retain its data.
2. In Zero Trust, create a **hostname-based self-hosted Access application** for the entire Worker hostname, including its API and WebSocket routes. Add an Allow policy for the intended users. All allowed users must also have an email address in the single domain configured below. Use hostname-based Access, not Worker-level Access: [Worker-level Access does not support WebSocket upgrades](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker).
3. Copy the settings template and fill it in:

   ```sh
   mkdir -p .tmp
   cp deployment.example.vars .tmp/deployment.vars
   ```

   - `WORKER_NAME`: the name chosen in step 1.
   - `APP_ORIGIN`: the exact HTTPS origin, for example `https://retroflare.<your-subdomain>.workers.dev` or your custom domain (no trailing slash).
   - `ALLOWED_EMAIL_DOMAIN`: the single allowed email domain, such as `example.com`.
   - `ACCESS_TEAM_ISSUER`: your Zero Trust team domain, including `https://`, such as `https://<team>.cloudflareaccess.com`.
   - `ACCESS_AUD`: the application's [Audience (AUD) tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
   - `ADMIN_EMAILS`: optional comma-separated email addresses allowed to import backups and use administrator recovery controls.
   - `VITE_GIPHY_API_KEY`: optional GIPHY Web SDK key. Leave empty to disable GIF search. This client key is included in the browser bundle; it is not a Worker secret.

4. Install dependencies (`npm ci --cache .cache/npm`), authenticate, and deploy:

   ```sh
   npx wrangler login
   npm run deploy
   ```

The script builds and deploys the Worker; it does not create the Access application. Confirm the Access policy covers the entire hostname before sharing it. The Worker fails closed if its Access settings are missing or invalid. Keep `.tmp/deployment.vars` and backups out of Git: backups contain your team's retrospective data.

## Contributing and tests

```sh
npm run typecheck
npm run lint
npm run test
npm run build
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npx playwright install chromium
npm run test:e2e
```

The browser suite starts its own local server and uses isolated, nonpersistent data. See [browser test notes](tests/e2e/README.md) for details.

## License and credits

The project source is available under the [MIT License](LICENSE). Bundled fonts use the [SIL Open Font License](src/client/fonts/OFL.txt); bundled music is provided under CC0, with sources listed in the [music credits](public/music/CREDITS.md).
