# Portable Pi-hole

Run a temporary, local Pi-hole container and automatically point one host network connection at it. The same Python launcher handles Windows, macOS, and Linux: it saves your existing DNS settings, starts Pi-hole, checks DNS resolution, switches the connection, then restores the saved settings **before** stopping the container.

## About

Portable Pi-hole started as a simple Windows `.bat` deployer for a friend who
wanted DNS ad blocking on the go but did not have a VPN back to his home network.
Running Pi-hole locally in a container let him take his own filtering setup with
him, with settings preserved between sessions, without depending on access to a
home server.

A VPN back home can already provide access to a home DNS blocker. This project
offers another useful option: a Pi-hole instance on the computer you are using,
ready for temporary sessions away from home on networks that allow the required
DNS connectivity. Its configuration stays on that computer as you travel.

What began as a small tool for one friend is being expanded to Windows, macOS,
and Linux so more people can use it. The goal is to keep a useful mini project
accessible: start local filtering when you need it, retain your Pi-hole settings,
and restore the network connection when you finish. It provides DNS filtering;
it does not replace a VPN or block every kind of advertisement.

## Requirements

- **Python 3.10 or newer**, using only the standard library. No pip installation is needed.
- **Docker Compose v2.20 or newer**, a running local Docker engine, and permission to use it. Windows and macOS require Docker Desktop running Linux containers. Linux requires Docker Engine and **either NetworkManager with `nmcli`/`device reapply`, or systemd-networkd with systemd-resolved (systemd 252+ and its stub resolver)**. Remote Docker contexts are not supported: the DNS probe and host settings use localhost.
- The Compose file pins **`pihole/pihole:2026.09.0`** (Pi-hole v6). Image upgrades require reviewing upstream release notes and repeating validation.
- Windows 10/11 with Windows PowerShell 5.1, `netsh`, and an Administrator terminal; or macOS/Linux with `sudo` privileges. On macOS/Linux, run Python as your normal Docker-capable user: the launcher elevates only DNS commands.
- Free localhost ports **53 TCP/UDP** and **8080 TCP**, plus outbound access to the image registry, Pi-hole blocklists, and configured upstream DNS resolvers.
- One ordinary, active network connection. VPNs, managed DNS policies, split DNS, other concurrent DNS managers, and Linux connections with pre-existing transient DNS overrides are outside this tool's supported scope.

The platform backends are tested with synthetic fixtures. This does not establish live compatibility with every OS release, Docker Desktop version, or network setup. Check the first session on each host before relying on it.

## 1. Install and configure locally

Download this repository and open a terminal in `Networking Tools/portable-pihole`. Keep this directory on the host's local disk, in a location private to your user. Do not run it from a shared or synchronized folder. Use one installation and one session per host.

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

The preferred entry points are native shell scripts. From the tool directory:

```sh
./start.sh
```

On Windows, use an Administrator PowerShell terminal:

```powershell
.\start.ps1
```

They detect the OS and install Python 3.10+ if needed through an existing native
package manager. Python remains the internal, standard-library recovery engine;
no pip packages are required. On macOS, install [Homebrew](https://brew.sh) first
if Python or Docker Desktop is missing. Windows needs App Installer (`winget`).
Windows installers can require a fresh terminal, Docker Desktop first-run setup,
WSL setup, or a reboot; the launcher reports when to rerun. Docker Desktop must
be ready before a session starts.

The Python launcher detects Ubuntu, Fedora, and Arch from `/etc/os-release`.
Missing Docker/Compose prerequisites are installed from distro repositories:
Ubuntu uses `apt-get` (`docker.io`, `docker-compose-v2`), Fedora uses `dnf`
(`moby-engine`, `docker-compose`), and Arch uses `pacman` (`docker`,
`docker-compose`). Arch uses `-Syu` to avoid unsupported partial upgrades: this
can upgrade the system. Setup starts the Linux Docker service for this boot.
It does not replace your network manager, edit package repositories, remove
conflicting packages, enable services at boot, or grant Docker-group membership.
An existing Docker installation still needs user socket access. Fedora immutable
editions and unsupported distro IDs require manual prerequisite setup.

Use `./start.sh setup` or `.\start.ps1 setup` for prerequisites only.
Use `./start.sh interfaces` or `.\start.ps1 interfaces` to list active supported
connections without Docker installation. `restore` also skips prerequisite
installation and interface discovery. Append `--skip-setup` to `run` when you
manage dependencies yourself.

With one eligible active connection, the launcher selects it and prints its
name. With several, a numbered terminal selection screen lets you choose the
connection to modify or cancel. `--interface` remains available for an exact
selection; noninteractive multi-interface use requires it. Disabled, loopback,
disconnected, and unsupported Linux connections are excluded. The picker does
not promise that every listed connection is appropriate: select your Internet
connection rather than a VPN, bridge, or container interface.

The existing Python commands below remain available for direct use.

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

### Linux (Ubuntu, Fedora, and Arch)

Find the connected device name:

```sh
nmcli device status
python3 deploy.py run --interface "wlan0"
```

Replace `wlan0` with the connected device. The launcher saves the active connection UUID, its configured IPv4 DNS list, and its `ipv4.ignore-auto-dns` flag. It updates the profile and reapplies it without intentionally disconnecting the device, then restores both settings at the end. This profile change persists if the process or host crashes; run recovery after restarting. IPv6 configuration is unchanged. The manager is detected per interface, independently of the distro name.
Ubuntu Desktop and Fedora normally use NetworkManager; Ubuntu Server commonly
uses Netplan with networkd. Arch does not prescribe one installed network manager.

For a configured networkd interface, the launcher uses systemd-resolved's
per-link DNS API through `resolvectl`/`busctl`. It snapshots IPv4/IPv6 DNS servers,
search/routing domains, and DNS default-route status; temporarily sets localhost
DNS and a `~.` routing domain; verifies the result; and restores all three
settings before stopping Pi-hole. It never edits Netplan YAML, `.network` files,
or `/etc/resolv.conf`. Your resolver must already use the
`/run/systemd/resolve/stub-resolv.conf` symlink. Strict DNS-over-TLS, custom DNS
ports/TLS server names, alternate resolv.conf modes, and networkd without
resolved are refused. Other Arch managers (for example standalone dhcpcd or
netctl) are outside this backend scope; configure a supported backend manually.

Networkd overrides are runtime-only and disappear at reboot. Recovery records
boot and interface identity; after reboot it preserves the newly supplied DNS
instead of replaying stale DHCP values. Within the same boot it restores the
saved effective settings as runtime overrides. Avoid DHCP renewals, manager
restarts, or other DNS edits during a session; those services can overwrite
runtime settings. Multiple-manager ownership is refused.

### During the session

Wait for the launcher to report success, then open **http://127.0.0.1:8080/admin/** and sign in with your configured password. It waits up to 120 seconds for Compose readiness and requires a successful direct DNS lookup of `example.com` before changing host DNS.

Check that new requests from your applications appear in Pi-hole's query log. Cached answers, browser secure DNS/DoH, VPN resolvers, another active network connection, and IPv6-provided DNS can bypass the selected connection’s DNS settings; this tool does not disable those features or promise complete traffic filtering.

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

## Linux backend references

- [Ubuntu network configuration](https://ubuntu.com/server/docs/explanation/networking/configuring-networks/)
- [Fedora NetworkManager](https://fedoraproject.org/wiki/Tools/NetworkManager)
- [Arch network configuration](https://wiki.archlinux.org/title/Network_configuration)
- [systemd resolved per-link API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.resolve1.html)

Targeted Linux scope is Ubuntu 24.04+ and current mutable Fedora/Arch with the
backends above. Synthetic tests verify command generation and recovery; live
installation and DNS sessions on all three distros still require qualification.
Package availability, privileges, socket access, and manager capabilities are
checked at runtime. Setup cannot bypass OS installer requirements.

## Data handling and limits

DNS queries are sent to your configured upstream provider. Pi-hole's persistent volume can contain queried domains, client information, configuration, and password hashes. `.env` contains the administrator password, which is also visible to users with Docker inspection privileges. The recovery file contains local adapter identifiers and prior DNS addresses. These are local runtime data, not repository content; ignore rules exclude them.

On POSIX systems, newly created recovery directories/files use private permissions. On Windows, protect the installation with your user account's NTFS permissions. The launcher changes only the selected connection's settings and does not restore unrelated network changes. A forced kill or power loss cannot run cleanup automatically; use `restore`. Restoring automatic DNS allows the network to supply its current servers, which may differ from those assigned earlier.

## Planned feature: encrypted upstream DNS

Encrypted upstream DNS is **not currently available** in this tool. The pinned
Pi-hole image (`2026.09.0`) uses ordinary, unencrypted DNS for the default
Cloudflare upstreams (`1.1.1.1` and `1.0.0.1`); choosing those addresses alone
does not enable encryption.

The planned option will use Pi-hole's native DNS-over-HTTPS or DNS-over-TLS
support with Cloudflare's free public resolver, without an account, another
container, or additional host software. [Native encrypted upstream support](https://github.com/pi-hole/FTL/pull/2940)
has been merged into Pi-hole's development branch but is not included in the
[currently pinned stable Docker release](https://github.com/pi-hole/docker-pi-hole/releases/tag/2026.09.0).
Implementation is deferred until an official stable image includes that support.

Before exposing the option, qualify certificate and hostname verification,
bootstrap resolution without a DNS loop, failure without plaintext fallback,
and readiness checks that confirm the encrypted upstream works. Validate
filtering, session cleanup, and DNS recovery on Windows, macOS, and the supported
Linux backends. Encryption protects the upstream connection; the resolver
provider can still see the queries it receives.

## Maintenance and development

End the session and confirm recovery has completed before updating. Back up Pi-hole settings with its Teleporter export and protect that export privately. Review [upstream Docker upgrade guidance](https://docs.pi-hole.net/docker/upgrading/) before changing the pinned image. An image downgrade alone may not undo a data migration.

This creates a fresh Docker volume; it does not adopt the old deployer's Windows bind-mounted data or its running container. Stop the old deployer first, preserve its data, and use Pi-hole's supported export/import workflow if you need existing settings. The old repository is retained as provenance.

To uninstall, complete recovery first, then run `docker compose down` from this directory. This keeps the named volume. Only if you intentionally want to delete all saved Pi-hole settings and query history, run `docker compose down --volumes`. Remove the installation directory after DNS has been restored.

Run the tests with Python and the Docker Compose CLI installed (no daemon, credentials, sudo, or live DNS required):

```sh
python3 -m unittest -v test_deploy test_host
```

Use `py -3` instead of `python3` on Windows. Tests exercise configuration validation, OS/distro setup plans, manager discovery, interface selection, command generation, session ordering, partial failures, interruption, and recovery with synthetic data. CI runs backend tests on Windows, macOS, and Linux and Compose checks on Linux. Live host DNS changes and container deployment still need a first-run check on your machine.

See [CHANGELOG.md](CHANGELOG.md) for changes. Original utility code uses the repository's [MIT License](../../LICENSE); Pi-hole retains its own licenses.
