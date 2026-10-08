# Portable Pi-hole

Run a temporary, local Pi-hole container and automatically point one host network connection at it. The same Python launcher handles Windows, macOS, and Linux: it saves your existing DNS settings, starts Pi-hole, checks DNS resolution, switches the connection, then restores the saved settings **before** stopping the container.

Adapted from [PortablePiHole](https://github.com/rednetllc/PortablePiHole). The original personal paths, fixed adapter name, embedded password, and unconditional DHCP reset have been replaced with portable configuration and recoverable DNS changes.

## Requirements

- **Python 3.10 or newer**, using only the standard library. No pip installation is needed.
- **Docker Compose v2.20 or newer**, a running local Docker engine, and permission to use it. Windows and macOS require Docker Desktop running Linux containers. Linux requires Docker Engine and **NetworkManager with `nmcli` and `device reapply` support**. Remote Docker contexts are not supported: the DNS probe and host settings use localhost.
- The Compose file pins **`pihole/pihole:2026.09.0`** (Pi-hole v6). Image upgrades require reviewing upstream release notes and repeating validation.
- Windows 10/11 with Windows PowerShell 5.1, `netsh`, and an Administrator terminal; or macOS/Linux with `sudo` privileges. On macOS/Linux, run Python as your normal Docker-capable user: the launcher elevates only DNS commands.
- Free localhost ports **53 TCP/UDP** and **8080 TCP**, plus outbound access to the image registry, Pi-hole blocklists, and configured upstream DNS resolvers.
- One ordinary, active network connection. VPNs, managed DNS policies, split DNS, other concurrent DNS managers, and Linux connections with pre-existing transient DNS overrides are outside this tool's supported scope.

The platform backends are tested with synthetic fixtures. This does not establish live compatibility with every OS release, Docker Desktop version, or network setup. Check the first session on each host before relying on it.

## 1. Install and configure locally

Download this repository and open a terminal in `tools/portable-pihole`. Keep this directory on the host's local disk, in a location private to your user. Do not run it from a shared or synchronized folder. Use one installation and one session per host.

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

On macOS/Linux:

```sh
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env
```

Set `PIHOLE_PASSWORD` to a unique password. The empty example deliberately fails validation until you configure it. Single-quote passwords containing `$` or `#`; if the password includes quotes, follow [Compose's environment-file syntax](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax).

| Setting | Purpose |
| --- | --- |
| `PIHOLE_PASSWORD` | Required Pi-hole administrator password. Uses v6's `FTLCONF_webserver_api_password`. |
| `PIHOLE_TZ` | IANA timezone; defaults to `UTC`. |
| `PIHOLE_UPSTREAMS` | Semicolon-separated upstream resolvers; defaults to Cloudflare `1.1.1.1;1.0.0.1`. Choose resolvers you trust. Do not point Pi-hole back at itself. |

Shell environment variables override `.env` values. Avoid leaving stale `PIHOLE_*` variables in your terminal. Validate without printing the resolved password:

```sh
docker compose --env-file .env config --quiet
docker compose version
```

The project name is `portable-pihole`. Its `pihole-data` named volume persists configuration and query history across sessions. The admin page and DNS ports bind only to `127.0.0.1`; this utility serves the local host, not other LAN devices.

## 2. Run a session

Choose the connection you actually use for Internet access. The launcher requires an explicit name and never guesses which adapter to change.

### Windows

Open PowerShell **as Administrator**, return to the tool directory, and list adapters:

```powershell
Get-NetAdapter | Select-Object Name, Status
py -3 deploy.py run --interface "Wi-Fi"
```

Replace `Wi-Fi` with your adapter name. The launcher records whether IPv4 DNS was automatic or static, including the ordered static server list. Recovery locates the original adapter by GUID even if its name changes. It does not change IPv6 DNS settings.

### macOS

Find the enabled network service name (for example, `Wi-Fi`, not `en0`):

```sh
networksetup -listallnetworkservices
python3 deploy.py run --interface "Wi-Fi"
```

Enter your sudo password when requested. The launcher saves the service's explicit DNS server list, including IPv6 addresses if present. An empty list is restored to automatic DNS with `networksetup ... Empty`.

### Linux (NetworkManager)

Find the connected device name:

```sh
nmcli device status
python3 deploy.py run --interface "wlan0"
```

Replace `wlan0` with the connected device. The launcher saves the active connection UUID, its configured IPv4 DNS list, and its `ipv4.ignore-auto-dns` flag. It updates the profile and reapplies it without intentionally disconnecting the device, then restores both settings at the end. This profile change persists if the process or host crashes; run recovery after restarting. IPv6 configuration is unchanged. Linux hosts managed only by systemd-networkd, netplan without NetworkManager, or direct `/etc/resolv.conf` edits are not supported.

### During the session

Wait for the launcher to report success, then open **http://127.0.0.1:8080/admin/** and sign in with your configured password. It waits up to 120 seconds for Compose readiness and requires a successful direct DNS lookup of `example.com` before changing host DNS.

Check that new requests from your applications appear in Pi-hole's query log. Cached answers, browser secure DNS/DoH, VPN resolvers, another active network connection, and IPv6-provided DNS can bypass this IPv4 workflow; this tool does not disable those features or promise complete traffic filtering.

Keep the terminal open. **Press Enter to end the session**. Ctrl+C also attempts cleanup. The launcher restores DNS before stopping Pi-hole and keeps the persistent volume. Do not close Docker, change networks, rename network services, edit DNS settings, or run another copy during a session. There is no scheduled mode: this is an interactive temporary resolver, not an unattended DNS service.

## 3. Failure recovery

The launcher writes `local/session.json` before changing DNS and refuses to overwrite it. An OS file lock prevents concurrent runs in the same installation. If DNS restoration fails, it keeps the recovery file and leaves Pi-hole running. Startup or readiness failures do not switch host DNS.

After an unexpected exit, terminal closure, reboot, or reported cleanup failure, return to the **same installation on the same host**, reconnect the original network, and run:

Windows (Administrator PowerShell):

```powershell
py -3 deploy.py restore
```

macOS/Linux:

```sh
python3 deploy.py restore
```

Recovery restores DNS before trying Docker. If Docker is unavailable, DNS can still be restored, but the recovery file remains until the container stop succeeds; restart Docker and retry. Keep `.env`, the Compose file, and `local/session.json` until recovery completes. A Linux connection UUID mismatch is refused: reconnect the saved connection rather than restoring settings onto a different one.

If the original adapter/service has been removed, inspect the saved file locally and restore its recorded DNS mode/server list using your OS network settings. Verify Internet access before manually removing the recovery file. Do not share this file publicly.

For port conflicts, stop the conflicting local service or use another host; changing the published DNS port alone will not work because OS DNS configuration uses port 53. Do not disable your system resolver blindly. For failed readiness, inspect `docker compose ps` and `docker compose logs pihole` locally. Never paste real logs or resolved Compose output into a public issue.

## Data handling and limits

DNS queries are sent to your configured upstream provider. Pi-hole's persistent volume can contain queried domains, client information, configuration, and password hashes. `.env` contains the administrator password, which is also visible to users with Docker inspection privileges. The recovery file contains local adapter identifiers and prior DNS addresses. These are local runtime data, not repository content; ignore rules exclude them.

On POSIX systems, newly created recovery directories/files use private permissions. On Windows, protect the installation with your user account's NTFS permissions. The launcher changes only the selected connection's settings and does not restore unrelated network changes. A forced kill or power loss cannot run cleanup automatically; use `restore`. Restoring automatic DNS allows the network to supply its current servers, which may differ from those assigned earlier.

## Maintenance and development

End the session and confirm recovery has completed before updating. Back up Pi-hole settings with its Teleporter export and protect that export privately. Review [upstream Docker upgrade guidance](https://docs.pi-hole.net/docker/upgrading/) before changing the pinned image. An image downgrade alone may not undo a data migration.

This creates a fresh Docker volume; it does not adopt the old deployer's Windows bind-mounted data or its running container. Stop the old deployer first, preserve its data, and use Pi-hole's supported export/import workflow if you need existing settings. The old repository is retained as provenance.

To uninstall, complete recovery first, then run `docker compose down` from this directory. This keeps the named volume. Only if you intentionally want to delete all saved Pi-hole settings and query history, run `docker compose down --volumes`. Remove the installation directory after DNS has been restored.

Run the tests with Python and the Docker Compose CLI installed (no daemon, credentials, sudo, or live DNS required):

```sh
python3 -m unittest -v test_deploy
```

Use `py -3` instead of `python3` on Windows. Tests exercise configuration validation, command generation, session ordering, partial failures, interruption, and recovery with synthetic data. CI runs backend tests on Windows, macOS, and Linux and Compose checks on Linux. Live host DNS changes and container deployment still need a first-run check on your machine.

See [CHANGELOG.md](CHANGELOG.md) for changes. Original utility code uses the repository's [MIT License](../../LICENSE); Pi-hole retains its own licenses.
