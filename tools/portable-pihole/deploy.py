#!/usr/bin/env python3
"""Temporary local Pi-hole with recoverable host DNS changes (stdlib only)."""

import argparse
import contextlib
import ctypes
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import socket
import struct
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "local" / "session.json"


def command(args, timeout=60):
  result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                          env={**os.environ, "LC_ALL": "C", "LANG": "C"})
  if result.returncode:
    # Do not echo command arguments: Compose and host tools may contain secrets.
    raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode}): "
                       f"{result.stderr.strip() or result.stdout.strip()}")
  return result.stdout.strip()


def powershell(script):
  return command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                  "$ErrorActionPreference = 'Stop'; " + script])


def ipv4_list(value):
  values = value if isinstance(value, list) else re.split(r"[,;\s]+", value.strip())
  return [str(ipaddress.IPv4Address(item)) for item in values if item]


def valid_uuid(value):
  return str(uuid.UUID(value))


class DNS:
  def __init__(self, system):
    if system not in ("Windows", "Darwin", "Linux"):
      raise RuntimeError(f"Unsupported platform: {system}")
    self.system = system

  def authorize(self):
    if self.system == "Windows":
      if not ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError("Run this terminal as Administrator.")
    else:
      # Elevate only networking commands; keep the caller's Docker context.
      command(["sudo", "-v"])

  def snapshot(self, interface):
    if not interface or interface.startswith("-") or any(c in interface for c in "\r\n\0"):
      raise ValueError("Specify a valid interface/service name.")
    if self.system == "Windows":
      name = interface.replace("'", "''")
      data = json.loads(powershell(
        "$a = @(Get-NetAdapter | Where-Object { $_.Name -eq '" + name + "' }); "
        "if ($a.Count -ne 1 -or $a[0].Status -ne 'Up') { throw 'Adapter must be up and unique' }; "
        "$g = $a[0].InterfaceGuid.ToString(); "
        "$p = Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{' + $g.Trim('{}') + '}'); "
        "@{id=$g; servers=[string]$p.NameServer} | ConvertTo-Json -Compress"))
      return {"id": valid_uuid(data["id"]), "servers": ipv4_list(data["servers"])}
    if self.system == "Darwin":
      services = command(["networksetup", "-listallnetworkservices"]).splitlines()[1:]
      if interface not in services:
        raise RuntimeError("Choose an enabled macOS network service from networksetup -listallnetworkservices.")
      output = command(["networksetup", "-getdnsservers", interface])
      # networksetup reports automatic DNS in prose, rather than an empty list.
      servers = [] if output.startswith("There aren't any DNS Servers set on ") else output.splitlines()
      for server in servers:
        ipaddress.ip_address(server)
      return {"id": interface, "servers": servers}
    ident = valid_uuid(command(["nmcli", "-g", "GENERAL.CON-UUID", "device", "show", interface]))
    servers = ipv4_list(command(["nmcli", "-g", "ipv4.dns", "connection", "show", ident]))
    automatic = command(["nmcli", "-g", "ipv4.ignore-auto-dns", "connection", "show", ident])
    if automatic not in ("yes", "no"):
      raise RuntimeError("Unsupported NetworkManager DNS mode.")
    return {"id": ident, "interface": interface, "servers": servers, "ignore_auto": automatic}

  def apply(self, saved, restore=False):
    servers = saved["servers"] if restore else ["127.0.0.1"]
    if self.system == "Windows":
      ident = valid_uuid(saved["id"])
      index = powershell(
        "$a = @(Get-NetAdapter | Where-Object { $_.InterfaceGuid -eq '" + ident + "' }); "
        "if ($a.Count -ne 1) { throw 'Original adapter not found' }; $a[0].ifIndex")
      index = str(int(index))
      base = ["netsh", "interface", "ipv4"]
      if not servers:
        command(base + ["set", "dnsservers", "name=" + index, "source=dhcp"])
      else:
        servers = ipv4_list(servers)
        command(base + ["set", "dnsservers", "name=" + index, "source=static",
                        "address=" + servers[0], "validate=no"])
        for number, server in enumerate(servers[1:], 2):
          command(base + ["add", "dnsservers", "name=" + index, "address=" + server,
                          "index=" + str(number), "validate=no"])
      command(["ipconfig", "/flushdns"])
    elif self.system == "Darwin":
      # A renamed or disabled service must be recovered explicitly, not guessed.
      services = command(["networksetup", "-listallnetworkservices"]).splitlines()[1:]
      if saved["id"] not in services:
        raise RuntimeError("Original macOS network service is missing or disabled.")
      for server in servers:
        ipaddress.ip_address(server)
      command(["sudo", "networksetup", "-setdnsservers", saved["id"], *(servers or ["Empty"])])
      if self.snapshot(saved["id"])["servers"] != servers:
        raise RuntimeError("macOS DNS settings did not match the requested values.")
      command(["sudo", "dscacheutil", "-flushcache"])
    else:
      ident = valid_uuid(saved["id"])
      interface = saved["interface"]
      active = valid_uuid(command(["nmcli", "-g", "GENERAL.CON-UUID", "device", "show", interface]))
      if active != ident:
        raise RuntimeError("NetworkManager connection changed. Reconnect the original connection and retry restore.")
      automatic = saved["ignore_auto"] if restore else "yes"
      if automatic not in ("yes", "no"):
        raise ValueError("Invalid saved DNS mode.")
      command(["sudo", "nmcli", "connection", "modify", ident, "ipv4.dns",
               ",".join(ipv4_list(servers)), "ipv4.ignore-auto-dns", automatic])
      command(["sudo", "nmcli", "device", "reapply", interface])


def compose(*args):
  return command(["docker", "compose", "--project-directory", str(ROOT),
                  "--env-file", str(ROOT / ".env"), "-f", str(ROOT / "compose.yaml"), *args],
                 timeout=300)


def check_docker_context():
  endpoint = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
  if not endpoint:
    endpoint = command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
  if not endpoint.startswith(("unix://", "npipe://")):
    raise RuntimeError("Use a local Docker socket/context; remote and TCP Docker endpoints are not supported.")


def check_dns():
  """Confirm an actual UDP answer before changing the host's resolver."""
  ident = os.urandom(2)
  query = ident + struct.pack("!HHHHH", 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\0\0\x01\0\x01"
  with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
    client.settimeout(5)
    client.connect(("127.0.0.1", 53))
    client.send(query)
    reply = client.recv(4096)
  if len(reply) < 12 or reply[:2] != ident:
    raise RuntimeError("Pi-hole returned an invalid DNS response.")
  flags, _, answers = struct.unpack("!HHH", reply[2:8])
  if not flags & 0x8000 or flags & 0x000F or not answers:
    raise RuntimeError("Pi-hole could not resolve example.com; host DNS was not changed.")


def write_state(path, state):
  temporary = path.with_suffix(".tmp")
  with open(temporary, "w", encoding="utf-8") as handle:
    if os.name != "nt":
      os.chmod(temporary, 0o600)
    json.dump(state, handle, indent=2)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
  os.replace(temporary, path)


@contextlib.contextmanager
def session_lock(directory):
  directory.mkdir(mode=0o700, parents=True, exist_ok=True)
  # OS-held locks are released even after a crash; do not delete the lock file.
  with open(directory / "session.lock", "a+b") as handle:
    handle.seek(0)
    handle.write(b"0")
    handle.flush()
    handle.seek(0)
    try:
      if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
      else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
      raise RuntimeError("Another launcher is active in this installation.") from error
    try:
      yield
    finally:
      if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
      else:
        fcntl.flock(handle, fcntl.LOCK_UN)


def recover(dns, path=STATE):
  if not path.exists():
    raise RuntimeError("No saved session to restore.")
  state = json.loads(path.read_text(encoding="utf-8"))
  if state.get("version") != 1 or state.get("system") != dns.system:
    raise RuntimeError("Recovery file version/platform does not match this host.")
  if state["dns_attempted"]:
    dns.apply(state["dns"], restore=True)
  # If restore fails, execution never reaches stop: keep DNS service and snapshot.
  compose("stop", "pihole")
  path.unlink()


def run_session(dns, interface, path=STATE, wait=input):
  if path.exists():
    raise RuntimeError("A recovery file exists. Run 'restore' before starting another session.")
  check_docker_context()
  if compose("ps", "--status", "running", "--quiet"):
    raise RuntimeError("This Compose project is already running. Stop it before starting a managed session.")
  saved = dns.snapshot(interface)
  state = {"version": 1, "system": dns.system, "dns": saved, "dns_attempted": False}
  write_state(path, state)
  try:
    compose("up", "-d", "--wait", "--wait-timeout", "120")
    check_dns()
    # Persist before the first OS mutation, including partially successful changes.
    state["dns_attempted"] = True
    write_state(path, state)
    dns.apply(saved)
    print("Pi-hole is ready: http://127.0.0.1:8080/admin/")
    wait("Press Enter to restore DNS and stop Pi-hole. Keep this terminal open. ")
  finally:
    recover(dns, path)


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("action", choices=("run", "restore"))
  parser.add_argument("--interface", help="Windows adapter, macOS network service, or Linux NM device")
  args = parser.parse_args()
  if args.action == "run" and not args.interface:
    parser.error("run requires --interface")
  dns = DNS(platform.system())
  try:
    with session_lock(STATE.parent):
      dns.authorize()
      if args.action == "restore":
        recover(dns)
      else:
        run_session(dns, args.interface)
    return 0
  except KeyboardInterrupt:
    print("Interrupted. If a recovery file remains, run 'restore'.", file=sys.stderr)
    return 130
  except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, EOFError) as error:
    print(f"Error: {error}\nIf local/session.json remains, run 'restore' before changing networks "
          "or stopping Pi-hole.", file=sys.stderr)
    return 1


if __name__ == "__main__":
  sys.exit(main())
