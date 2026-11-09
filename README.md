# RetroFlare

<p align="center">
  <a href="https://github.com/cquark7/RetroFlare/actions/workflows/ci.yml"><img src="https://github.com/cquark7/RetroFlare/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f765d.svg" alt="MIT License"></a>
</p>

I built RetroFlare for my team after our TeleRetro subscription expired. We needed a free alternative, and I wanted something small that covered our use case without becoming another tool to manage.

The idea is simple: get the team together, talk about the sprint, and leave with a few things worth doing differently. Keep the boards for next time, with export and import so you can back them up or move them to another instance.

It's open source and runs in your own Cloudflare account. A small team can stay within Cloudflare's [free-plan limits](#hosting-costs), without needing a custom domain. If your team needs something similar, you're welcome to use it and make it your own.

[Quick start](#run-locally) · [Self-host](#deploy-your-own-instance) · [Troubleshooting](#troubleshooting) · [Contribute](CONTRIBUTING.md)

![RetroFlare walkthrough: a teammate adds a note live, another reacts, then assigns an action item](assets/retroflare-demo.gif)

*A quick look at a retro, from a note to a next step. Prefer screenshots? Here's [the board](assets/screenshot-board.png) and [the action-items view](assets/screenshot-actions.png).*

## Small on purpose

This isn't an attempt to recreate every feature in TeleRetro. I kept it minimal and lightweight for our team: enough structure to help the conversation, without making the tool the focus of the meeting.

Finishing a retro keeps a read-only record. Export and import use JSON files, so your history doesn't have to stay tied to one deployment. There are also GIFs and focus music for a bit of fun, but neither is required to use the app.

It's designed for one trusted team per instance, not separate customers sharing a service. That keeps the setup straightforward, but it also means everyone admitted to your instance can read its boards. More on that under [data and access](#data-and-access).

<details>
  <summary>View board and action-item screenshots</summary>
  <br>
  <img src="assets/screenshot-board.png" alt="A team retrospective in RetroFlare, with notes from Sam and Jordan and reactions to a shared idea">
  <br><br>
  <img src="assets/screenshot-actions.png" alt="RetroFlare action items with owners, shown over a live retrospective board">
</details>

## Run locally

Requires **Node.js 22.12+** and npm.

```sh
git clone https://github.com/cquark7/RetroFlare.git
cd RetroFlare
npm ci --cache .cache/npm
npm run dev
```

Open <http://localhost:5173>. You don't need a Cloudflare account or any API keys to try it locally. The app uses demo identities and stores boards locally through the Worker development runtime.

### Try your first retro

1. Click **Start a retro**, give it a title, and choose your display name.
2. To see collaboration in action, open the board URL in a private browser window and choose a different **Demo as** identity. Use separate browser sessions, since tabs in the same session share an identity.
3. Add a few notes and reactions. Use **Action items** for anything you want to follow up on, and give it an owner. Notes autosave; look for **Saved to this board** before closing the tab.
4. When you're done, the host can click **Finish retro**. The app asks connected teammates to save before closing the board. You can revisit it from the home screen or download it through **Board menu → Export board**.

Want GIF search too? Add `VITE_GIPHY_API_KEY=your-web-sdk-key` to an untracked `.env.local` file and restart the dev server. It's optional.

The local server is just for trying things out and working on the app. Don't expose it publicly; demo identities aren't real sign-in. For actual team use, deploy an instance below and share its board URLs with your teammates.

## Deploy your own instance

You'll need a Cloudflare account. The app deploys as a Worker, with Cloudflare Access handling sign-in. You can use the default `workers.dev` address; there's no need to buy a domain.

1. **Choose a Worker name and hostname.** For example, `retroflare.<your-subdomain>.workers.dev`. Use a new name for a new instance; if you already run RetroFlare, keep its current Worker name to retain that instance's data.
2. **Set up sign-in with Access.** Create a hostname-based self-hosted Access application for the full hostname, including API and WebSocket requests, and choose who can sign in. Use hostname-based protection, not Worker-level protection: the latter doesn't support the WebSocket connections this app needs. See [Cloudflare's Access setup guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
3. **Create a local deployment settings file:**

   ```sh
   mkdir -p .tmp
   cp deployment.example.vars .tmp/deployment.vars
   ```

   Set the values in `.tmp/deployment.vars`:

   | Setting | What to enter |
   | --- | --- |
   | `WORKER_NAME` | The Worker name from step 1. |
   | `APP_ORIGIN` | Exact HTTPS origin, e.g. `https://retroflare.<your-subdomain>.workers.dev`, with no trailing slash. |
   | `ALLOWED_EMAIL_DOMAIN` | The email domain allowed by the Worker, such as `example.com`; configure the Access policy separately. |
   | `ACCESS_TEAM_ISSUER` | Your Zero Trust team issuer, such as `https://<team>.cloudflareaccess.com`. |
   | `ACCESS_AUD` | The Access application's [Audience (AUD) tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag). |
   | `ADMIN_EMAILS` | Optional comma-separated addresses allowed to import backups and use administrator recovery controls. |
   | `VITE_GIPHY_API_KEY` | Optional [GIPHY Web SDK key](https://developers.giphy.com/). Leave empty to disable GIF search. This client key is included in the browser bundle; it is not a Worker secret. |

4. **Install, authenticate, and deploy:**

   ```sh
   npm ci --cache .cache/npm
   npx wrangler login
   npm run deploy
   ```

The script builds and deploys the app, but it doesn't set up Access for you. Before inviting your team, check that Access protects the whole hostname. If the Access settings are missing or invalid, the app refuses access rather than letting people in without sign-in.

Keep `.tmp/deployment.vars` and exported backups out of Git. Backups contain your team's retrospective data.

### Hosting costs

RetroFlare is free; hosting is the part to keep an eye on. Cloudflare's free plans may cover a small team's use, but that isn't a promise of free hosting at any scale. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and your account's pricing. Going beyond included usage can cost money.

### Data and access

- **Who can read a board?** Anyone allowed into the instance by Access and the app's email-domain check. A board link isn't a private invitation, so use separate deployments for teams that shouldn't see each other's notes.
- **Are notes anonymous?** No. Notes have display names, and edits are tied to the signed-in user.
- **Where does the data go?** Saved boards live in a SQLite-backed Durable Object in your Cloudflare account. Recovery drafts can also remain in the browser. Keep backups somewhere safe; the app doesn't provide end-to-end encryption.
- **What about GIFs and music?** Music plays only in your browser, when you turn it on. If you enable GIPHY, searches and media requests go to GIPHY. Shared GIFs aren't saved in board history.

Found a security issue? Please [report it privately](SECURITY.md). That guide also covers the deployment's security boundaries.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Local server will not start | Use Node.js 22.12+ and run `npm ci --cache .cache/npm`. Port 5173 must be free; do not start a second copy on the same port. |
| Local session is unavailable after a server restart | Try a fresh private window. Demo sessions only last while the dev server is running; saved boards remain in local Worker storage. Don't clear the original browser's storage if you need its unsaved drafts. |
| Deployment reports missing settings or placeholders | Copy `deployment.example.vars` to `.tmp/deployment.vars` and replace the required values. Run `npm run deploy` from the repository root. |
| Deployed app reports authentication is not configured | Check the required Access settings, especially the issuer and application AUD. The app won't let people in until these are configured; it doesn't fall back to demo identities. |
| Sign-in succeeds but the app denies access | The signed-in email must match `ALLOWED_EMAIL_DOMAIN`; `APP_ORIGIN` must match the browser's exact HTTPS origin. Check the Access policy separately. |
| Board loads but live collaboration fails | Use hostname-based Access, not Worker-level Access. Make sure the same hostname covers the app, API, and WebSocket requests. |
| GIF search is missing | Set the optional `VITE_GIPHY_API_KEY` before building, then rebuild/redeploy. For development, restart Vite after editing `.env.local`. |

Still stuck? [Open an issue](https://github.com/cquark7/RetroFlare/issues/new/choose) and tell me what you tried, which browser you're using, and the commit you're running, if you know it. Please use made-up examples and leave out tokens, cookies, deployment settings, and real team backups.

## Contributing

This started with our team's needs, so I'd like to hear where it works for yours—and where it doesn't. If setup is confusing or something gets in the way of a retro, that's useful feedback too. You don't have to send a pull request to help.

If you'd like to contribute code or docs, the [contribution guide](CONTRIBUTING.md) will help you get started. For bigger ideas, [open an issue](https://github.com/cquark7/RetroFlare/issues/new/choose) first so we can talk through whether they fit the small, focused tool this is meant to be.

And if it saves your team a subscription, pass it along to another team that could use it.

## License and credits

RetroFlare is available under the [MIT License](LICENSE). Bundled fonts use the [SIL Open Font License](src/client/fonts/OFL.txt); bundled music is CC0, with sources and details in the [music credits](public/music/CREDITS.md).
