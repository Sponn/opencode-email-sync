# Implementation decisions and final review

## Approved changes and implementation choices

- OpenCode 1.18.34 custom command hooks always start an agent prompt; throwing
  returns a generic server error, and an empty prompt still calls the model.
  The user approved built-in shell-mode controls and identical text in emails.
- The worker identifies a local installation persistently rather than using
  ephemeral OpenCode server ports. This deduplicates shared local session storage
  across overlapping processes. Independent hosts must use separate state.
- Transactional state remains in one focused Store to keep cancellation,
  ingestion, and queue claims atomic. It can be split behind the same interfaces
  if the repository grows.
- Authenticated loopback polling every 500 ms replaces long polling. This avoids
  hanging request lifecycle during plugin disposal at the cost of additional
  loopback requests with many adapters.
- The initial dedicated directory had no existing code or Git branch to protect;
  Git setup was deferred until feasibility passed and commits were authorized.
- Linux `flock` supplies kernel-managed ownership rather than PID-file takeover.
  This adds a Linux/util-linux runtime requirement and avoids double ownership
  during stale-lock races. The lock file is never unlinked while in use.
- Prompt leases have a preparation phase and an atomic committed-dispatch phase.
  Off revokes preparing leases, including across off/on toggles. A dispatch
  authorized at the submission boundary is not aborted by a subsequent off; the
  local worker and remote OpenCode request cannot be one distributed transaction.

## Fresh-context review and regression fixes

The independent final reviewer identified seven important issues. All were
reproduced and addressed in a single fix pass with regression tests:

1. SMTP acknowledgment loss after DATA: a phase observer holds uncertain delivery
   without retaining/emitting transaction text or automatically resending.
2. Wrapped plain-text introductions and nested HTML quotes: structural quote
   removal and multiline recognition keep quoted instructions out of prompts.
3. Toggle races: preparing leases are canceled, and dispatch authorization is
   checked transactionally immediately before submission.
4. Stale PID-lock races: kernel-managed `flock` exclusion replaced pathname
   deletion. Eight concurrent starters reproduce the old double-owner bug; the
   regression verifies single ownership across fifteen waves.
5. Uncertain prompt ordering: unresolved earlier jobs are a per-session barrier;
   definite pre-submission outages remain queued instead of uncertain.
6. Duplicate From fields: raw header count must be exactly one before allowlist
   authorization.
7. Deleted sessions: queued/preparing jobs receive one sender-only terminal error;
   persisted routes remain reachable after offline deletion and are checked using
   the authoritative SDK session endpoint.

Mixed prose/control content was regraded as important because submitting it as
an agent turn would surprise a user trying to stop syncing; the parser now rejects
command-like lines anywhere in mixed content. Historical operations documentation
was corrected to reflect the completed Chromium verification.

Provider-specific deliverability and receiving-server header sanitation cannot
be established by local fixtures. They depend on the configured real mailbox;
the repository documents the trust assumptions for optional DMARC checks.
No review findings remain deferred.

## v0.3.0 permission extension

Permission requests now use a dedicated queue and recipient-scoped thread
bindings, independent of ordinary prompt leases. Notification text includes
allow-once/reject/always commands and explanations in both mail formats. A
decision targets the original request ID and actual target session; subagent
notifications use the root session's title and sync policy.

The pinned v1 SDK lacks a pending-permission list method. Its generated HTTP
methods accept request options, so the adapter overrides only the inventory URL
and retains the existing authenticated/in-process transport. A characterization
test and a password-protected real OpenCode test verify this behavior. Compatibility
with other OpenCode versions must be tested rather than assumed.

OpenCode 1.18.34 rejects shell calls inside busy sessions (HTTP 409). The same
permission command works from an idle session in the same project with an explicit
request ID; permission emails include this instruction. Email decisions themselves
are not affected by the busy-shell limitation.

The independent review found two recovery defects, both reproduced before fixing:
uncertain decisions could lose their recovery flag after a second disconnect,
and incomplete session lookups could falsely expire requests. Durable recovery
state now survives repeated disconnects/restarts, and incomplete inventories are
discarded rather than interpreted as empty. Held permission jobs also appear in
status/resolution interfaces. A base-v0.2-schema migration test verifies existing
policies, baselines, thread mappings, and prompts remain intact.

Final permission checks: 75 tests, 353 assertions, typecheck/build, and a
built-package real paused-session test with 17 assertions. That test exercises
once, reject, always, a subsequent matching action, stale replies, cross-session
shell controls, and child-to-root permission routing.

## Initial publication

The authenticated GitHub token lacks the workflow scope. The user selected
publication with CI as a documentation template, rather than granting another
scope. `docs/ci-workflow.yml.example` can be activated later; all local verification
commands and tests ship in the repository.
