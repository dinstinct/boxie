# Boxie

**Email, with a human rhythm.** A free personal Outlook experiment from [DionLabs](https://dionlabs.ai).

[Meet Boxie](https://boxie.dionlabs.ai) · [Downloads](https://github.com/dion-labs/boxie/releases)

Boxie turns personal Outlook email into conversations, separates unfamiliar senders into Requests, and syncs encrypted mailbox records between paired devices. Outlook remains read-only: reply in Outlook, then see that reply in Boxie.

## Early access

Experimental public registration is open. Start on the web or Android with your personal Microsoft account: your inbox is encrypted locally and does not require Google sign-in or Firebase cloud setup. Cloud storage and device pairing are optional later choices. The optional cloud flow uses the original Google owner account. Create the first shared vault or pair with the existing vault, then explicitly consolidate your local inbox. Mailbox identity must match exactly; the earliest activation time and original local copy are retained, and existing shared organization wins conflicts. Work/school Microsoft accounts and direct Gmail connections are not supported yet.

- **Web:** [open the Outlook-first inbox](https://boxie.dionlabs.ai/app) · [Website hygiene release](https://github.com/dion-labs/boxie/releases/tag/web-2026.09.13.2).
- **Android:** [signed 0.2.9 preview APK](https://github.com/dion-labs/boxie/releases/tag/android-v0.2.9-preview.1). Android 8 or later. Connect personal Outlook to begin. Cloud sign-in and pairing are optional; existing vaults require approval from a trusted device before consolidation.
- **macOS:** public distribution is being prepared. Developer ID signing and notarization must complete before a public Mac download is advertised. The current development build is not a general-release installer.

Background sync can be delayed by the operating system or service quotas. Assistant configuration is optional and uses your chosen provider; its fees and privacy policy apply. Assistant chat history currently remains local to each device.

## Privacy and feedback

Send [private feedback](https://boxie.dionlabs.ai/feedback) or email support@dionlabs.ai if sign-in fails. Optional browser error reporting is off by default and excludes mail and raw logs.

Read the [privacy details](https://boxie.dionlabs.ai/privacy.html). Do not post email contents, credentials, pairing secrets, or personal account details in issues. Use issues for reproducible, non-sensitive bugs only.

This is Boxie’s public distribution, website source and support repository. The development research journal is not published here. Free to use does not imply an open-source license for unpublished implementation code.

Google Play internal testing is active for selected testers. The public download remains the signed APK; a production Play Store listing is not yet available.

## Account deletion

Open [Delete your Boxie account](https://boxie.dionlabs.ai/delete-account), also available in Android Settings. Requests are processed manually by DionLabs, normally within seven days. See the page for device cleanup and retained-record details. Support: support@dionlabs.ai.

## Website source

The landing page and browser app are in [`website/`](website/). GitHub Actions builds and validates every push to `main`. Cloudflare automatically deploys `main` to https://boxie.dionlabs.ai; see the website README for local builds and configuration.

## Android testers

[Register interest](https://boxie.dionlabs.ai/#beta) if you use Android and personal Outlook and can share feedback. The closed Play test is being prepared; applying is not an installation invitation.

Archive conversations to keep them out of the active list without deleting mail. Find them in Archived, restore manually, or let a new incoming email bring them back automatically. Update each client for archive support.
