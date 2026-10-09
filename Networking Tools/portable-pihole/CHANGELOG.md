# Changelog

## Unreleased

- Move the tool to `Networking Tools/portable-pihole` and update navigation/CI.
- Add native `start.sh` / `start.ps1` entry points and automatic OS/distro
  prerequisite setup, with explicit installer/reboot and permission boundaries.
- Discover active interfaces and offer a numbered selection screen.
- Add systemd-networkd/systemd-resolved per-link DNS switching and recovery,
  including device and boot identity, alongside existing NetworkManager support.
- Verify NetworkManager settings after profile reapply.
- Cover Ubuntu/Fedora/Arch setup and both Linux backends with synthetic tests.

## 1.0.0

- Import and modernize the public PortablePiHole deployer as a self-contained utility.
- Replace Windows-only hardcoded paths and adapter settings with one Python launcher for Windows, macOS, and NetworkManager-based Linux.
- Preserve previous DNS configuration, check readiness before switching, restore before stopping, and retain interrupted-session recovery data.
- Use Pi-hole v6 configuration, a pinned image, localhost bindings, local password configuration, and a persistent named volume.
- Add setup, platform workflows, recovery and maintenance documentation, synthetic tests, and CI.
