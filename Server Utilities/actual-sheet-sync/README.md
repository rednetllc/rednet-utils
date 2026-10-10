# Actual Sheet Sync

Sync Actual Budget to Google Sheets from **inside your existing Actual server Docker container**. New transactions append, edits update, deleted transactions are marked, and daily account balances accumulate without duplicate snapshots. Your host's scheduler starts each run with `docker exec`.

## Requirements

- A running Linux Actual server container with **Node 24**, npm, and an Actual server. The bundled SDK baseline is **26.9.0**; newer stable server releases trigger an automatic matching SDK installation. Version differences alone do not stop exports. Custom images need the same runtime and native-module support.
- A persistent, writable directory in that container, separate from Actual's budget files. The examples use `/data/actual-sheet-sync`; replace it with a directory on your container's persistent volume.
- An **encrypted tracking-mode budget with no auto-post schedules** and a currency with two fractional digits. Other budget modes and unencrypted budgets are not supported.
- A Google service account with Sheets API enabled and Editor access to a spreadsheet dedicated to this budget. Keep spreadsheet sharing Restricted.
- A host that can invoke the Docker CLI: Linux, macOS, Windows with Docker Desktop running Linux containers, or another Docker-capable host with a scheduler. The task's account must have Docker access, and the container must be running when the task starts.
- Outbound access from the container to Google's authentication and Sheets APIs, and to npm's registry during installation and automatic SDK updates.

The exporter connects to Actual through loopback inside the container. Use the **container's internal server port**, not a host-published port. It does not require a separate exporter container or host networking.

## 1. Install in the existing container

Download this repository and open a terminal in `Server Utilities/actual-sheet-sync`. In all examples, replace `actual-server` with your existing container's name and `/data/actual-sheet-sync` with your chosen persistent directory. These Docker commands work in POSIX shells and PowerShell.

Check the container runtime first:

```sh
docker exec actual-server node --version
docker exec actual-server npm --version
```

Node must report `v24.x`. Select a compatible server image if needed; do not upgrade the running server as part of installing this utility.

Create the directory and copy only the eight runtime files:

```sh
docker exec actual-server mkdir -p /data/actual-sheet-sync
docker cp package.json actual-server:/data/actual-sheet-sync/
docker cp package-lock.json actual-server:/data/actual-sheet-sync/
docker cp sync.mjs actual-server:/data/actual-sheet-sync/
docker cp worker.mjs actual-server:/data/actual-sheet-sync/
docker cp source.mjs actual-server:/data/actual-sheet-sync/
docker cp sheets.mjs actual-server:/data/actual-sheet-sync/
docker cp protocol.mjs actual-server:/data/actual-sheet-sync/
docker cp versions.mjs actual-server:/data/actual-sheet-sync/
docker exec --workdir /data/actual-sheet-sync actual-server npm ci --omit=dev
```

Use the same container user for installation and scheduled execution. If your image runs as a non-root user, provision the directory and copied files with ownership that lets that user read the code and manage `node_modules` and `state`. Do not make credentials world-readable to work around ownership errors.

## 2. Configure locally

Copy `config.example.json` to a local `config.json`, or use `config.openid.example.json` for Google/OpenID sign-in. Edit the copy in a local text editor:

| Field | Value |
| --- | --- |
| `serverUrl` | Loopback URL, usually `http://127.0.0.1:5006`. Only loopback hosts are accepted. |
| `syncId` | Actual → Settings → Show advanced settings → Sync ID. Use the Sync ID, not a local budget ID. |
| `spreadsheetId` | The portion of your spreadsheet URL between `/d/` and `/edit`. |
| `timezone` | IANA timezone for daily balance snapshots; defaults to `UTC`. Set this explicitly to your desired accounting day. |
| `currency` | The budget's three-letter, two-decimal currency code; defaults to `USD`. No conversion is performed. |
| Credential paths | Paths to the files described in [CREDENTIALS.md](CREDENTIALS.md), relative to `config.json`. |

Create the local `secrets/` directory and credential files using [the credential guide](CREDENTIALS.md), then copy them into the container:

```sh
docker cp config.json actual-server:/data/actual-sheet-sync/config.json
docker cp secrets actual-server:/data/actual-sheet-sync/
docker exec actual-server chmod 700 /data/actual-sheet-sync/secrets
docker exec actual-server chmod 600 /data/actual-sheet-sync/config.json
docker exec actual-server sh -c 'chmod 600 /data/actual-sheet-sync/secrets/*'
```

Permissions are set **inside the Linux container**, including when the host is Windows. Files must belong to the execution user. Use a Docker-managed Linux volume if a host bind mount cannot enforce private POSIX permissions. Protect the local copies with your host's file permissions too.

The program creates `state/` next to its source for locks and temporary budget data. Keep it on the same persistent installation path across runs. Never commit or share `config.json`, credentials, or state.

## 3. Verify the first run

```sh
docker exec --workdir /data/actual-sheet-sync actual-server node sync.mjs setup
docker exec --workdir /data/actual-sheet-sync actual-server node sync.mjs check
docker exec --workdir /data/actual-sheet-sync actual-server node sync.mjs sync
```

- `setup` creates or verifies eight managed `Actual_*` tabs; it does not connect to Actual.
- `check` checks versions, may update the local SDK, acquires and validates Actual data, and checks Google access without writing spreadsheet rows. Diagnostics are printed to the console.
- `sync` reconciles the managed tabs in one atomic batch and verifies readback.

Compare the first export with Actual, rerun `sync`, and confirm that transactions and same-day balances are not duplicated. `Actual_Status` records the last successful capture and the latest sync outcome, version mismatch, SDK update result, and sanitized error code. Keep formulas and manual analysis in separate tabs. Use only one installation and one budget per spreadsheet.

## 4. Schedule from the host

Configure your scheduler to run this command without `-i` or `-t`:

```sh
docker exec --workdir /data/actual-sheet-sync actual-server node sync.mjs sync
```

See [SCHEDULING.md](SCHEDULING.md) for cron, systemd, macOS launchd, and Windows Task Scheduler examples. The host must be awake, Docker available, and the container running. Preserve the exit code and monitor failures; do not rely only on whether the scheduler launched successfully.

## Data handling and limits

Selected financial rows are sent to Google. Transaction notes, imported descriptions, and bank metadata are excluded, but account names, payee names, categories, dates, and amounts remain sensitive. This is not an anonymization tool.

The SDK downloads a temporary local budget copy and reopens it offline for extraction. Normal SDK synchronization still occurs during acquisition; **`check` and `sync` are not guaranteed read-only server sessions**. Auto-post detection happens after acquisition, so verify the budget's schedule configuration before the first run.

Limits include 50,000 live transactions, fewer than 100,000 rows per tab, an 8 MiB write batch, and a five-minute deadline. See [REFERENCE.md](REFERENCE.md) for column meanings, failure handling, and recovery.

## Maintenance and development

Stop the host's scheduled task and wait for active runs to finish before updating. Back up local configuration and credentials privately. Replace the eight runtime files together and run `npm ci --omit=dev` inside the container. Repeat `check` and `sync` before re-enabling the schedule. Reinstall dependencies after changing the container's Node major version or CPU architecture; review compatibility before updating Actual itself. Automatically selected SDKs live under `state/sdk-*`; after a Node-major or architecture change, remove those SDK directories and `state/sdk-version` while the scheduler is stopped, then reinstall the bundled dependencies. Keep all other state and credential files.

Version 1.2.0 moves the repository source from `tools/actual-sheet-sync` to `Server Utilities/actual-sheet-sync`. Existing container installation paths and scheduler commands stay valid. Copy all eight runtime files when upgrading; the new `versions.mjs` is required. Stop **all** runs before upgrading because locking now covers the entire installation, including automatic SDK updates.

Automatic updates target `@actual-app/api`, not the exporter source or running Actual server. A newer stable server version is installed at its exact version from npm in a temporary directory, checked for package/import compatibility, then activated for a fresh worker and future runs. Equal or older server versions do not trigger installation or downgrade. Prerelease/unrecognized versions skip updates and appear as warnings. An unavailable release or failed install leaves the current SDK selected and attempts the export with a warning; actual API or validation errors still fail the run. Updates require writable state, registry access, and compatible native build support. They share the run's five-minute deadline.

For an existing installation with an explicit timezone, the update preserves its snapshot day. If `timezone` was omitted, add your desired timezone explicitly before updating: the default is now UTC. Existing sheet metadata and row IDs are unchanged.

To remove the exporter, disable its scheduled task, wait for any run to finish, and remove only its installation directory. It does not require changes to the Actual server's application or budget directories. Exported Google Sheets data remains until you remove it yourself.

On a development machine with Node 24:

```sh
npm ci
npm test
npm run test:sdk
```

Tests use synthetic data and a disposable local SDK budget. They do not validate your live container, credentials, or spreadsheet. See [CHANGELOG.md](CHANGELOG.md) for release changes.
