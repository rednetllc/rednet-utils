# Contributing

Keep each utility self-contained under `tools/<utility>/`. A new utility should include a README with its purpose, prerequisites, installation, configuration, execution, scheduling where applicable, failure recovery, and known limits. Add it to the root utility index.

Use a focused branch and pull request. Explain the problem, resulting behavior, and validation. Test changed behavior with synthetic fixtures; do not require live accounts, production services, or personal data in automated tests. Preserve unrelated tools and their interfaces.

For Actual Sheet Sync:

```sh
cd tools/actual-sheet-sync
npm ci
npm test
npm run test:sdk
```

Use Node 24. The SDK test creates and removes a disposable local budget; it needs no Actual server or Google credentials. Dependency installation requires registry access.

For Portable Pi-hole, use Python 3.10+ and Docker Compose v2.20+:

```sh
cd tools/portable-pihole
python3 -m unittest -v test_deploy
```

On Windows, use `py -3` in place of `python3`. Tests use synthetic DNS settings and mocked OS/Docker operations; Compose configuration checks need only the CLI, not a daemon. Do not change the test host's DNS or start a live resolver as part of automated tests.

Before submitting, check documentation links, dependency lockfiles, and the full diff for private material. Use placeholders for account IDs, spreadsheet IDs, credentials, names, addresses, hostnames, and deployment paths. Do not attach real budget exports, logs, screenshots, local configuration, databases, or secret files to issues or pull requests. Use a minimal synthetic reproduction.

Dependency and runtime upgrades must be tested together. Update supported-version documentation when compatibility changes. Passing synthetic tests does not establish compatibility with every server image or prove a live sync succeeded.
