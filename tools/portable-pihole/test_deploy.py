"""Synthetic tests: no Docker daemon, elevated commands, or host DNS changes."""

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import deploy

GUID = "00000000-0000-4000-8000-000000000001"


class SessionTests(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.addCleanup(self.temporary.cleanup)
    self.state = Path(self.temporary.name) / "session.json"
    self.events = []
    self.dns = Mock(system="Windows")
    self.dns.snapshot.return_value = {"id": GUID, "servers": ["192.0.2.53"]}
    self.dns.apply.side_effect = self.apply
    self.compose = patch.object(deploy, "compose", side_effect=self.docker).start()
    patch.object(deploy, "check_dns", side_effect=lambda: self.events.append("probe")).start()
    patch.object(deploy, "check_docker_context").start()
    self.addCleanup(patch.stopall)

  def docker(self, *args):
    self.events.append(args[0])
    return ""

  def apply(self, saved, restore=False):
    self.events.append("restore" if restore else "switch")
    self.assertTrue(json.loads(self.state.read_text())["dns_attempted"])

  def run_session(self, wait=lambda prompt: None):
    with contextlib.redirect_stdout(io.StringIO()):
      deploy.run_session(self.dns, "Ethernet", self.state, wait)

  def test_restores_before_stopping_and_removes_state(self):
    self.run_session()
    self.assertEqual(self.events, ["ps", "up", "probe", "switch", "restore", "stop"])
    self.assertFalse(self.state.exists())

  def test_start_failure_never_changes_dns(self):
    def docker(*args):
      self.events.append(args[0])
      if args[0] == "up":
        raise RuntimeError("startup failed")
      return ""
    self.compose.side_effect = docker
    with self.assertRaisesRegex(RuntimeError, "startup failed"):
      self.run_session()
    self.dns.apply.assert_not_called()
    self.assertEqual(self.events, ["ps", "up", "stop"])

  def test_probe_failure_never_changes_dns(self):
    with patch.object(deploy, "check_dns", side_effect=RuntimeError("DNS unavailable")):
      with self.assertRaisesRegex(RuntimeError, "DNS unavailable"):
        self.run_session()
    self.dns.apply.assert_not_called()
    self.assertFalse(self.state.exists())

  def test_partial_switch_failure_restores(self):
    def apply(saved, restore=False):
      self.events.append("restore" if restore else "switch")
      if not restore:
        raise RuntimeError("partial switch")
    self.dns.apply.side_effect = apply
    with self.assertRaisesRegex(RuntimeError, "partial switch"):
      self.run_session()
    self.assertEqual(self.events[-2:], ["restore", "stop"])

  def test_failed_restore_keeps_container_and_recovery_file(self):
    def apply(saved, restore=False):
      if restore:
        raise RuntimeError("restore failed")
    self.dns.apply.side_effect = apply
    with self.assertRaisesRegex(RuntimeError, "restore failed"):
      self.run_session()
    self.assertTrue(self.state.exists())
    self.assertNotIn("stop", self.events)
    self.dns.apply.side_effect = self.apply
    deploy.recover(self.dns, self.state)
    self.assertFalse(self.state.exists())

  def test_ctrl_c_restores(self):
    def interrupted(prompt):
      raise KeyboardInterrupt()
    with self.assertRaises(KeyboardInterrupt):
      self.run_session(interrupted)
    self.assertEqual(self.events[-2:], ["restore", "stop"])

  def test_existing_state_is_not_overwritten(self):
    self.state.write_text("saved recovery")
    with self.assertRaisesRegex(RuntimeError, "recovery file exists"):
      self.run_session()
    self.assertEqual(self.state.read_text(), "saved recovery")
    self.compose.assert_not_called()

  def test_existing_container_is_not_adopted(self):
    self.compose.return_value = "container-id"
    self.compose.side_effect = None
    with self.assertRaisesRegex(RuntimeError, "already running"):
      self.run_session()
    self.assertFalse(self.state.exists())

  def test_stop_failure_retains_recovery(self):
    def docker(*args):
      if args[0] == "stop":
        raise RuntimeError("Docker unavailable")
      return ""
    self.compose.side_effect = docker
    with self.assertRaisesRegex(RuntimeError, "Docker unavailable"):
      self.run_session()
    self.assertTrue(self.state.exists())

  def test_wrong_platform_refused(self):
    self.state.write_text(json.dumps({"version": 1, "system": "Darwin"}))
    with self.assertRaisesRegex(RuntimeError, "does not match"):
      deploy.recover(self.dns, self.state)
    self.dns.apply.assert_not_called()
    self.compose.assert_not_called()


class BackendTests(unittest.TestCase):
  @patch.object(deploy, "powershell", return_value="7")
  @patch.object(deploy, "command", return_value="")
  def test_windows_static_order_and_ipv4_only(self, command, powershell):
    deploy.DNS("Windows").apply({"id": GUID, "servers": ["192.0.2.53", "192.0.2.54"]}, restore=True)
    calls = [call.args[0] for call in command.call_args_list]
    self.assertEqual(calls[0], ["netsh", "interface", "ipv4", "set", "dnsservers",
                              "name=7", "source=static", "address=192.0.2.53", "validate=no"])
    self.assertIn("address=192.0.2.54", calls[1])
    self.assertIn("index=2", calls[1])
    self.assertIn("[guid]$_.InterfaceGuid -eq [guid]'" + GUID + "'", powershell.call_args.args[0])

  @patch.object(deploy, "powershell", return_value="7")
  @patch.object(deploy, "command", return_value="")
  def test_windows_dhcp_restore(self, command, powershell):
    deploy.DNS("Windows").apply({"id": GUID, "servers": []}, restore=True)
    self.assertIn("source=dhcp", command.call_args_list[0].args[0])

  @patch.object(deploy, "powershell")
  def test_windows_snapshot_distinguishes_static_from_dhcp(self, powershell):
    for raw, expected in [("", []), ("192.0.2.53,192.0.2.54", ["192.0.2.53", "192.0.2.54"])]:
      powershell.return_value = json.dumps({"id": GUID, "servers": raw})
      self.assertEqual(deploy.DNS("Windows").snapshot("Ethernet")["servers"], expected)

  @patch.object(deploy, "command")
  def test_mac_automatic_and_static_snapshots(self, command):
    for response, expected in [("There aren't any DNS Servers set on Wi-Fi.", []),
                               ("192.0.2.53\n2001:db8::53", ["192.0.2.53", "2001:db8::53"])]:
      command.side_effect = ["An asterisk denotes disabled services.\nWi-Fi", response]
      self.assertEqual(deploy.DNS("Darwin").snapshot("Wi-Fi")["servers"], expected)

  @patch.object(deploy, "command")
  def test_mac_empty_restores_automatic_dns(self, command):
    command.side_effect = ["Header\nWi-Fi", "", "Header\nWi-Fi",
                           "There aren't any DNS Servers set on Wi-Fi.", ""]
    deploy.DNS("Darwin").apply({"id": "Wi-Fi", "servers": []}, restore=True)
    self.assertEqual(command.call_args_list[1].args[0],
                     ["sudo", "networksetup", "-setdnsservers", "Wi-Fi", "Empty"])

  @patch.object(deploy, "command")
  def test_linux_restores_dns_and_automatic_flag(self, command):
    saved = {"id": GUID, "interface": "eth0", "servers": ["192.0.2.53"], "ignore_auto": "no"}
    command.side_effect = [GUID, "", ""]
    deploy.DNS("Linux").apply(saved, restore=True)
    self.assertEqual(command.call_args_list[1].args[0],
      ["sudo", "nmcli", "connection", "modify", GUID, "ipv4.dns", "192.0.2.53", "ipv4.ignore-auto-dns", "no"])
    self.assertEqual(command.call_args_list[2].args[0], ["sudo", "nmcli", "device", "reapply", "eth0"])

  @patch.object(deploy, "command", return_value="00000000-0000-4000-8000-000000000002")
  def test_linux_refuses_changed_connection(self, command):
    with self.assertRaisesRegex(RuntimeError, "connection changed"):
      deploy.DNS("Linux").apply({"id": GUID, "interface": "eth0", "servers": [], "ignore_auto": "no"}, restore=True)
    self.assertEqual(command.call_count, 1)

  def test_invalid_address_rejected(self):
    with self.assertRaises(ValueError):
      deploy.ipv4_list("192.0.2.53;not-an-address")

  @patch.object(deploy, "subprocess")
  def test_nonzero_command_is_failure(self, subprocess_mock):
    subprocess_mock.run.return_value = Mock(returncode=1, stderr="synthetic failure", stdout="")
    with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
      deploy.command(["nmcli", "device", "reapply", "eth0"])

  @patch.object(deploy, "command")
  def test_mac_silent_set_failure_is_detected(self, command):
    command.side_effect = ["Header\nWi-Fi", "", "Header\nWi-Fi", "192.0.2.53"]
    with self.assertRaisesRegex(RuntimeError, "did not match"):
      deploy.DNS("Darwin").apply({"id": "Wi-Fi", "servers": []})

  @patch.object(deploy, "command")
  def test_linux_snapshot_keeps_automatic_mode_with_extra_servers(self, command):
    command.side_effect = [GUID, "192.0.2.53,192.0.2.54", "no"]
    saved = deploy.DNS("Linux").snapshot("eth0")
    self.assertEqual(saved, {"id": GUID, "interface": "eth0",
                             "servers": ["192.0.2.53", "192.0.2.54"], "ignore_auto": "no"})


class PreflightTests(unittest.TestCase):
  @patch.dict(os.environ, {"DOCKER_HOST": "ssh://synthetic-host", "DOCKER_CONTEXT": ""})
  def test_remote_docker_is_refused(self):
    with self.assertRaisesRegex(RuntimeError, "local Docker"):
      deploy.check_docker_context()

  @patch.dict(os.environ, {"DOCKER_HOST": "ssh://synthetic-host", "DOCKER_CONTEXT": "desktop-linux"})
  @patch.object(deploy, "command", return_value="unix:///synthetic/docker.sock")
  def test_explicit_context_takes_precedence(self, command):
    deploy.check_docker_context()
    command.assert_called_once()

  @patch.object(deploy.os, "urandom", return_value=b"ab")
  @patch.object(deploy.socket, "socket")
  def test_dns_response_validation(self, socket_mock, random):
    client = socket_mock.return_value.__enter__.return_value
    for response, valid in [(b"ab\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00", True),
                            (b"ab\x81\x83\x00\x01\x00\x00\x00\x00\x00\x00", False),
                            (b"xx\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00", False),
                            (b"short", False)]:
      client.recv.return_value = response
      if valid:
        deploy.check_dns()
      else:
        with self.assertRaises(RuntimeError):
          deploy.check_dns()

  def test_lock_blocks_second_process_and_releases(self):
    code = ("from pathlib import Path; import deploy, sys; "
            "\nwith deploy.session_lock(Path(sys.argv[1])): pass")
    with tempfile.TemporaryDirectory() as directory:
      def child():
        return subprocess.run([os.sys.executable, "-c", code, directory],
                              cwd=deploy.ROOT, capture_output=True, text=True)
      with deploy.session_lock(Path(directory)):
        locked = child()
        self.assertNotEqual(locked.returncode, 0)
        self.assertIn("Another launcher is active", locked.stderr)
      self.assertEqual(child().returncode, 0)


class ComposeTests(unittest.TestCase):
  def config(self, content, **overrides):
    with tempfile.TemporaryDirectory() as directory:
      env_file = Path(directory) / ".env"
      env_file.write_text(content)
      env = {k: v for k, v in os.environ.items() if not k.startswith("PIHOLE_")}
      env.update(overrides)
      return subprocess.run(["docker", "compose", "--env-file", str(env_file),
                             "-f", str(deploy.ROOT / "compose.yaml"), "config", "--format", "json"],
                            capture_output=True, text=True, env=env)

  def test_password_required(self):
    for content in ("", "PIHOLE_PASSWORD=''\n"):
      result = self.config(content)
      self.assertNotEqual(result.returncode, 0)
      self.assertIn("PIHOLE_PASSWORD", result.stderr)

  def test_loopback_ports_persistence_and_literal_password(self):
    result = self.config("PIHOLE_PASSWORD='synthetic$literal#password'\n")
    self.assertEqual(result.returncode, 0, result.stderr)
    config = json.loads(result.stdout)
    service = config["services"]["pihole"]
    self.assertEqual(service["image"], "pihole/pihole:2026.09.0")
    # Compose escapes dollars in rendered config so it can be loaded again.
    self.assertEqual(service["environment"]["FTLCONF_webserver_api_password"], "synthetic$$literal#password")
    self.assertEqual(service["environment"]["TZ"], "UTC")
    self.assertEqual({(p["published"], p["protocol"]) for p in service["ports"]},
                     {("53", "tcp"), ("53", "udp"), ("8080", "tcp")})
    self.assertTrue(all(p["host_ip"] == "127.0.0.1" for p in service["ports"]))
    self.assertEqual(service["volumes"][0]["target"], "/etc/pihole")
    self.assertEqual(service["volumes"][0]["type"], "volume")
    self.assertNotIn("privileged", service)

  def test_custom_upstreams_and_timezone(self):
    result = self.config("PIHOLE_PASSWORD=synthetic\nPIHOLE_TZ=Etc/UTC\nPIHOLE_UPSTREAMS=192.0.2.53;192.0.2.54\n")
    self.assertEqual(result.returncode, 0, result.stderr)
    settings = json.loads(result.stdout)["services"]["pihole"]["environment"]
    self.assertEqual(settings["FTLCONF_dns_upstreams"], "192.0.2.53;192.0.2.54")
    self.assertEqual(settings["TZ"], "Etc/UTC")


if __name__ == "__main__":
  unittest.main()
