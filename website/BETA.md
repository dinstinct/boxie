# Founding Android beta (`/beta`)

Recruitment flow for the Google Play closed test: applicants answer four screening
questions, qualified applications wait for a daily human review, and approval sends
the Play opt-in invite by email.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Application page | `launch/beta.html` (served at `/beta`) | Static page in the landing style. Google account email on the Android phone, daily Android phone, personal Outlook/Hotmail/Live account, two-week usage + feedback commitment. |
| Backend | `cloudflare/beta.js` | `/api/beta/*` routes plus `/beta-admin`. Qualification, D1 storage, honeypot + per-IP rate limit, notification email per application, invite email on approval. |
| Review UI | `/beta-admin` | Token-protected pending list with one-click approve/decline and status counts. |
| Schema | `cloudflare/beta-schema.sql` | D1 table `beta_applications`. |

## Flow

1. Applicant answers on `/beta`.
2. Qualified = Android yes + personal Outlook yes + commitment checked. Everyone else
   gets a graceful decline with the web early-access link.
3. Qualified applications land in D1 as `pending` and notify `BETA_NOTIFY_EMAIL`.
4. Review in a daily batch at `/beta-admin` (or through the JSON API). Approval is
   deliberately human: it keeps bots and low-intent testers out of the Play tester list.
5. Approve = status `approved` + invite email with `PLAY_OPT_IN_URL` and the 3-step
   setup (opt in with THIS Google account, install from Play, sign in + connect Outlook + pair).
6. Manual step that cannot be skipped: add approved Google account emails to the
   closed-track tester list in Play Console (Testing > Closed testing > track > Testers).
   `GET /api/beta/applications?status=approved&format=csv` exports the paste-ready column.
   The opt-in link only works for listed accounts.

## Setup

```sh
wrangler d1 create boxie-beta                      # once; put the database_id in wrangler.jsonc
wrangler d1 execute boxie-beta --file=cloudflare/beta-schema.sql --remote
wrangler secret put BETA_ADMIN_TOKEN               # generate: openssl rand -hex 24
wrangler secret put PLAY_OPT_IN_URL                # from the Play Console closed track
```

`BETA_NOTIFY_EMAIL` and `BETA_FROM_EMAIL` are plain `vars` in `wrangler.jsonc`.

## Mail

Sent via MailChannels from the worker. dionlabs.ai SPF must include
`include:relay.mailchannels.net`. To use Resend/Postmark instead, replace `sendEmail`
in `cloudflare/beta.js` - it is the only provider-specific function.

For heavier bot resistance later, add Cloudflare Turnstile to `launch/beta.html` plus a
siteverify call in `handleApply`. The honeypot and rate limit cover launch volume.

## Notes

- `/beta` is a static asset; only `/beta-admin` and `/api/beta/*` run worker code
  (see `run_worker_first` in `wrangler.jsonc`).
- Approved testers still need a Boxie account: they create it on the web, then pair
  Android. The invite email walks them through it.
- This change was authored on GitHub main; reconcile it into the private development
  checkout before its next `scripts/export-public-website.mjs` run.
