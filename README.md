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
- Optional plugin-managed worker startup and crash recovery, including containers.
- Rootless installer with private credential files and automatic CLI recovery.
- Permission-required emails with request-specific allow-once, reject, and always replies.

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
bun dist/cli.js install
```

The package is installed from this repository; it is not published to npm.
The installer registers the plugin in your global OpenCode JSON/JSONC config,
preserves existing settings/comments, and prints the paths it created. It needs
no root access and does not modify `/usr/local/bin` or your shell profile.

1. Edit the printed mail-settings file (normally
   `~/.config/opencode-email-sync/config.json`): set your account, SMTP/IMAP servers,
   and allowed recipient addresses.
2. Edit the printed private credential file (normally
   `~/.config/opencode-email-sync/worker.env`):

   ```dotenv
   OPENCODE_MAIL_PASSWORD="your-mail-app-password"
   ```

3. **Quit and restart OpenCode.** When its first project loads the plugin, a
   shared supervisor starts the worker. It waits for credentials when necessary
   and restarts a crashed worker. Each OpenCode shell automatically receives the
   user-owned CLI directory on PATH, so the session commands work immediately.

Configuration and state paths follow XDG variables when set. You can choose
persistent paths explicitly:

```sh
bun dist/cli.js install \
  --config /persistent/config/email-sync/config.json \
  --opencode-config /persistent/config/opencode/opencode.jsonc \
  --state-directory /persistent/state/email-sync
```

For container recreation, preserve the package, Bun runtime, configuration,
credentials, and state at their configured paths. See
[persistence and autostart](docs/persistence.md) for a complete checklist.

Autostart is opt-in for existing configurations (`worker.autoStart` defaults to
false); the installer enables it when that setting is absent. Explicitly manual
installations retain `false`. The [operations guide](docs/operations.md) also
describes standalone/systemd worker startup.

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

Attachments and question-tool selections are not supported. Ordinary
conversational answers work as normal user prompts. Permission requests are
handled separately as described below.

## Replying to permission requests

When OpenCode pauses for permission in a synced session, the plugin sends a
**Permission required** email immediately, without waiting for the final answer.
The email includes the requested permission, affected command/path patterns,
request details, and these exact reply options with explanations:

```text
!opencode-email-sync permission once
!opencode-email-sync permission reject
!opencode-email-sync permission always
```

- **once** approves only that request.
- **reject** denies that request.
- **always** uses OpenCode's own matching-action approval scope, shown in the email.

Reply to the specific permission email with one command alone. Its email thread
binds the decision to the exact request; the subject/session ID is not used to
guess a pending permission. The allowlist and per-session sync policy apply.
Permission decisions go directly to OpenCode's API, not to the coding agent or a
shell. The worker confirms the outcome to the sender. Requests already answered
in the UI or expired produce a stale-request response instead of another approval.

Subagent permissions are reported under their root session's title and sync
policy; the email also shows the actual target session ID. Decisions can unblock
a prompt already waiting on a permission without becoming new user messages.

OpenCode cannot run shell commands in the paused/busy session itself. To use
shell mode, open another idle session in the **same project**, append the request
ID printed in the email, and run for example:

```text
!opencode-email-sync permission once per_example_request_id
```

An explicit ID cannot target another project. Omitting the ID is accepted only
when the current session has exactly one pending permission. See
[permission handling](docs/permissions.md) for recovery and upgrade details.

## Configuration and operations

See [configuration](docs/configuration.md) for TLS settings, credential variables,
mailbox polling, state paths, and optional receiving-server DMARC verification.
See [operations](docs/operations.md) for service startup, status, restart recovery,
and uncertain-job resolution.
See [persistence](docs/persistence.md) for installation, worker supervision,
rootless CLI paths, and container volume requirements.

## Development

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun test
bun run typecheck
bun run build
```

Tests use disposable local SMTP/IMAP servers, generated TLS certificates, a dummy
local model, real OpenCode instances, and Chromium. They require `opencode`,
`openssl`, and the Playwright Chromium installation. No personal mail credentials
are used. Tests do not alter the active OpenCode configuration.

An optional GitHub Actions template is provided at
`docs/ci-workflow.yml.example`. Copy it to `.github/workflows/ci.yml` to activate
CI when publishing with an account/token that permits workflow updates.

MIT licensed.
