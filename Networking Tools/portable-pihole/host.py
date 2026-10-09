"""Host discovery and package-manager setup; no network-manager replacement."""
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys


def distro(path=Path('/etc/os-release')):
  values = {}
  for line in path.read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.startswith('#'):
      key, value = line.split('=', 1)
      parsed = shlex.split(value)
      values[key] = parsed[0] if len(parsed) == 1 else ''
  ident = values.get('ID', '')
  if ident not in ('ubuntu', 'fedora', 'arch'):
    raise RuntimeError('Automatic Linux setup supports Ubuntu, Fedora, and Arch; detected ' + ident)
  if Path('/run/ostree-booted').exists():
    raise RuntimeError('Immutable Fedora editions require manual Docker installation.')
  return values


def active(command, service):
  try:
    return command(['systemctl', 'is-active', service]) == 'active'
  except (OSError, RuntimeError, subprocess.SubprocessError):
    return False


def interfaces(system, command, powershell):
  if system == 'Windows':
    data = json.loads(powershell("ConvertTo-Json -Compress -InputObject @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -ExpandProperty Name)"))
    return [{'name': name, 'backend': 'windows'} for name in data]
  if system == 'Darwin':
    services = command(['networksetup', '-listallnetworkservices']).splitlines()[1:]
    rows = []
    for service in services:
      if service.startswith('*'):
        continue
      info = command(['networksetup', '-getinfo', service])
      if any(line.startswith('IP address: ') and line.split(': ', 1)[1] not in ('none', '0.0.0.0') for line in info.splitlines()):
        rows.append({'name': service, 'backend': 'macos'})
    return rows
  if system != 'Linux':
    raise RuntimeError('Unsupported platform: ' + system)
  links = json.loads(command(['ip', '-j', 'address', 'show']))
  rows = []
  nm = shutil.which('nmcli') and active(command, 'NetworkManager')
  networkd = shutil.which('networkctl') and active(command, 'systemd-networkd')
  for link in links:
    name = link['ifname']
    if 'LOOPBACK' in link.get('flags', []) or link.get('operstate') != 'UP':
      continue
    if not any(a.get('family') == 'inet' and a.get('scope') == 'global' for a in link.get('addr_info', [])):
      continue
    backend = None
    if nm:
      try:
        if command(['nmcli', '-g', 'GENERAL.STATE', 'device', 'show', name]).startswith('100'):
          backend = 'networkmanager'
      except RuntimeError:
        pass
    if networkd:
      try:
        info = json.loads(command(['networkctl', '--json=short', 'status', name]))
        if info.get('NetworkFile') and info.get('AdministrativeState') == 'configured':
          if backend:
            raise RuntimeError('Multiple managers claim interface ' + name)
          backend = 'networkd'
      except json.JSONDecodeError:
        raise RuntimeError('networkctl JSON support is required (systemd 252+).')
    if backend:
      rows.append({'name': name, 'backend': backend})
  return rows


def select_interface(rows, explicit=None, read=input):
  if explicit:
    matches = [r for r in rows if r['name'] == explicit]
    if len(matches) != 1:
      raise RuntimeError('Requested interface is not an active supported connection: ' + explicit)
    return matches[0]
  if not rows:
    raise RuntimeError('No active supported IPv4 interface found. Configure NetworkManager or networkd/resolved first.')
  if len(rows) == 1:
    print('Using interface: ' + rows[0]['name'] + ' (' + rows[0]['backend'] + ')')
    return rows[0]
  if not sys.stdin.isatty() and read is input:
    raise RuntimeError('Multiple interfaces found; use --interface in a noninteractive terminal.')
  print('Select the connection whose DNS you want to change:')
  for number, row in enumerate(rows, 1):
    print(f"  {number}. {row['name']} ({row['backend']})")
  while True:
    answer = read('Interface number (q to cancel): ').strip()
    if answer.lower() == 'q':
      raise RuntimeError('Interface selection cancelled.')
    if answer.isdigit() and 1 <= int(answer) <= len(rows):
      return rows[int(answer) - 1]
    print('Choose one of the numbered interfaces.')


def install_commands(system, ident=None, engine_missing=True, official_engine=False):
  if system == 'Linux':
    if not engine_missing:
      package = 'docker-compose-plugin' if official_engine else ('docker-compose-v2' if ident == 'ubuntu' else 'docker-compose')
      return {'ubuntu': [['sudo','apt-get','update'], ['sudo','apt-get','install','-y',package,'iproute2']],
              'fedora': [['sudo','dnf','install','-y',package,'iproute']],
              'arch': [['sudo','pacman','-Syu','--needed','--noconfirm',package,'iproute2']]}[ident]
    return {
      'ubuntu': [['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'docker.io', 'docker-compose-v2', 'iproute2']],
      'fedora': [['sudo', 'dnf', 'install', '-y', 'moby-engine', 'docker-compose', 'iproute']],
      'arch': [['sudo', 'pacman', '-Syu', '--needed', '--noconfirm', 'docker', 'docker-compose', 'iproute2']],
    }[ident]
  if system == 'Darwin':
    return [['brew', 'install', '--cask', 'docker-desktop']]
  if system == 'Windows':
    return [['winget', 'install', '--exact', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements']]
  raise RuntimeError('Unsupported platform: ' + system)


def interactive_command(args):
  # sudo/package installers need a terminal, unlike read-only discovery commands.
  subprocess.run(args, check=True)


def prerequisites(system, command):
  info = distro() if system == 'Linux' else {}
  print('Detected ' + system + (' / ' + info.get('PRETTY_NAME', info.get('ID', '')) if info else ''))
  engine_missing = not shutil.which('docker')
  missing = engine_missing
  if not missing:
    try:
      version = command(['docker', 'compose', 'version', '--short']).lstrip('v').split('.')
      missing = tuple(int(part.split('-')[0]) for part in version[:2]) < (2, 20)
    except (RuntimeError, ValueError, OSError):
      missing = True
  if missing:
    if system == 'Darwin' and not shutil.which('brew'):
      raise RuntimeError('Install Homebrew or Docker Desktop first, then rerun. See README.')
    if system == 'Windows' and not shutil.which('winget'):
      raise RuntimeError('Windows App Installer (winget) is required for automatic prerequisite installation.')
    official_engine = False
    if system == 'Linux' and not engine_missing and info['ID'] in ('ubuntu', 'fedora'):
      try:
        query = ['dpkg-query', '-W', '-f=${Status}', 'docker-ce-cli'] if info['ID'] == 'ubuntu' else ['rpm', '-q', 'docker-ce-cli']
        output = command(query)
        official_engine = 'install ok installed' in output if info['ID'] == 'ubuntu' else bool(output)
      except (RuntimeError, OSError):
        pass
    for args in install_commands(system, info.get('ID'), engine_missing, official_engine):
      print('Installing prerequisites: ' + shlex.join(args))
      interactive_command(args)
  if system == 'Linux':
    if not active(command, 'docker'):
      interactive_command(['sudo', 'systemctl', 'start', 'docker'])
  elif system == 'Darwin':
    interactive_command(['open', '-a', 'Docker'])
  elif missing:
    raise RuntimeError('Docker Desktop installed. Complete its first-run setup/reboot and rerun this launcher.')
  # Never run Docker as root or silently grant root-equivalent docker-group access.
  try:
    if command(['docker', 'info', '--format', '{{.OSType}}']) != 'linux':
      raise RuntimeError('Use a Linux-container Docker engine.')
  except (OSError, RuntimeError) as error:
    raise RuntimeError('Docker is not ready or your user lacks socket access. Start Docker Desktop or configure Docker access, then rerun.') from error
  version = command(['docker', 'compose', 'version', '--short']).lstrip('v').split('.')
  if tuple(int(p.split('-')[0]) for p in version[:2]) < (2, 20):
    raise RuntimeError('Docker Compose 2.20+ is required.')
  if system == 'Linux' and not shutil.which('ip'):
    raise RuntimeError('iproute2 is required; install it with the distro package manager.')
