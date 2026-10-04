# Host scheduling

Run the exporter through `docker exec` inside the existing Actual server container. Examples use a container named `actual-server` and an installation at `/data/actual-sheet-sync`; substitute your own values.

Each invocation is a one-shot process. It exits after syncing or reporting an error. Schedule no more than one installation against a spreadsheet. A filesystem lock prevents overlapping runs sharing that installation's `state/` directory; it is not a distributed lock across separate installations.

## Linux and other POSIX hosts: cron

Find the Docker executable with `command -v docker`. Use its absolute path because schedulers usually have a limited `PATH`. Add a line to the task account's crontab; for example, if Docker is at `/usr/bin/docker`, run at minute 15 every hour:

```cron
15 * * * * /usr/bin/docker exec --workdir /data/actual-sheet-sync actual-server node sync.mjs sync
```

Configure cron mail or redirect output to a private, rotated log using your host's normal monitoring. Do not discard failures. The schedule follows the host's timezone; the balance snapshot date follows `config.json`'s `timezone`.

The task account must be able to run the same command interactively. If you use rootless Docker or a non-default Docker context, configure that same context and environment for the scheduled account. Do not put credentials in the command line.

## Linux: systemd timer

Create a service and timer using the templates in [examples/](examples/). Replace the Docker path, container name, and working directory in the service. Install them as user units under `~/.config/systemd/user/`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now actual-sheet-sync.timer
systemctl --user list-timers actual-sheet-sync.timer
journalctl --user -u actual-sheet-sync.service
```

User services require a running user manager; configure lingering if your host requires tasks to continue after logout. Docker and the Actual container must already be available. A missed run is retried on the next timer event. Disable with `systemctl --user disable --now actual-sheet-sync.timer`.

## macOS: launchd

Copy [examples/local.actual-sheet-sync.plist](examples/local.actual-sheet-sync.plist) to `~/Library/LaunchAgents/`. Replace `/ABSOLUTE/PATH/TO/docker` with the result of `command -v docker`, and adjust the container and installation path. The template starts a run every hour while the user session is active:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.actual-sheet-sync.plist"
launchctl kickstart "gui/$(id -u)/local.actual-sheet-sync"
launchctl print "gui/$(id -u)/local.actual-sheet-sync"
```

Check `last exit code` and the sheet's `Actual_Status`. For retained stdout/stderr, add `StandardOutPath` and `StandardErrorPath` pointing to private files in an existing user-owned log directory. Docker Desktop must be running and its context available to the logged-in task account. Sleeping or logged-out machines do not provide continuous scheduling.

Disable with:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.actual-sheet-sync.plist"
```

## Windows: Task Scheduler

Use Docker Desktop in Linux-container mode. First verify the sync command in PowerShell under the account that will run the task. Find Docker's executable:

```powershell
(Get-Command docker.exe).Source
```

Create a task with the following settings:

| Setting | Value |
| --- | --- |
| Program/script | The full path returned above, without arguments. |
| Add arguments | `exec --workdir /data/actual-sheet-sync actual-server node sync.mjs sync` |
| Trigger | Your chosen interval, such as hourly. |
| If the task is already running | Do not start a new instance. |
| Security options | Use the same account and Docker context that passed the manual test. With Docker Desktop, use “Run only when user is logged on” unless you have separately configured unattended Docker availability. |

Run the task manually and check **Last Run Result** as well as `Actual_Status` in the spreadsheet. Docker's exit status propagates from the exporter. Task Scheduler does not retain application stdout/stderr by default; if you need logs, use a local wrapper that redirects output to a private file and exits with Docker's exit code. Disable the task to stop scheduled exports.

## Other schedulers and recovery

Any scheduler that can run the Docker CLI and preserve its exit code can use the same invocation. It does not need Node installed on the host. Avoid interactive flags and overlapping tasks.

Exit code `0` means success, `7` means another run owns the lock, `4` means a forced deadline, and `1` means another failure. Forced container termination may have a different Docker exit code. A crash can leave `state/*.lock` and `state/cache-*`; confirm all exporter processes have stopped before removing stale state. See [REFERENCE.md](REFERENCE.md).
