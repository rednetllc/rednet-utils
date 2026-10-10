# Changelog

## 1.2.1

- Declare scoped SQLite install-script approvals for normal installation and automatic SDK updates, removing the manual approval step.
- Verify that a staged SDK can open an in-memory SQLite database before activation; preserve the current SDK when the native binding is unavailable.

## 1.2.0

- Move the exporter to `Server Utilities/actual-sheet-sync` and update CI and repository navigation.
- Permit mismatched Actual versions while retaining API errors and source validation.
- Publish sync errors and version/update diagnostics in `Actual_Status`, preserving last-success metadata on failure.
- Automatically install an exact matching SDK for newer stable servers in isolated local state; retain the existing SDK if installation fails.
- Refresh the transitive Handlebars lockfile entry to 4.7.10 to resolve reported dependency advisories.
- Serialize runs per installation to protect dependency updates. Add `versions.mjs` to deployment files.

## 1.1.0

- Publish a self-contained utility with host-independent Docker installation instructions.
- Document cron, systemd, launchd, and Windows Task Scheduler execution inside an existing Actual server container.
- Default unspecified snapshot timezones to UTC. Existing explicit timezone settings are preserved.
- Provide synthetic examples, contributor guidance, and automated tests without live credentials.

The pinned Actual SDK, supported budget mode, managed spreadsheet format, and reconciliation behavior remain unchanged.
