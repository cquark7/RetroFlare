# Security

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/cquark7/RetroFlare/security/advisories/new). Do **not** disclose a vulnerability in a public issue, pull request, or discussion.

Include:

- The affected commit or version and whether it is a local or deployed instance.
- A description of the impact and the conditions needed to exploit it.
- Minimal reproduction steps or a proof of concept using fictional data.
- Any suggested mitigation, if known.

Never include live credentials, Access assertions, session cookies, real retrospective notes, or unredacted backups. Test only instances you own or have permission to assess. Please allow time for investigation and a fix before publishing details; disclosure and credit can be coordinated in the private report. This is a community-maintained project, with no guaranteed response time or bug bounty.

## Updates

Use the latest code on `main`. Fixes are developed there; older commits and deployments are not maintained as separate security branches. Deployment owners are responsible for applying updates and reviewing their Cloudflare configuration.

## Deployment boundaries

- Deploy each instance for one trusted team. All users allowed by Cloudflare Access and the configured email-domain check can read its boards and history. There is no per-board read isolation, anonymous feedback mode, or end-to-end encryption.
- Protect the **entire hostname**, including API and WebSocket paths, with a hostname-based Cloudflare Access application. Worker-level Access protection does not support this app's WebSocket connections.
- Keep `APP_ORIGIN`, `ACCESS_TEAM_ISSUER`, `ACCESS_AUD`, and `ALLOWED_EMAIL_DOMAIN` aligned with that application. Production requires verified Access assertions and fails closed when configuration is missing or invalid.
- Restrict `ADMIN_EMAILS` to trusted operators. Administrator privileges include backup import and recovery controls.
- Never expose the Vite development server or demo identities as a public production service. Local sign-in is for development only.
- Treat exported JSON backups, browser recovery drafts, and deployment settings as sensitive. Keep backups outside public repositories and share only sanitized diagnostics.
- GIPHY is optional. Its Web SDK key is shipped in the browser bundle, not stored as a server secret; do not reuse a confidential credential as that key.

See the [deployment instructions](README.md#deploy-your-own-instance) for setup and [troubleshooting](README.md#troubleshooting) for common configuration problems.
