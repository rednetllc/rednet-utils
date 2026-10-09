"""Host/setup/backend fixtures; never install packages or change real DNS."""
import contextlib
import io
import json
from pathlib import Path, PurePosixPath
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch
import host
import resolved
import deploy


class HostTests(unittest.TestCase):
  def test_os_release_is_parsed_without_execution(self):
    with tempfile.TemporaryDirectory() as d:
      p = Path(d) / 'os-release'
      for name in ('ubuntu', 'fedora', 'arch'):
        p.write_text(f'ID={name}\nPRETTY_NAME="Synthetic Linux"\nID_LIKE="other linux"\n')
        with patch.object(host.Path, 'exists', return_value=False):
          self.assertEqual(host.distro(p)['ID'], name)
      p.write_text('ID=unknown\n')
      with self.assertRaisesRegex(RuntimeError, 'detected unknown'):
        host.distro(p)

  def test_native_installers_and_no_network_manager_replacement(self):
    expected = {'ubuntu':'apt-get', 'fedora':'dnf', 'arch':'pacman'}
    for name, manager in expected.items():
      cmds = host.install_commands('Linux', name)
      self.assertEqual(cmds[-1][1], manager)
      self.assertNotIn('networkmanager', ' '.join(cmds[-1]).lower())
    self.assertIn('Docker.DockerDesktop', host.install_commands('Windows')[0])
    self.assertEqual(host.install_commands('Darwin')[0], ['brew','install','--cask','docker-desktop'])

  def test_existing_engine_is_not_replaced_for_compose(self):
    for distro in ('ubuntu', 'fedora', 'arch'):
      args = host.install_commands('Linux', distro, engine_missing=False)[-1]
      self.assertNotIn('docker.io', args)
      self.assertNotIn('moby-engine', args)
      self.assertNotIn('docker', args)
    self.assertIn('docker-compose-plugin', host.install_commands('Linux','ubuntu',False,True)[-1])

  def test_interface_selection_validates_input(self):
    rows = [{'name':'eth0','backend':'networkd'}, {'name':'wlan0','backend':'networkmanager'}]
    with contextlib.redirect_stdout(io.StringIO()):
      self.assertEqual(host.select_interface(rows, read=Mock(side_effect=['x','0','3','2'])),rows[1])
      self.assertEqual(host.select_interface(rows[:1]), rows[0])
    self.assertEqual(host.select_interface(rows,'wlan0'), rows[1])
    with self.assertRaises(RuntimeError): host.select_interface(rows,'lo')
    with self.assertRaises(RuntimeError): host.select_interface([])
    with self.assertRaisesRegex(RuntimeError, 'cancelled'): host.select_interface(rows,read=lambda _: 'q')

  def test_windows_and_mac_discovery(self):
    self.assertEqual(host.interfaces('Windows',Mock(),Mock(return_value='["Ethernet","Wi-Fi"]'))[1]['name'],'Wi-Fi')
    command = Mock(side_effect=['Header\nWi-Fi\n*Disabled\nEthernet','IP address: 192.0.2.1','IP address: none'])
    self.assertEqual(host.interfaces('Darwin',command,Mock()),[{'name':'Wi-Fi','backend':'macos'}])

  def test_linux_detects_actual_manager_and_excludes_down_and_loopback(self):
    links=[{'ifname':'lo','flags':['LOOPBACK'],'operstate':'UP'},
           {'ifname':'eth0','flags':[],'operstate':'UP','addr_info':[{'family':'inet','scope':'global'}]},
           {'ifname':'wlan0','flags':[],'operstate':'DOWN'}]
    for backend in ('networkmanager','networkd'):
      def command(args):
        if args[0]=='ip': return json.dumps(links)
        if args[0]=='nmcli': return '100 (connected)'
        if args[0]=='networkctl': return json.dumps({'NetworkFile':'/run/systemd/network/test.network','AdministrativeState':'configured'})
        raise AssertionError(args)
      with patch.object(host.shutil,'which',return_value='/synthetic/tool'),patch.object(host,'active',side_effect=lambda c,s:s==('NetworkManager' if backend=='networkmanager' else 'systemd-networkd')):
        self.assertEqual(host.interfaces('Linux',command,Mock()),[{'name':'eth0','backend':backend}])

  def test_multiple_managers_refused(self):
    links=[{'ifname':'eth0','operstate':'UP','addr_info':[{'family':'inet','scope':'global'}]}]
    cmd=Mock(side_effect=[json.dumps(links),'100 (connected)',json.dumps({'NetworkFile':'test','AdministrativeState':'configured'})])
    with patch.object(host.shutil,'which',return_value='tool'),patch.object(host,'active',return_value=True):
      with self.assertRaisesRegex(RuntimeError,'Multiple managers'): host.interfaces('Linux',cmd,Mock())

  def test_prerequisites_already_ready_do_not_install(self):
    cmd=Mock(side_effect=['2.24.0','linux','2.24.0'])
    with patch.object(host,'distro',return_value={'ID':'ubuntu'}),patch.object(host.shutil,'which',return_value='tool'),patch.object(host,'active',return_value=True),patch.object(host,'interactive_command') as install:
      host.prerequisites('Linux',cmd)
      install.assert_not_called()

  def test_missing_linux_docker_installs_and_starts(self):
    cmd=Mock(side_effect=['linux','2.24.0'])
    with patch.object(host,'distro',return_value={'ID':'arch'}),patch.object(host.shutil,'which',side_effect=lambda n:None if n=='docker' else 'tool'),patch.object(host,'active',return_value=False),patch.object(host,'interactive_command') as install:
      host.prerequisites('Linux',cmd)
      self.assertIn('pacman',install.call_args_list[0].args[0])
      self.assertEqual(install.call_args_list[-1].args[0],['sudo','systemctl','start','docker'])

  def test_restore_never_installs_or_selects_interfaces(self):
    with patch.object(deploy.sys,'argv',['deploy.py','restore']),patch.object(deploy.platform,'system',return_value='Linux'),patch.object(deploy,'session_lock',return_value=contextlib.nullcontext()),patch.object(deploy.DNS,'authorize'),patch.object(deploy,'recover') as recover,patch.object(host,'prerequisites') as setup,patch.object(host,'interfaces') as discover:
      self.assertEqual(deploy.main(),0)
      setup.assert_not_called(); discover.assert_not_called();recover.assert_called_once()


class ResolvedTests(unittest.TestCase):
  def saved(self):
    return dict(backend='networkd',interface='eth0',index=2,address='00:11:22:33:44:55',servers=['192.0.2.53','2001:db8::53'],domains=['example.test','~internal.test'],default_route=False,boot_id='boot')

  def test_snapshot_reads_typed_properties(self):
    values={'DNSOverTLS':'no','DNSEx':[[socket.AF_INET,[192,0,2,53],0,'']], 'DNS':[[socket.AF_INET,[192,0,2,53]]], 'Domains':[['example.test',False],['internal.test',True]],'DefaultRoute':False}
    cmd=Mock(side_effect=lambda args:json.dumps({'data':values[args[-1]]}))
    with patch.object(resolved,'identity',return_value=(2,'00:11:22:33:44:55')),patch.object(resolved.Path,'read_text',return_value='boot'),patch.object(resolved.Path,'resolve',return_value=PurePosixPath('/run/systemd/resolve/stub-resolv.conf')):
      saved=resolved.snapshot(cmd,'eth0')
    self.assertEqual(saved['domains'],['example.test','~internal.test'])
    self.assertEqual(saved['servers'],['192.0.2.53'])
    self.assertFalse(saved['default_route'])

  def test_restore_and_switch_preserve_all_touched_fields(self):
    saved=self.saved()
    for restore in (False,True):
      cmd=Mock(return_value='')
      actual={**saved} if restore else {**saved,'servers':['127.0.0.1'],'domains':['~.'],'default_route':True}
      with patch.object(resolved,'identity',return_value=(2,saved['address'])),patch.object(resolved.Path,'read_text',return_value='boot'),patch.object(resolved,'snapshot',return_value=actual):
        resolved.apply(cmd,saved,restore)
      self.assertEqual(cmd.call_args_list[0].args[0],['sudo','resolvectl','dns','2',*actual['servers']])
      self.assertEqual(cmd.call_args_list[1].args[0],['sudo','resolvectl','domain','2',*actual['domains']])
      self.assertEqual(cmd.call_args_list[2].args[0][-1],'no' if restore else 'yes')

  def test_empty_domain_restore_clears_instead_of_querying(self):
    saved={**self.saved(),'domains':[]}
    cmd=Mock()
    with patch.object(resolved,'identity',return_value=(2,saved['address'])),patch.object(resolved.Path,'read_text',return_value='boot'),patch.object(resolved,'snapshot',return_value=saved):
      resolved.apply(cmd,saved,True)
    self.assertEqual(cmd.call_args_list[1].args[0][-1],'')

  def test_changed_device_refused_before_write(self):
    cmd=Mock()
    with patch.object(resolved,'identity',return_value=(3,'new')):
      with self.assertRaisesRegex(RuntimeError,'identity changed'):resolved.apply(cmd,self.saved(),True)
    cmd.assert_not_called()

  def test_reboot_restore_leaves_new_dhcp_settings(self):
    cmd=Mock(); saved=self.saved()
    with patch.object(resolved,'identity',return_value=(2,saved['address'])),patch.object(resolved.Path,'read_text',return_value='new-boot'):
      resolved.apply(cmd,saved,True)
    cmd.assert_not_called()

  def test_saved_backend_controls_recovery(self):
    with patch.object(resolved,'apply') as apply:
      deploy.DNS('Linux').apply(self.saved(),True)
      self.assertTrue(apply.call_args.args[2])

  def test_verification_failure_keeps_recovery_path(self):
    saved=self.saved();cmd=Mock()
    with patch.object(resolved,'identity',return_value=(2,saved['address'])),patch.object(resolved.Path,'read_text',return_value='boot'),patch.object(resolved,'snapshot',return_value={**saved,'servers':['192.0.2.99']}):
      with self.assertRaisesRegex(RuntimeError,'did not match'):resolved.apply(cmd,saved,True)

if __name__=='__main__':unittest.main()
