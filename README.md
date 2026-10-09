# Rednet Utilities

Small, practical utilities created for home lab projects and shared for general use. This monorepo keeps each utility's implementation, setup instructions, configuration examples, and tests together.

## Utilities

| Utility | Purpose | Runtime |
| --- | --- | --- |
| [Actual Sheet Sync](tools/actual-sheet-sync/README.md) | Keep an Actual Budget ledger and daily account balances in Google Sheets. | Node 24 inside an existing Actual server Docker container; scheduled by the host. |
| [Portable Pi-hole](Networking%20Tools/portable-pihole/README.md) | Start local Pi-hole with automatic host DNS switching and recovery. | Python 3.10+, Docker Compose v2; Windows, macOS, or Ubuntu, Fedora, or Arch Linux (NetworkManager or networkd/resolved). |

Start with the utility's README. Each tool documents its supported versions, operating constraints, data handling, and validation. Production use depends on meeting those requirements and checking the first run in your own environment.

## Repository layout

```text
tools/<utility>/   General utilities
Networking Tools/<utility>/ Networking utilities, tests, and documentation
.github/workflows/ Automated checks
```

Utilities are installed independently; there is no shared runtime or root dependency installation. The repository contains reusable code and examples, not live configuration or home lab deployment records.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations.

## License

Original code in this repository is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.
