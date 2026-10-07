# OpenCode Email Sync

Two-way email participation in OpenCode sessions. Receive nicely formatted coding
agent answers, then reply to continue the same session. Multiple projects and
OpenCode processes share a single SMTP/IMAP mailbox through one local worker.

**Email sync is on by default for every existing and new user-facing session.**
Installation does not send historical conversations. Internal subagent sessions,
reasoning, compaction output, and tool traces do not generate notifications.

## Features

- Configurable SMTP/IMAP hosts, ports, TLS/STARTTLS, credentials, and recipients.
- HTML and plain-text answers with code blocks, headings, tables, and links.
- Subjects: `[Project] Session title [session-id]`.
- Recipient-scoped thread routing: replies continue the originating session.
- Incoming instructions accepted only from the configured recipients.
- Default-on sync, persistent per-session controls, and durable delivery/reply queues.
- One worker per local installation; no OpenCode fork or browser extension needed.

## Requirements

- Bun **1.4.2 or newer** on `PATH`.
- OpenCode **1.18.34** is the verified version; other versions need verification.
- SMTP and IMAP access to a dedicated mailbox. Passwords/app passwords supported;
  provider-specific OAuth flows are not included.
- Worker and OpenCode instances on the same host and under the same OS user.
- Linux with the `flock` utility for crash-safe worker exclusion.

## Install from GitHub

```sh
git clone https://github.com/Sponn/opencode-email-sync.git
cd opencode-email-sync
bun install --frozen-lockfile
bun run build
bun link
```

The package is installed from this repository; it is not published to npm.
`bun link` places the CLI in Bun's global bin directory. Ensure that directory
is on the `PATH` inherited by OpenCode, including an OpenCode service process.

1. Copy `examples/email-sync.json` to
   `~/.config/opencode-email-sync/config.json` (or an explicit absolute path).
   Set the mailbox address, server details, and your allowed recipient addresses.
2. Provide the password **in the worker's environment**, then initialize and start:

   ```sh
   export OPENCODE_MAIL_PASSWORD='your-mail-app-password'
   opencode-email-sync init
   opencode-email-sync start
   ```

   For a custom configuration path, append `--config /absolute/path/config.json`
   to each command. Keep the worker running; the password is resolved there,
   not in each OpenCode process.

3. Add the plugin to your global OpenCode config,
   `~/.config/opencode/opencode.json`, merging with its existing fields:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       ["file:///absolute/path/to/opencode-email-sync/dist/index.js", {
         "configPath": "/absolute/path/to/email-sync/config.json"
       }]
     ]
   }
   ```

   The plugin can also be loaded as a string file URL when using the default
   email-sync configuration path. Use an absolute file URL for the built entry.

4. **Quit and restart OpenCode** to load the plugin and changed configuration.
   Its next completed answers will be emailed to each configured recipient.

## The same controls everywhere

In the OpenCode web UI or TUI, type `!` at the beginning of the input to enter
shell mode, then type the remainder of the command. In an email reply, send the
entire line exactly as shown:

```text
!opencode-email-sync session on
!opencode-email-sync session off
!opencode-email-sync session status
```

OpenCode automatically supplies the current session identity. The result appears
in its shell execution record; expand that record to see the output. These
controls do not call the model. Email commands are parsed directly by the worker
and do not execute a shell.

`off` stops answer notifications and ordinary email instructions for that session.
It cancels queued/preparing work but does not abort a prompt already committed
for submission to OpenCode.
You can still reply to an older notification with `on` or `status`. Control
confirmations go only to the sender. Re-enabling does not replay canceled updates.

## Replying to answers

Reply to a notification from an allowed address with your instructions above the
quoted answer. The worker removes common email quotes/signatures and sends the
authored text into the same OpenCode session, retaining its agent/model selection.
Busy sessions queue replies in arrival order. OpenCode must be running to execute
them; the worker can receive mail while it is offline.

Keep the email's reply-thread metadata: changing the subject is fine, but a new
email containing only a session ID cannot identify an authorized thread. Each
recipient receives an individual notification, so reply from the address that
received it. For unusual quoting, end your authored text with a standalone line:

```text
--- end reply ---
```

Attachments, interactive permission approvals, and question-tool selections are
not supported. Ordinary conversational answers work as normal user prompts.

## Configuration and operations

See [configuration](docs/configuration.md) for TLS settings, credential variables,
mailbox polling, state paths, and optional receiving-server DMARC verification.
See [operations](docs/operations.md) for service startup, status, restart recovery,
and uncertain-job resolution.

## Development

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun test
bun run typecheck
bun run build
```

Tests use disposable local SMTP/IMAP servers, generated TLS certificates, a dummy
local model, real OpenCode instances, and Chromium. They require `opencode`,
`openssl`, and the Playwright Chromium installation. No personal mail credentials
are used. Tests do not alter the active OpenCode configuration.

MIT licensed.
