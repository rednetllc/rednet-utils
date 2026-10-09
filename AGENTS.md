# Repository guidance

This public monorepo contains reusable home lab utilities. Read the root README and the relevant tool documentation before making changes.

- Keep each utility under `tools/<utility>/` or `Networking Tools/<utility>/` with its own source, examples, documentation, and tests.
- Keep documentation portable and state supported versions and limits accurately.
- Publish only synthetic examples and placeholders. Exclude personal information, live configuration, credentials, private infrastructure details, and runtime data.
- Do not import private repository history or reference private documents.
- Use focused branches and pull requests for changes. Run the relevant tests and inspect the complete diff before publishing.
- Do not exercise live services or financial data for tests without explicit authorization.
- Do not weaken validation, locking, credential permissions, or source-data checks to make tests pass.
- Update the root index when adding or moving a tool.
