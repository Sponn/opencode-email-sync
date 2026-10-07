# OpenCode email sync — design

## Approved command amendment

The user approved built-in shell-mode controls after a live OpenCode 1.18.34
probe proved custom-command hooks cannot return clean non-LLM results. The
authoritative syntax in every interface is `!opencode-email-sync session on`,
`!opencode-email-sync session off`, and `!opencode-email-sync session status`.
Email uses exactly that text as a standalone command, interpreted directly by
the worker, never by a shell. In OpenCode, `!` enters its built-in shell mode;
the plugin injects session routing into the process environment and the CLI
prints the result. The normal shell execution record is permitted and excluded
from answer notifications. Earlier `/email` and custom-command-hook references
below are superseded by this amendment. No slash-command hook is installed.

## Intent and agreed requirements

Provide two-way email participation in OpenCode sessions across multiple projects
and parallel sessions using one shared mail account. Completed coding-agent
answers are emailed in readable form; authorized replies become user messages in
the originating session, as if submitted through OpenCode's web UI.

The user approved a globally installed plugin plus one shared local mail worker.
Sync defaults to **on for every existing and new session**. Persistent session
overrides are controlled using `/email on`, `/email off`, and `/email status`
from the web UI or an email reply. A native web UI switch is not required.

Success means parallel projects are routed independently, toggles behave equally
across interfaces, unlisted senders cannot submit instructions, and restarts or
mail outages do not silently discard queued work.

## Scope

Deliver a TypeScript plugin package and worker CLI in one GitHub repository,
with configuration examples, setup documentation, and automated tests. Use Bun
as the supported runtime, matching OpenCode's plugin runtime. Initial support
is a worker and OpenCode instances on the same host, sharing one OS user and
one configuration/state directory. Multiple web UI sessions and multiple
OpenCode server processes are supported. Cross-host coordination, attachments,
permission approvals by email, and interactive question-tool responses are
outside this initial release. Ordinary conversational questions in completed
answers can be answered by email.

OpenCode must remain running for agent execution. The worker may stay running
independently to receive and queue mail while an OpenCode instance is offline.

## Components and boundaries

### Plugin adapter

The plugin receives the SDK client, project, directory, worktree, and server URL.
It registers with the worker and forwards lifecycle and completed-answer events.
It uses the SDK to read authoritative session/message data and submit incoming
prompts. SDK access remains inside the plugin, so the worker need not store
OpenCode server passwords or construct authenticated SDK clients itself.

The plugin installs the `email` custom command through the configuration hook.
The command hook handles recognized arguments deterministically, then prevents
the normal command path from starting an LLM turn. Toggle/status results must be
visible in the UI. Do not implement an agent-interpreted toggle.

Before building the rest of the adapter, verify this command interception and
UI feedback path against installed OpenCode 1.18.34 and its matching plugin/SDK
types. The documented command hook alone does not promise a successful
short-circuit response. If it cannot support this behavior, report the concrete
limitation and obtain approval for an adjusted integration; do not silently
substitute an agent tool or claim native command support.

Plugin unload closes its worker connection and stops heartbeats. Mail network
activity never blocks OpenCode's answer event handler.

### Shared worker

A separately started CLI process owns SMTP delivery, IMAP ingestion, durable
queues, and routing. Only one worker may use a given state directory, enforced
with an exclusive process lock that detects a stale owner.

Use an authenticated, loopback-only local HTTP control service. Its random
shared token is generated during initialization and stored in a user-readable
only file. A configurable port supports non-default installations. The plugin
loads the token from that file, never from project content. The worker accepts
authenticated registrations, heartbeat requests, answer events, command
requests, and job acknowledgments. Plugins long-poll for inbound session jobs;
the worker does not expose remote callback endpoints.

Keep mail transport, reply parsing, routing, session policy, and state storage
as focused modules with interfaces independent of OpenCode.

### Durable state

SQLite in the user's state directory stores:

- Installation/instance identifiers and registered projects/directories.
- Session identities, titles, last-known activity, and explicit sync overrides.
- Answer notification records, recipient delivery states, and stable Message-IDs.
- Sent-message-to-session thread mappings with opaque routing tokens.
- IMAP mailbox identity, UIDVALIDITY, ingestion checkpoint, and incoming records.
- Queued prompts, dispatch message IDs, leases, attempts, and outcomes.

Keys include a persistent OpenCode instance identifier, project ID, canonical
session directory, and full session ID. Concurrent registrations for the same
route share one answer deduplication identity and select one live adapter for
dispatch. An adapter restart retains its instance identity. If a session route
is ambiguous, hold the job rather than dispatch to an arbitrary instance.

Transactions enforce uniqueness for answer/recipient notifications and incoming
mail identities. Session overrides survive plugin and worker restarts.

## Configuration

Keep mail settings in a dedicated user-level configuration file; do not add
unknown top-level mail fields to `opencode.json`. The OpenCode config registers
the plugin and optionally supplies a configuration-file path through supported
plugin options. Validate examples against the published OpenCode schema.

Configuration includes:

- Account email address and optional display name.
- SMTP host, port, username, credential environment-variable name, and security
  mode: implicit TLS, required STARTTLS, or explicitly selected plaintext.
- IMAP host, port, username, credential environment-variable name, mailbox, and
  the same explicit security modes.
- Certificate verification (on by default) and optional CA file.
- One nonempty address list defining both notification recipients and authorized
  instruction senders. Send separate messages to recipients.
- Worker loopback port, state path, reconnect intervals, and bounded message size.

Default IMAP mailbox is INBOX. Credentials are resolved by the worker at startup
and are excluded from logs and persistent queues. Fail fast on invalid settings
with an actionable diagnostic. Default sync policy is on; per-session overrides
are authoritative. Recipient configuration changes apply after worker restart.

## Answer notification flow

1. Observe session idle/completion and fetch authoritative messages.
2. Select newly completed, visible assistant answer text associated with a user
   turn. Exclude tool-only steps, reasoning, synthetic compaction, and internal
   child-session output. Normal user-facing sessions default on.
3. Assemble the visible answer for the completed turn in message order, including
   visible explanatory text leading to the final answer, without tool traces.
4. Submit an idempotent notification record to the worker. Event duplicates and
   multiple plugin registrations must not create new recipient deliveries.
5. Recheck sync policy before sending a queued notification. An explicit off
   command cancels unsent notifications for that session.
6. Deliver a multipart plain-text/HTML email to each configured recipient.

On initial installation, establish a current-history baseline and do not email
old answers. On adapter reconnection, reconcile answers after the persisted
baseline to recover notifications missed while the worker was unavailable.

Subject format: `[Project] Session title [full-session-id]`. Project label uses
the configured OpenCode project name when present, otherwise the worktree
directory basename. Sanitize header values and limit label/title length while
preserving the session ID at the end. Project/directory identity also appears
in the body to distinguish similarly named projects.

Render Markdown as sanitized HTML with email-compatible inline styles. Preserve
headings, lists, links, tables, and code blocks. Do not load external images or
include executable markup. Include a plain-text version and a footer explaining
reply behavior and toggle commands. Stable Message-IDs and thread headers allow
normal email-client threading. Reply-To is the configured account.

## Inbound reply flow

Use IMAP IDLE where supported, with periodic polling and reconnect backoff.
Use UID checkpoints rather than unread status. On first startup, baseline the
mailbox instead of processing historical mail. Persist incoming records before
advancing the checkpoint. UIDVALIDITY changes trigger a rescan with persistent
Message-ID/content deduplication. Never delete mail or treat unrelated mail as
plugin work.

1. Parse MIME within configured size limits. Ignore automated replies, delivery
   reports, and mail sent by the worker itself.
2. Require exactly one parsed From mailbox matching the configured allowlist.
   Normalize domain case; preserve local-part semantics. Never authorize from
   display names, Reply-To, substring matches, or quoted headers.
3. Correlate In-Reply-To/References to stored outbound messages and their opaque
   routing tokens. The subject session ID is informational, not sufficient to
   authorize routing. Ambiguous/unmapped mail is ignored and logged by reason.
4. Enforce recipient-scoped thread authorization: the sender must still be
   allowlisted and must be a recipient of the referenced notification.
5. Extract newly authored text from plain text or HTML, removing recognizable
   quoted history and signatures. Ignore empty replies and attachments. If
   extraction is ambiguous, send a short instruction to use an explicit
   `--- end reply ---` delimiter; do not submit known quoted agent output.
6. Treat a standalone exact `/email on`, `/email off`, or `/email status` as a
   control command. Mixed command and prose is rejected with usage guidance.
7. If sync is off, ignore ordinary replies; control commands remain available.
8. Otherwise queue the text for the matched session with sender metadata.

For sender authenticity, provide a configurable trusted receiving-server
Authentication-Results check. Trust only explicitly configured authserv IDs and
require aligned DMARC pass when this mode is enabled. Never trust an arbitrary
sender-supplied authentication header. Document that From allowlisting alone
filters addresses but does not prove sender identity; this is distinct from
thread-token validation. Users can select the mode appropriate to their mail
server without requiring a provider-specific integration.

## Commands and user feedback

`/email on` sets the persistent override to on; `/email off` sets it to off;
`/email status` reports effective policy. `/email` without arguments returns
status and usage. Commands are case-insensitive, with surrounding whitespace
removed; no configurable aliases in the first release.

Web UI commands operate on the current session. Email commands operate on the
referenced thread's session. Email control confirmations go only to the sender
and are permitted while sync is off; they must not generate agent turns or be
reingested as instructions. Re-enabling sync sends future answers only and does
not replay canceled notifications. Off cancels undispatched prompts as well as
unsent notifications, but does not abort a prompt already accepted by OpenCode.

## Dispatch and recovery semantics

Dispatch one inbound prompt per session at a time, preserving arrival order.
Hold prompts while the session is busy or the adapter is unavailable. Reuse the
latest ordinary user turn's agent/model/variant settings when supported;
otherwise use OpenCode's session defaults. Submit sender identity as metadata
or a separate clearly labeled provenance part, leaving authored text intact.

Generate and persist an OpenCode message ID before dispatch. On uncertain
acknowledgment, reconcile that ID against session messages before resubmission.
Verify actual SDK/server message-ID behavior before claiming replay protection.
If acceptance cannot be determined, hold the prompt for reconciliation rather
than risk executing the instruction twice. Do not promise distributed
exactly-once behavior.

SMTP success is similarly not transactional with SQLite. Retry definite
failures using the same Message-ID. An uncertain SMTP outcome is recorded as
uncertain and surfaced in worker status instead of automatically retransmitted.
This avoids pretending duplicate-free delivery can be guaranteed by SMTP.

Deleted sessions produce an authorized-sender error response and a terminal job
state. Temporary outages retry with bounded exponential backoff. Worker status
reports queue counts, connectivity, and uncertain outcomes. Shutdown releases
connections and leases cleanly. Logs include route/job identifiers and error
categories, not credentials or full message contents.

## Verification and release criteria

- Unit tests for allowlist parsing, thread matching, command grammar, quoted
  reply extraction, HTML sanitization, and effective session policy.
- SQLite tests for restart recovery, UIDVALIDITY changes, duplicate events,
  recipient fan-out, cancellation, and dispatch leases.
- Integration tests with local SMTP/IMAP fixtures exercising TLS modes, formatted
  delivery, genuine replies, ignored senders, automated replies, and reconnects.
- Matching-version OpenCode integration tests for global plugin loading, web UI
  command execution with no LLM turn, completion selection, busy-session queueing,
  message-ID reconciliation, and preserved agent/model settings.
- End-to-end two-project/two-session test proving replies and toggles affect only
  their intended session; include two adapter registrations sharing one worker.
- Type checking and package build. Documentation includes worker startup,
  global plugin installation, environment credentials, TLS settings, command
  usage, supported versions, and restart requirements.

Repository name: `opencode-email-sync`, under authenticated GitHub
account `Sponn`. The user approved public repository visibility.
Create and publish the repository after written-spec approval, implementation
plan review, and execution-method selection. Do not commit credentials or runtime
state. Git commits require explicit user authorization.
