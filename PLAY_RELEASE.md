# Google Play internal releases

The `Play internal release` GitHub Actions workflow is manual and runs only from
`main`. Select a published Android release tag and first run `mode: validate`.
This verifies the AAB checksum, release metadata and Play API access. It creates
and deletes an API edit; it does not upload a bundle or validate a new rollout.
Run `mode: publish` explicitly to release that same bundle to internal testers.
Closed testing and production promotion are separate decisions.

## Release contents

Every Android GitHub release must include its signed AAB, APK for direct installs,
checksums, full changelog, and `play-release.json`. Keep the manifest in
`releases/<tag>/play-release.json` and attach the same file to the GitHub release.
Use the existing manifest as the template. Increment Android versionCode for
any new binary. Record user-facing changes, compatibility/migration notes,
known limitations and validation evidence in the full GitHub release notes.

The manifest contains the exact package, version code, AAB filename and SHA-256,
a descriptive Play release name, and localized `releaseNotes` entries. Each
language requires 1–500 Unicode characters. Write concise user-facing notes;
do not truncate the full changelog automatically. The workflow publishes these
notes along with the bundle and verifies them after commit. Update screenshots,
store description, privacy policy and Data safety declarations when the changes
require it; this workflow deliberately does not overwrite the existing listing.

Keep Android upload signing on the maintainer machine. This workflow consumes
an already signed artifact; no signing key is copied to Actions. Uploads use a
short-lived Google OAuth token obtained through GitHub OIDC.

## One-time identity setup

Google project: `dionlabs-fe92e`. Enable Android Publisher, IAM Credentials and
Security Token Service APIs. Create a dedicated `boxie-play-release` service
account with no project-wide Editor role. Grant it only the Boxie app's Play
permissions to view app information and release to testing tracks. Do not grant
production release, tester-list administration, financial or account-admin access.

Create a Workload Identity provider for `https://token.actions.githubusercontent.com`.
Map `google.subject=assertion.sub` and repository ID/owner attributes. Restrict its
condition to all of:

- `assertion.repository_id == '1358379126'`
- `assertion.repository_owner_id == '252023800'`
- `assertion.ref == 'refs/heads/main'`
- `assertion.sub == 'repo:dion-labs/boxie:environment:play-internal'`
- `assertion.workflow_ref == 'dion-labs/boxie/.github/workflows/play-internal.yml@refs/heads/main'`

Grant `roles/iam.workloadIdentityUser` on that service account to the pool's
principal set for that repository ID. Create GitHub environment `play-internal`,
restricted to `main`, and set environment variables `PLAY_WIF_PROVIDER` (full
provider resource name) and `PLAY_SERVICE_ACCOUNT` (service-account email).
These identifiers are not secrets. No Google JSON private key is needed.

## Failures and verification

The workflow refuses to replace a newer internal version or reuse a version code
with a different checksum. An identical release is a no-op. A commit timeout is
not automatically retried: inspect Play Console and the Actions receipt first.
A successful API commit and track readback confirm Play publication, not that a
physical phone has already received the update. Allow Play processing and verify
installation, sign-in, pairing, synchronization and the release's changed behavior.

The Actions summary links the full changelog and records the result. A `prepared`
receipt alone means artifact preparation succeeded, not that Play access or
publication succeeded. Always check the overall workflow outcome.

References: [Play API setup](https://developers.google.com/android-publisher/getting_started),
[release notes and rollout](https://support.google.com/googleplay/android-developer/answer/9859348?hl=en).
