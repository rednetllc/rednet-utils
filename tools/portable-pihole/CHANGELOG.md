# Changelog

## 1.0.0

- Import and modernize the public PortablePiHole deployer as a self-contained utility.
- Replace Windows-only hardcoded paths and adapter settings with one Python launcher for Windows, macOS, and NetworkManager-based Linux.
- Preserve previous DNS configuration, check readiness before switching, restore before stopping, and retain interrupted-session recovery data.
- Use Pi-hole v6 configuration, a pinned image, localhost bindings, local password configuration, and a persistent named volume.
- Add setup, platform workflows, recovery and maintenance documentation, synthetic tests, and CI.
