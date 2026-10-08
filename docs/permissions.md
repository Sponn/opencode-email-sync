# Permission handling by email

## Notification and reply

Permission requests pause OpenCode before a final answer exists. The plugin
subscribes to permission events and reconciles the pending permission inventory
on its poll cycle, including requests already waiting when it loads. Each synced
request generates one notification per configured recipient, with a subject:

```text
[Project] Permission required: Session title [session-id]
```

The body contains the request ID, permission name, affected patterns, OpenCode
metadata, actual target session ID, and always-approval patterns. Both HTML and
plain-text versions explain all three available commands:

```text
!opencode-email-sync permission once
!opencode-email-sync permission reject
!opencode-email-sync permission always
```

`once` permits this request. `reject` denies it. `always` passes OpenCode's own
always response, permitting matching actions with the same scope as its UI. The
plugin does not create a separate blanket permission rule or interpret prose
such as “yes” as approval.

Send one command alone as a reply to the specific notification. Quoted email
history/signatures are handled by the existing reply parser. Sender allowlisting,
recipient-specific threading, and optional receiving-server authentication checks
apply exactly as they do to ordinary instructions. Normal conversation text in a
permission thread receives usage guidance rather than becoming an agent prompt.

Subagent requests use the root session's notification policy/title, with the
original child target retained for OpenCode's reply API. Multiple requests keep
separate threads so replying to an older request never approves a new one.

## Independent dispatch

Permission decisions use a dedicated durable queue independent of ordinary
prompts. They are dispatched even when the agent is busy waiting on a permission
or the email-origin prompt itself is still running. Immediately before replying,
the adapter checks that the exact request and target session remain pending and
obtains transactional dispatch authorization from the worker.

The first accepted decision closes the request. If another configured recipient
or the web UI answered first, later replies receive an already-answered/expired
result. Duplicate mail, events, or overlapping adapters cannot create an automatic
second decision. An approval does not insert a user turn or use a language model.

The worker emails a confirmation to the decision sender after OpenCode accepts
the response. Offline adapters hold queued decisions until reconnecting. If an
API acknowledgment is lost, the worker does not blindly replay the decision;
uncertain outcomes are held for checking in OpenCode. A request no longer pending
is treated as stale, not evidence that a particular old reply was approved.

Worker `status` shows held permission job IDs in its uncertainty list. The existing
`resolve --job ID --action retry|cancel` command also supports permission jobs.
`retry` requests reconciliation only; it does not resubmit an approval while that
request is still pending. `cancel` releases the held decision without claiming
that the original remote outcome is known. Check the permission UI first, then
send a fresh exact decision if appropriate.

## Session toggles

Turning email sync off cancels unsent permission notifications and undispatched
decisions. It does not answer the request, abort a committed decision, or bypass
the permission gate. Use OpenCode's UI while sync is off, or re-enable syncing by
replying with `!opencode-email-sync session on`. If a request arose while sync was
off and has not been notified, reconciliation sends it once sync is on.

## Shell-mode commands

The same permission command syntax is available in the CLI. OpenCode 1.18.34
rejects shell execution inside a busy session. Open an idle session in the same
project and append the request ID shown in the notification:

```text
!opencode-email-sync permission once per_example_request_id
!opencode-email-sync permission reject per_example_request_id
!opencode-email-sync permission always per_example_request_id
```

The worker resolves explicit IDs only within that installation, project, and
directory. An email still requires the matching permission thread even if an ID
is present. Without an explicit ID, CLI decisions are limited to exactly one
pending permission in the current session. Multiple pending requests require an
ID; the plugin never chooses one arbitrarily.

## Upgrade

After rebuilding/updating the package, restart the worker and quit/restart
OpenCode (or restart the container) so both sides load the permission handlers.
SQLite adds permission tables and delivery-thread bindings automatically while
preserving previous session policies, thread mappings, and queued instructions.
Interactive question-tool selections remain separate from permissions and are
not covered by this feature.
