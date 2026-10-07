# OpenCode Email Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a public OpenCode extension that emails completed answers and routes authorized replies and per-session toggle commands across parallel projects.

**Architecture:** A globally loaded OpenCode plugin communicates with one authenticated loopback mail worker. The worker owns SMTP/IMAP connections and SQLite queues; plugins own SDK access and execute session-scoped jobs. Session sync defaults on, with durable overrides.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, matching-version `@opencode-ai/plugin` and `@opencode-ai/sdk`, Nodemailer, ImapFlow, mailparser, marked, sanitize-html, and Bun's test runner. Use browser automation only for the web UI integration test.

**Spec:** `docs/superpowers/specs/2026-10-07-email-sync-design.md`

**Approved execution amendment:** Use `!opencode-email-sync session on|off|status`
in both the web UI and email. Replace custom-command hooks with `shell.env`
route/config injection and CLI session controls. Email parses only this exact
control grammar and never executes arbitrary shell text. Task 1 implements the
shared parser and shell context after the completed live-server feasibility
probe. Web UI shell execution records are permitted but not answer notifications.
All earlier `/email` and no-assistant-record custom-command assertions are
superseded by this user-approved amendment; no LLM call remains required.

## Global Constraints

- Sync defaults to **on for every existing and new session**.
- Support a worker and OpenCode instances on the same host, sharing one OS user and one configuration/state directory.
- Verify installed OpenCode 1.18.34 with matching plugin/SDK types before advertising support.
- `/email on`, `/email off`, and `/email status` must work in the web UI and email replies without an agent-interpreted toggle.
- One nonempty address list defines both notification recipients and authorized instruction senders; send separate messages to recipients.
- Subjects use `[Project] Session title [full-session-id]`.
- No historical notification flood on installation; re-enabling does not replay canceled notifications.
- Do not promise distributed exactly-once behavior or duplicate-free SMTP delivery.
- Do not commit credentials or runtime state. Git commits require explicit user authorization; repository creation/publishing is authorized, but clarify commit permission before any commit.
- Public repository: `Sponn/opencode-email-sync`. Create it only after plan approval and execution-method selection.

## Review Focus

1. Two simultaneous adapters for the same persisted session must neither double-email nor double-dispatch (Tasks 2, 3, 8).
2. Mail clients rewriting subjects, wrapping quoted text, or omitting plain-text MIME parts must preserve routing and extract only authored text (Tasks 4, 5).
3. A toggle racing with queued sends or leased prompts must cancel only undispatched work and must not abort an accepted prompt (Tasks 2, 7, 8).
4. A worker crash after remote acceptance but before local acknowledgment must hold/reconcile uncertain work rather than replay it blindly (Tasks 6, 8).
5. First registration during an active turn must baseline historical completed answers without losing the active turn's eventual answer (Tasks 3, 8).

## File map

- `package.json`, `tsconfig.json`, `.gitignore`: package exports, commands, strict typing, generated-file exclusions.
- `src/index.ts`: the sole exported OpenCode plugin entry; keep helpers in other modules to avoid accidental plugin discovery.
- `src/core/types.ts`, `config.ts`, `commands.ts`: shared contracts, validated configuration, command grammar.
- `src/state/database.ts`, `sessions.ts`, `mail.ts`, `jobs.ts`: schema/migrations and focused transactional repositories.
- `src/worker/server.ts`, `protocol.ts`, `client.ts`, `lock.ts`: authenticated control service, typed messages, adapter client, singleton ownership.
- `src/mail/render.ts`, `parse.ts`, `authorize.ts`, `smtp.ts`, `imap.ts`: independent mail boundary modules.
- `src/opencode/commands.ts`, `answers.ts`, `dispatch.ts`, `adapter.ts`: OpenCode-specific lifecycle and SDK integration.
- `src/cli.ts`: worker initialization, start, status, and uncertain-job resolution commands.
- `test/fixtures/`: local mail servers, MIME samples, disposable OpenCode configuration, browser helpers.
- `test/core/`, `test/state/`, `test/worker/`, `test/mail/`, `test/opencode/`, `test/e2e/`: tests owning the corresponding contracts.
- `examples/email-sync.json`, `examples/opencode.json`, `README.md`, `docs/configuration.md`, `docs/operations.md`: installation and operations documentation.

Use explicit exported types rather than untyped protocol payloads. IDs and timestamps are strings and epoch milliseconds respectively. `Route` contains `instanceId`, `projectId`, `directory`, and `sessionId`; `routeKey(route)` produces its stable canonical encoding. SDK types stay at the adapter boundary.

## Task 1: Prove deterministic OpenCode command support

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `src/core/commands.ts`, `src/opencode/commands.ts`, `test/core/commands.test.ts`, `test/opencode/commands.integration.test.ts`, `test/fixtures/opencode.ts`.

**Interfaces:** Produce `parseCommand(text: string): { kind: 'command'; action: 'on' | 'off' | 'status' } | { kind: 'invalid' } | { kind: 'text'; text: string }` and `createCommandHooks(control: (sessionId: string, action: 'on' | 'off' | 'status') => Promise<string>): Pick<Hooks, 'config' | 'command.execute.before'>`.

- [ ] Inspect the installed matching-version command execution source and web UI command submission path; record the supported short-circuit and visible-result mechanism in `docs/operations.md`. Stop and request a design adjustment if no reliable mechanism exists.
- [ ] Add package/test/typecheck/build scripts and pinned matching-version SDK/plugin dependencies; package helpers are not exported as plugin entry points.
- [ ] Write tests for exact commands, mixed prose rejection, case/whitespace, and bare `/email` status. Core assertion: `expect(parseCommand(' /EMAIL OFF ')).toEqual({ kind: 'command', action: 'off' })`.
- [ ] Write a real disposable-server integration test invoking the command from the web UI, checking policy change, visible confirmation, and no new assistant/LLM turn; include malformed arguments.
- [ ] Run `bun test test/core/commands.test.ts test/opencode/commands.integration.test.ts`; confirm missing implementation causes the relevant failures.
- [ ] Implement command parsing and matching-version hooks using the proved mechanism; keep command-result messages distinguishable from answers.
- [ ] Run the same tests and `bun run typecheck`; both must pass before proceeding. Record whether error-shaped feedback is unavoidable and obtain approval if that changes the promised UX.

## Task 2: Durable routes, overrides, and queues

**Files:** Create `src/core/types.ts`, `src/state/database.ts`, `src/state/sessions.ts`, `src/state/mail.ts`, `src/state/jobs.ts`, `test/state/database.test.ts`, `test/state/policy.test.ts`, `test/state/jobs.test.ts`.

**Interfaces:** Produce `openStore(path: string): Store`, `routeKey(route: Route): string`, `Store.getPolicy(route): boolean`, `Store.setPolicy(route, enabled): void`, `Store.recordAnswer(answer: Answer): void`, `Store.recordIncoming(mail: IncomingMail): boolean`, `Store.enqueuePrompt(prompt: QueuedPrompt): void`, and `Store.leasePrompt(route, owner, now): PromptLease | null`. Define all named payload types here and use them in later tasks. `Answer` includes route, user-turn ID, ordered visible text, project label, session title, and completion time. Delivery/prompt states distinguish queued, leased, accepted/sent, canceled, uncertain, and terminal failure.

Also define `ThreadRecord` (route, recipient, Message-ID, opaque token), `Baseline` (completed user-turn/message IDs), and `Store.lookupThread(references: string[]): ThreadRecord | null`, `Store.getBaseline(route): Baseline`, and `Store.saveBaseline(route, baseline): void`. Store methods for delivery selection/results, prompt acknowledgment, and checkpoints belong to their focused repositories and must be typed before their consumers are implemented.

- [ ] Write temporary-SQLite tests for absent override defaulting on, persistence after reopen, transaction rollback, per-recipient answer uniqueness, incoming uniqueness, lease exclusivity/expiry, and two routes with identical titles.
- [ ] Add the cancellation-race test: off cancels queued work; a prompt already accepted remains accepted. Returning on never revives canceled rows.
- [ ] Run `bun test test/state`; confirm failures from missing repositories.
- [ ] Implement migrations, canonical route keys, baseline records, per-recipient delivery rows, inbound checkpoints, and transactional repositories; filesystem state permissions are user-only.
- [ ] Run `bun test test/state` and `bun run typecheck`; expect passing persistence and transaction assertions.

## Task 3: Validated configuration and a shared worker control plane

**Files:** Create `src/core/config.ts`, `src/worker/protocol.ts`, `src/worker/server.ts`, `src/worker/client.ts`, `src/worker/lock.ts`, `test/core/config.test.ts`, `test/worker/server.test.ts`, `test/worker/lock.test.ts`.

**Interfaces:** Produce `loadConfig(path: string): Config`, `resolveCredentials(config: Config, env: Record<string, string | undefined>): MailCredentials`, `startControlServer(config: Config, store: Store): Promise<WorkerHandle>`, and `createWorkerClient(config: Config): WorkerClient`. Only the worker resolves credentials; plugins can connect without SMTP/IMAP password environment variables. `WorkerClient` exposes `register(registration): Promise<RegistrationResult>`, `heartbeat(adapterId): Promise<void>`, `recordAnswer(answer): Promise<void>`, `command(route, action): Promise<PolicyResult>`, `poll(adapterId, signal): Promise<AdapterJob[]>`, and `ack(jobId, result): Promise<void>`. Define registration/job/result discriminated unions in `protocol.ts`; reject malformed requests at runtime.

`Config` fields: `account.address`, optional `account.displayName`, `recipients: string[]`, `smtp`/`imap` connection objects, `worker.port` (default 4197), `worker.stateDirectory` (default `$XDG_STATE_HOME/opencode-email-sync`, falling back to `~/.local/state/opencode-email-sync`), `retry.initialMs` (1000), `retry.maxMs` (60000), `maxMessageBytes` (1048576), and optional `senderAuthentication.trustedAuthservIds`. Connection fields are `host`, `port`, `username`, `passwordEnv`, `security: 'tls' | 'starttls' | 'plain'` (default `tls`), `verifyCertificate` (default true), and optional `caFile`. IMAP additionally has `mailbox` (default `INBOX`) and `pollIntervalMs` (default 30000). Required TLS/STARTTLS modes never downgrade. A nonempty trusted-authserv list enables the aligned-DMARC requirement. Default config path: `$XDG_CONFIG_HOME/opencode-email-sync/config.json`, falling back to `~/.config/opencode-email-sync/config.json`.

- [ ] Write tests for missing credentials, invalid ports, empty recipients, explicitly selected plaintext, required STARTTLS, certificate settings, unauthorized requests, non-loopback binding, stale lock recovery, and live-worker lock rejection.
- [ ] Add duplicate-registration tests: one live dispatch lease per route, stable restart identity, and held jobs on ambiguous routing. Test long-poll cancellation and expired adapter heartbeats.
- [ ] Run `bun test test/core/config.test.ts test/worker`; confirm missing functionality fails.
- [ ] Implement config validation, environment secret resolution, atomic token/identity creation, singleton ownership, bounded authenticated HTTP requests, registrations, and polling. Use persisted history baseline rather than resetting it on reconnect; the first baseline includes completed answers only.
- [ ] Run those tests and typecheck; verify logs/status never expose resolved credentials or the control token.

## Task 4: Readable outbound messages

**Files:** Create `src/mail/render.ts`, `test/mail/render.test.ts`, `test/fixtures/mime/`.

**Interfaces:** Produce `renderAnswer(answer: Answer, recipient: string, messageId: string): RenderedMail`; `RenderedMail` contains sanitized subject, text, HTML, recipient, Message-ID, and thread headers. Produce `renderControlReply(context: ReplyContext, text: string): RenderedMail` for non-agent confirmations/errors.

Define `ReplyContext` here with route, project label, session title, authorized sender, original Message-ID, and reply Message-ID. Rendering does not generate or persist identities: orchestration assigns them before transport attempts.

- [ ] Write assertions for `[Project] Session title [full-session-id]`, preserved ID after title truncation, header injection removal, separate recipients, code blocks, headings, tables, links, plain-text content, and footer command usage.
- [ ] Add hostile Markdown tests for executable HTML, event-handler attributes, unsafe URLs, and external image loading; assert output omits them without dropping ordinary answer text.
- [ ] Run `bun test test/mail/render.test.ts`; confirm missing rendering fails.
- [ ] Implement Markdown rendering and sanitization with inline email styles; use stable random Message-IDs containing opaque thread tokens, mapping each recipient message to its route in storage.
- [ ] Run rendering tests and typecheck; inspect one fixture's HTML/plain-text MIME output for readability.

## Task 5: Authorized reply parsing and threading

**Files:** Create `src/mail/parse.ts`, `src/mail/authorize.ts`, `test/mail/parse.test.ts`, `test/mail/authorize.test.ts`, `test/fixtures/mime/replies.ts`.

**Interfaces:** Produce `parseIncoming(raw: Uint8Array, maxBytes: number): Promise<ParsedMail>`, `authorizeReply(mail: ParsedMail, config: Config, thread: ThreadRecord | null): AuthorizationResult`, and `extractReply(mail: ParsedMail): { kind: 'text'; text: string } | { kind: 'empty' | 'ambiguous' }`. Define parsed headers/body/address fields explicitly; `ThreadRecord` comes from Task 2.

- [ ] Write MIME tests for plain-text and HTML-only replies, Gmail/Outlook-style quoting, signatures, explicit `--- end reply ---` delimiters, empty bodies, attachments, oversized bodies, and malformed MIME.
- [ ] Write authorization tests for exact allowlist matching, domain normalization, multiple From addresses, spoofed display names/Reply-To, removed recipients, rewritten subjects, unknown References, and conflicting thread mappings. Threading must not authorize a bare session ID in the subject.
- [ ] Add tests for automated responses, worker-origin mail, and trusted-authserv verification including forged/untrusted Authentication-Results headers and required aligned DMARC pass.
- [ ] Run `bun test test/mail/parse.test.ts test/mail/authorize.test.ts`; confirm expected failures.
- [ ] Implement MIME parsing, recognized quote removal, explicit delimiter behavior, trusted-header evaluation, and discriminated rejection reasons. Ambiguous extraction triggers authorized-sender guidance, never an agent prompt.
- [ ] Run the same tests and typecheck; ensure rejected senders receive no confirmation or instruction response.

## Task 6: SMTP/IMAP transport and recovery

**Files:** Create `src/mail/smtp.ts`, `src/mail/imap.ts`, `test/mail/transport.integration.test.ts`, `test/mail/checkpoints.test.ts`, `test/fixtures/mail-server.ts`.

**Interfaces:** Produce `createSmtp(config: Config, credentials: MailCredentials): MailSender` with `send(mail: RenderedMail): Promise<'sent' | 'uncertain'>` (definite failures throw typed retryable/permanent errors), and `startImap(config: Config, credentials: MailCredentials, store: Store, ingest: (raw: Uint8Array, identity: MailIdentity) => Promise<void>, signal: AbortSignal): Promise<void>`. Define `MailIdentity` as mailbox, UIDVALIDITY, UID, and parsed deduplication identity.

Both transport constructors also receive resolved `MailCredentials` explicitly; credentials are never added to the persisted `Config` object. `MailSender` exposes `close(): Promise<void>` in addition to `send`. Fixtures supply test-only credentials through the same interface.

- [ ] Build isolated local mail fixtures with implicit TLS, STARTTLS, invalid-cert, capability/IDLE, UID reset, and disconnect controls. Keep fixtures confined to test ports and temporary directories.
- [ ] Write tests for TLS requirements/no downgrade, CA verification, credential redaction, IDLE/poll fallback, reconnect backoff, mailbox first-start baseline, commit-before-checkpoint, UIDVALIDITY rescans, and duplicated Message-IDs/content.
- [ ] Add SMTP tests for definite failures versus uncertain acknowledgment; assert uncertain sends are held with stable Message-ID instead of automatically retransmitted.
- [ ] Run `bun test test/mail/transport.integration.test.ts test/mail/checkpoints.test.ts`; confirm failures.
- [ ] Implement Nodemailer and ImapFlow adapters, bounded fetch/parse behavior, checkpoint transactions, error classification, and clean shutdown without deleting or changing unrelated mail.
- [ ] Run transport/checkpoint tests and typecheck; all isolated fixture scenarios must pass.

## Task 7: Mail orchestration and worker CLI

**Files:** Create `src/worker/mail-loop.ts`, `src/cli.ts`, `test/worker/mail-loop.test.ts`, `test/worker/cli.test.ts`.

**Interfaces:** Produce `runMailLoop(config: Config, store: Store, sender: MailSender, signal: AbortSignal): Promise<void>` and `ingestReply(raw: Uint8Array, identity: MailIdentity, deps: IngestDependencies): Promise<void>`. CLI commands: `init --config <path>`, `start --config <path>`, `status --config <path>`, and `resolve --config <path> --job <id> --action retry|cancel`; resolution is explicit for uncertain outcomes, not automatic.

- [ ] Write tests for one recipient-specific delivery per answer, retryable failure backoff, no send after off, control confirmations while off, ignored ordinary replies while off, and no control-confirmation ingestion loop.
- [ ] Test authorized deleted-session responses, queue/status counts, unavailable worker diagnostics, bounded graceful shutdown, and explicit uncertain-job resolution. Every test uses a temporary state/config directory.
- [ ] Run `bun test test/worker/mail-loop.test.ts test/worker/cli.test.ts`; confirm failures.
- [ ] Compose transport/parsing/storage modules, worker lifecycle, command handling, and status reporting. Recheck policy at the send/dispatch boundary; send control responses only to the authorized sender.
- [ ] Run worker tests and typecheck; verify outage and restart tests retain queued work.

## Task 8: OpenCode answer detection and inbound prompt dispatch

**Files:** Create `src/index.ts`, `src/opencode/answers.ts`, `src/opencode/dispatch.ts`, `src/opencode/adapter.ts`, `test/opencode/answers.test.ts`, `test/opencode/dispatch.test.ts`, `test/opencode/adapter.integration.test.ts`.

**Interfaces:** Produce `collectAnswer(messages: SessionMessages, route: Route, baseline: Baseline): Answer | null`, `dispatchPrompt(client: OpenCodeClient, lease: PromptLease): Promise<DispatchResult>`, and `createAdapter(input: PluginInput, config: Config): Promise<Hooks>`. Use SDK-derived types inside these files; cross-boundary payloads use Task 2 and Task 3 contracts. `src/index.ts` exports only the plugin function.

- [ ] Write tests for visible answer assembly, tool/reasoning/compaction exclusion, internal child-session exclusion, duplicate idle events, initial baseline, and an active turn completing after first registration.
- [ ] Write dispatch tests for busy-session ordering, offline queues, session deletion, on/off races, and preserving latest agent/model/variant. Verify generated message-ID acceptance with the actual SDK/server, not just a mock.
- [ ] Add acknowledgment-loss reconciliation: when a generated message ID is present in session history, do not submit again; when absence cannot be determined, hold the lease as uncertain. Test two adapters polling the same route.
- [ ] Run `bun test test/opencode`; confirm missing adapter logic fails.
- [ ] Implement registration/heartbeats, asynchronous event ingestion, reconnect reconciliation from durable baselines, job polling, prompt execution/reconciliation, deterministic command integration from Task 1, and unload cleanup. Normalize the project/directory identity consistently with storage.
- [ ] Run all OpenCode tests and typecheck. The actual-server tests must prove web UI visibility, no LLM turn for control commands, and prompt replay safeguards before claims are documented.

## Task 9: Multi-project end-to-end validation and installable documentation

**Files:** Create `test/e2e/email-sync.test.ts`, `examples/email-sync.json`, `examples/opencode.json`, `README.md`, `docs/configuration.md`, `docs/operations.md`; update `package.json` exports/build scripts.

**Interfaces:** Built package exports its plugin at the package root and a worker executable named `opencode-email-sync`. Document exact configuration field names from Task 3, CLI commands from Task 7, and verified supported OpenCode/runtime versions.

- [ ] Write the end-to-end test: two projects, two user-facing sessions, multiple adapters, one mailbox, two recipients. Assert each new answer is delivered once per recipient, replies target the correct session, and off/status/on works through both web UI and email.
- [ ] Include restart recovery, busy-session queueing, ignored unlisted sender, no historical flood, and no replay on re-enable. Use a deterministic local model fixture for agent turns; do not require personal mail credentials.
- [ ] Run `bun test test/e2e`; confirm failure if the integration does not satisfy these assertions.
- [ ] Finish package build/exports and examples; validate the OpenCode example against `https://opencode.ai/config.json`. Document global plugin loading, manual worker startup and optional OS service setup, credential variables, TLS modes, sender authentication options, supported reply formats, worker status/recovery, and the requirement to quit and restart OpenCode after installation/config changes.
- [ ] Run `bun test`, `bun run typecheck`, and `bun run build`; require all to pass. Smoke-test the built CLI's help/status and installation in a disposable OpenCode config directory. Do not modify the user's active OpenCode configuration.

## Task 10: Review and public GitHub publication

**Files:** Review all source, tests, docs, package metadata, generated artifacts, and `.gitignore`.

- [ ] Review the complete implementation against the approved spec and the five Review Focus scenarios; fix any issues and rerun their owning checks.
- [ ] Confirm commit authorization with the user before any Git commit. Initialize the local repository on `main` at execution time and inspect status/diff/log before authorized commits; stage only intended files. No mail secrets, local state, logs, or installed dependencies enter Git.
- [ ] Check `gh repo view Sponn/opencode-email-sync` to avoid overwriting an existing repository. Create the public repository with `gh repo create Sponn/opencode-email-sync --public --source /data/home/repositories/opencode-email-sync --remote origin` only if it does not exist.
- [ ] Push the verified, authorized commits to `origin main`. Repository creation/push is requested; npm publication is not part of this task.
- [ ] Verify the public repository URL, visibility, default branch, and pushed files using `gh repo view` and the remote commit SHA. Return the repository link, installation instructions, test results, and any specifically verified limitations.

## Execution handoff

Before implementation, the user reviews this written plan and selects native or subagent-driven execution. Native execution is recommended: the interfaces form a sequential dependency chain and the command feasibility gate must be resolved before the mail implementation proceeds. A fresh final reviewer is permitted only when the selected method authorizes delegation. No product scaffolding, dependency installation, repository creation, or implementation occurs before this handoff is approved.
