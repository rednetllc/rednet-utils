"""Temporary DNS on networkd links through systemd-resolved's per-link API."""
import ipaddress
import json
from pathlib import Path
import socket

SERVICE = 'org.freedesktop.resolve1'
LINK = 'org.freedesktop.resolve1.Link'


def identity(interface):
  # Index alone is reusable; bind recovery to device address too.
  index = socket.if_nametoindex(interface)
  address = (Path('/sys/class/net') / interface / 'address').read_text().strip()
  return index, address


def property_value(command, index, name):
  result = json.loads(command(['busctl', '--json=short', 'get-property', SERVICE,
                              '/org/freedesktop/resolve1/link/_' + str(index), LINK, name]))
  return result['data']


def snapshot(command, interface):
  resolver = Path('/etc/resolv.conf').resolve()
  if str(resolver) != '/run/systemd/resolve/stub-resolv.conf':
    raise RuntimeError('networkd support requires the systemd-resolved stub /etc/resolv.conf symlink.')
  index, address = identity(interface)
  if property_value(command, index, 'DNSOverTLS') == 'yes':
    raise RuntimeError('Strict DNS-over-TLS is outside this local plain-DNS workflow.')
  # DNSEx carries ports and TLS names that the basic DNS property would lose.
  for family, packed, port, name in property_value(command, index, 'DNSEx'):
    if port not in (0, 53) or name:
      raise RuntimeError('Custom resolved DNS ports/TLS names are not supported.')
  servers = []
  for family, packed in property_value(command, index, 'DNS'):
    if family not in (socket.AF_INET, socket.AF_INET6):
      raise RuntimeError('Unsupported resolved address family.')
    servers.append(socket.inet_ntop(family, bytes(packed)))
  domains = [('~' if route else '') + name for name, route in property_value(command, index, 'Domains')]
  default_route = property_value(command, index, 'DefaultRoute')
  if not isinstance(default_route, bool):
    raise RuntimeError('Invalid resolved default-route property.')
  if not servers:
    raise RuntimeError('Selected networkd link has no DNS servers to preserve.')
  return {'backend': 'networkd', 'interface': interface, 'index': index,
          'address': address, 'servers': servers, 'domains': domains,
          'default_route': default_route,
          'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def apply(command, saved, restore=False):
  index, address = identity(saved['interface'])
  if index != saved['index'] or address != saved['address']:
    raise RuntimeError('Original networkd interface identity changed; refusing DNS modification.')
  current_boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
  if current_boot != saved['boot_id']:
    # Runtime overrides vanish at reboot. Do not reinstate stale DHCP values.
    if restore:
      return
    raise RuntimeError('Host rebooted; create a new session.')
  servers = saved['servers'] if restore else ['127.0.0.1']
  domains = saved['domains'] if restore else ['~.']
  default_route = saved['default_route'] if restore else True
  for server in servers:
    ipaddress.ip_address(server)
  for domain in domains:
    if not domain or domain.startswith('-') or any(c.isspace() for c in domain):
      raise ValueError('Invalid saved DNS domain.')
  # Empty string clears a list; omitting it would only query current settings.
  for verb, values in [('dns', servers), ('domain', domains),
                       ('default-route', ['yes' if default_route else 'no'])]:
    command(['sudo', 'resolvectl', verb, str(index), *(values or [''])])
  actual = snapshot(command, saved['interface'])
  if (actual['servers'], actual['domains'], actual['default_route']) != (servers, domains, default_route):
    raise RuntimeError('systemd-resolved DNS settings did not match requested values.')
