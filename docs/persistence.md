# Persistence and automatic worker startup

## Rootless setup

After cloning/installing dependencies/building, run:

```sh
bun dist/cli.js install
```

The installer:

- Creates mail configuration and a mode-0600 credential template.
- Registers the built plugin using an absolute file URL in global OpenCode config.
- Preserves existing JSONC comments, settings, and other plugins; repeated
  installation does not duplicate its registration or overwrite credentials.
- Preserves the effective plugin array when global configuration is split across
  legacy `config.json`, `opencode.json`, and `opencode.jsonc`.
- Updates existing configuration symlink targets without replacing the links.
- Records installation ownership in `.email-sync-installation.json` beside the
  mail configuration target, so reinstalling a relocated package replaces its
  old registration, including after the old package is removed.
- Backs up the original OpenCode config to `<config>.before-email-sync` before
  its first edit.
- Initializes private state/token/installation identity files.
- Creates a user-owned launcher at `<mail-config-directory>/bin/opencode-email-sync`.
- Enables `worker.autoStart` when unspecified, preserving explicit `false`.
- Records the installing Bun executable and the absolute state directory.

Available options:

```text
install --config MAIL_CONFIG_PATH
        --opencode-config OPENCODE_JSON_OR_JSONC_PATH
        --state-directory STATE_PATH
        --bun BUN_EXECUTABLE_PATH
```

Default paths follow XDG_CONFIG_HOME and XDG_STATE_HOME, falling back to
`~/.config` and `~/.local/state`. `--bun` can repair a relocated runtime path on
reinstallation. Existing mailbox/account values and credential file contents are
retained. After setup, fill the mail settings/password file and quit/restart
OpenCode.

Existing relative state paths are normalized against the installation command's
working directory. For an older installation, run it from the original worker
directory or supply `--state-directory` with the existing absolute state path.
Predictable destination conflicts, including an unmanaged launcher, are checked
before installation edits existing configuration or creates credential/state files.

## Supervisor lifecycle

`worker.autoStart: true` causes the plugin to start a detached supervisor when
OpenCode initializes a project. A kernel-managed `supervisor.lock` prevents
competing supervisors across projects/processes; `worker.lock` independently
prevents competing workers. The supervisor reuses a healthy existing worker,
waits for usable settings/credentials, and retries after worker exits.

The supervisor is separate from the OpenCode process and can keep receiving mail
when a particular OpenCode window or process exits. A supervised worker is bound
to its supervisor's lifetime. A new container/process that loads the plugin can
recreate the supervisor/worker using the persistent files.

For installer-managed configurations, the plugin recreates its rootless CLI
launcher on startup if it is lost, including with `autoStart: false`.
It adds the launcher directory to each OpenCode shell's PATH. No system-wide
launcher, entrypoint patch, systemd, or root permissions are required.

Outside OpenCode, invoke the absolute launcher path printed by installation, or
add its directory to your own shell PATH. Files without the managed launcher
marker are not overwritten; select another `worker.binDirectory` if that path
belongs to a custom command.

Worker credentials are read only in dedicated worker/supervisor processes. The
plugin never imports password values into OpenCode's environment. Each worker
restart rereads the dotenv file, including rotated credentials. Invalid/missing
settings or credentials produce a waiting message and automatic retries without
printing password values.

## Container volume checklist

Keep all of these on persistent mounts **at the same paths on subsequent starts**:

| Data | Why it must persist |
| --- | --- |
| OpenCode global configuration | Contains the plugin registration |
| Mail configuration and credential file | Contains account settings and password variables |
| Email-sync state directory | Contains policies, mail threads, deduplication, queues, and identity |
| Installed package (`dist` and required dependencies) | Contains the plugin and worker CLI referenced by registration |
| Bun executable | Runs the worker; its recorded path must remain executable |
| OpenCode session storage | Preserves the sessions that email threads reference |

For example, clone the package and install Bun under a persistent home volume,
set XDG_CONFIG_HOME/XDG_STATE_HOME/XDG_DATA_HOME to mounted locations, then run the
installer. Persisting configuration alone cannot preserve a package or runtime
that disappears when an image is replaced. The base image must continue to supply
Linux `flock` and the application's normal runtime/system dependencies.

## Status, updates, and manual management

```sh
/absolute/path/to/mail-config/bin/opencode-email-sync status
```

Supervisor/worker output is in `<state-directory>/worker.log`. The current managed
PIDs are recorded in `<state-directory>/supervisor.json`; this is operational
metadata, not the lock itself. Kernel locks are released after a crash, and their
files are intentionally retained.

Mail connection settings and credentials are reloaded when the worker restarts.
For a package, runtime, state-path, or plugin-option change, restart the container,
or stop the recorded supervisor PID with SIGTERM before quitting/restarting
OpenCode. Stopping a supervisor terminates only its owned child worker; a healthy
worker managed externally is reused rather than stopped. Moving the state path
requires preserving/copying its database and identity files yourself.

To manage the worker independently, set `worker.autoStart` to false and use
`start` or a systemd service as described in [operations](operations.md). The
credential-file option also works with manual startup. Changing autostart to
false takes effect after the existing supervisor is stopped and OpenCode restarts.
