# Configuration

Mail settings live in a separate JSON file, not custom top-level OpenCode fields.
Default location: `$XDG_CONFIG_HOME/opencode-email-sync/config.json`, or
`~/.config/opencode-email-sync/config.json` when XDG_CONFIG_HOME is unset.

## Account and recipients

`account.address` is the sending/receiving mailbox. `account.displayName` is
optional. `recipients` is a nonempty list of email addresses that both receive
answers and may send instructions. The account itself cannot be a recipient.
Notifications are sent individually; replies must come from the recipient of
the referenced notification. Domains are case-insensitive, while local parts
retain their case. Configure the exact From address used by your email client.

Unlisted senders, multiple From addresses, automatic responses, and unknown or
ambiguous threads are ignored. Display names and Reply-To never authorize mail.

## SMTP and IMAP

Each connection requires `host`, `port`, `username`, and `passwordEnv` (the name
of a password environment variable). The worker resolves these environment
variables at startup. They may differ for SMTP and IMAP.

| Setting | Values/default |
| --- | --- |
| `security` | `tls` (default), `starttls`, or explicitly selected `plain` |
| `verifyCertificate` | `true` by default |
| `caFile` | Optional PEM CA certificate path |
| IMAP `mailbox` | `INBOX` |
| IMAP `pollIntervalMs` | `30000`, minimum `100` |

Typical configurations are SMTP 465/IMAP 993 with `tls`, or SMTP 587/IMAP 143
with `starttls`. Required STARTTLS does not downgrade to plaintext. `plain`
disables TLS explicitly, useful for local test servers. `verifyCertificate: false`
can be configured explicitly, but the default validates certificates. Both servers
must support username/password authentication; use provider app passwords when
needed. Paths are resolved relative to the worker's working directory unless
absolute; use absolute `caFile` paths for service installations.

IMAP uses IDLE when supported and periodic reconciliation otherwise. Inbox
history is baselined at first startup. UIDVALIDITY changes trigger rescans with
deduplication. The worker does not delete messages or set unrelated mail as read.

## Worker and state

Optional fields:

```json
{
  "worker": {
    "port": 4197,
    "stateDirectory": "/absolute/path/to/private/email-sync-state"
  },
  "retry": { "initialMs": 1000, "maxMs": 60000 },
  "maxMessageBytes": 1048576
}
```

Default state directory: `$XDG_STATE_HOME/opencode-email-sync` or
`~/.local/state/opencode-email-sync`. It contains a user-only control token,
installation ID, singleton worker lock, and SQLite database. Do not share it
between independent hosts or users. Keep it across restarts: it owns session
overrides, threading, reply deduplication, and queues.

The control service binds only to `127.0.0.1`, authenticates its requests, and
rejects browser-origin requests. The plugin and CLI use its token file. Changing
the worker port or state path requires updating the shared configuration and
restarting the worker and OpenCode processes.

## Optional sender-authentication check

Address allowlisting checks the claimed From address; it alone does not prove
sender identity. Thread IDs are opaque and matched against stored outbound mail.
For receiving servers that prepend authoritative Authentication-Results headers
and remove forged headers bearing their own authserv ID, configure:

```json
{
  "senderAuthentication": {
    "trustedAuthservIds": ["your.receiving.mx.example"]
  }
}
```

This requires the topmost Authentication-Results to come from a configured
receiving-server ID, with `dmarc=pass` and a matching `header.from` domain. Do not
configure arbitrary sender-supplied IDs as trusted. Leave this setting absent
when the receiving server does not offer an authoritative header suitable for
this check. Mail forwarding may change authentication results; test replies
through your actual mailbox route.

## Restart behavior

Recipient/account settings are loaded at worker startup. OpenCode plugin options
and configuration are loaded at OpenCode startup. After configuration changes,
restart the worker and quit/restart OpenCode. Per-session commands take effect
immediately and persist without a restart.
