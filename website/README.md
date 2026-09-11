# Boxie website

The landing page and browser app at https://boxie.dionlabs.ai live together here.
The Cloudflare Worker preserves `/app`, `/redirect.html`, `/feedback`,
`/delete-account`, and older onboarding/pairing query links on the same origin.

## Build

Use Node 22.12 or newer and the pinned pnpm version in `package.json`.
Copy `.env.example` to `.env.local` and supply your Firebase web configuration and
Microsoft SPA client ID. These are public browser identifiers, not server secrets.
Never put service-account credentials, access tokens, or model-provider keys in
`VITE_*` variables. Explicitly choose registration and organization-sync switches.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Deployment

GitHub Actions validates every main push and pull request with synthetic client
configuration; it never deploys that test build.

Cloudflare Workers Builds deployment configuration targets this directory (`website`) on `main` in
`dion-labs/boxie`. Production uses Worker `boxie` and the existing custom domain.
Build command: `pnpm typecheck && pnpm test && pnpm build`.
Deploy command: `pnpm exec wrangler deploy`.
Production client variables are configured in Cloudflare, outside Git.
The GitHub connection deploys main pushes; non-production builds are disabled.
Non-main branches must never deploy to production.

The rest of the public repository contains downloads and support information.
Private research history, local mailbox data, credentials and native signing
material are not part of this website source.

The private development checkout can export its reviewed browser source using
`scripts/export-public-website.mjs`. Its `--check` mode detects drift. Reconcile
GitHub website edits back into that checkout before its next export; do not
blindly overwrite changes made here. `.source-manifest.json` lists the exact
exported file set.
