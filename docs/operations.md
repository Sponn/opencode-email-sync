# Operations

## Running the worker

Run `opencode-email-sync start --config /absolute/path/config.json` in a persistent
terminal or user service. The worker must run under the same OS user as OpenCode
and read the same configuration/state directory. `init` creates its token and
installation identity without contacting mail servers.

For a Linux user service, place a unit at
`~/.config/systemd/user/opencode-email-sync.service`, adapting the absolute paths:

```ini
[Unit]
Description=OpenCode email sync
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/opencode-email-sync/worker.env
ExecStart=/absolute/path/to/bun /absolute/path/to/opencode-email-sync/dist/cli.js start --config /absolute/path/to/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The private environment file supplies the configured password variables. Keep
its permissions user-only. Enable the service with `systemctl --user daemon-reload`
and `systemctl --user enable --now opencode-email-sync`. Ensure OpenCode's own
environment includes Bun's bin directory so its shell can find the linked CLI.

## Status and uncertainty

```sh
opencode-email-sync status --config /absolute/path/config.json
```

Status includes mail connectivity, live adapters, queue counts by state, and
uncertain job IDs. Normal mail failures back off and retry. SMTP disconnects
after DATA may mean the server accepted mail; these deliveries are held as
uncertain instead of resent automatically. Worker crashes during sends have the
same treatment. Check the sent mail/server state before requesting a retry:

```sh
opencode-email-sync resolve --job JOB_ID --action retry --config /absolute/path/config.json
opencode-email-sync resolve --job JOB_ID --action cancel --config /absolute/path/config.json
```

Prompt acceptance is reconciled with a persisted OpenCode message ID. Existing
IDs are acknowledged without resubmission. Missing/unknown uncertain prompt
outcomes are held; `retry` requests another reconciliation, not blind execution.
If acceptance cannot be established, cancel the job and submit a fresh reply
after checking the session. This intentionally does not claim exactly-once
distributed execution.

Session policies, mail thread mappings, accepted incoming identities, and queues
survive restarts. A worker restart does not reset session overrides. Sessions
busy with an agent turn wait before dispatching their next queued email reply.
An explicit off command cancels queued/preparing leases and does not interrupt
an agent turn already committed for submission. The worker atomically authorizes
the dispatch immediately before the plugin submits it.

## Troubleshooting

- **CLI not found in OpenCode:** add Bun's global bin directory to the environment
  of the OpenCode process/service, or invoke the built CLI with absolute paths.
- **Worker unavailable:** initialize/start it using the shared config. Mail
  failures do not block ordinary OpenCode shell commands.
- **No notification for older answers:** installation establishes a historical
  baseline; only newly completed answers are sent.
- **No response to email:** check sender address, thread references, sync state,
  mailbox connectivity, and any configured Authentication-Results requirement.
- **Command feedback hidden:** expand the shell execution record in the web UI.
- **Configuration changed:** restart the worker and quit/restart OpenCode.

Only one worker can own a state directory. Linux `flock` holds a kernel-managed
advisory lock for its lifetime and releases it after a crash. The persistent lock
file is intentionally retained; never unlink it while a worker is running.
Do not remove the SQLite database or installation/token files to solve a
connectivity issue.

## OpenCode integration feasibility

## Verified on OpenCode 1.18.34

The original design's clean `/email` custom-command interception is not supported
by the inspected command execution path. `command.execute.before` may mutate
prompt parts, but its return value cannot suppress the following prompt or return
a successful local-command result. Throwing stops execution, but becomes a
generic HTTP 500 response.

A disposable real-server characterization test confirmed:

- The plugin is loaded and its `email` command is registered.
- The `command.execute.before` hook is reached.
- Throwing a confirmation produces HTTP 500 with `Unexpected server error`,
  rather than the confirmation text.
- No session messages are added by the rejected command.
- The built-in shell endpoint returns HTTP 200 and invokes `shell.env` with the
  current session ID. That ID is available to a local CLI command through an
  injected environment variable.

The matching-version web UI source displays failed custom commands as an error
toast and restores the input. It enters shell mode when `!` is typed at cursor
position zero and displays shell execution output. The browser behavior was
inspected in source; the endpoints were exercised against a live disposable
server. Subsequent `test/e2e/opencode.test.ts` browser automation also verified
shell-mode submission and visible status output without a model call.

Probe command:

```sh
/data/home/.bun/bin/bun test /tmp/opencode/email-command-probe/probe.test.ts
```

Initial result: 1 pass, 0 failures, 10 assertions. The fixture uses a dummy local
provider with no real credentials. All probe
sessions/configuration are isolated from the user's running installation.

### Empty-prompt follow-up

The user suggested clearing the prompt instead of throwing. A follow-up live
server probe mutates `output.parts.length = 0` in `command.execute.before`.
OpenCode persists a user message with zero parts, enters the agent loop, creates
an assistant message, and makes an HTTP request to the dummy local model's
`/v1/chat/completions` endpoint with only a system message. The local fixture
returns an intentional HTTP 400 to avoid generating any response. The command
endpoint nevertheless responds HTTP 200 with the resulting agent error state.

Latest result: 1 pass, 0 failures, 15 assertions. No real provider is contacted;
the only model request is to the disposable loopback fixture. Empty prompt parts
therefore do not suppress model execution. The prompt API supports `noReply`,
but the command handler does not pass it and the command hook cannot set it.

## Approved adjustment

Use the existing shell-mode UI for deterministic controls:

```text
!opencode-email-sync session on
!opencode-email-sync session off
!opencode-email-sync session status
```

The plugin's `shell.env` hook supplies the current session route and configuration
path, so the CLI needs no manually copied session ID. It contacts the worker and
prints the result as shell output. This creates OpenCode's normal shell execution
record, not an LLM-generated response. The notification adapter excludes these
control records from answer notifications. Email uses exactly the same
`!opencode-email-sync session on`, `off`, and `status` commands; the worker parses
them directly and never invokes a shell for email controls.

The specification and implementation plan include this approved amendment.
