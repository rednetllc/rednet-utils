# Data and troubleshooting

## Spreadsheet data

| Tab | Contents |
| --- | --- |
| Actual_Transactions | Full ledger; missing transactions retain `deleted=true`. |
| Actual_Accounts | Current balances and account details, including closed/off-budget accounts. |
| Actual_Categories | Categories and groups, including hidden categories. |
| Actual_Payees | Payees and transfer-account references. |
| Actual_Monthly | Available months within the previous 12 completed months plus current month. |
| Actual_Schedules | Basic schedule details; amount ranges remain blank. |
| Actual_Balances | One snapshot per account/day; same-day reruns replace that snapshot. |
| Actual_Status | Last successful capture, latest sync outcome, versions, updates, coverage and validation. |

For transaction totals, filter `deleted=false`. Use `include_in_ledger=true` for account totals or `include_in_category=true` for category activity to avoid double-counting splits. Exclude future rows for current totals, and handle transfers and off-budget accounts according to the analysis.

Amounts use signed minor units and a 100:1 display scale, intended for USD or another currency with two fractional digits. No currency conversion occurs. Monthly differences may reflect rollover; they are not a verified cash-availability calculation. Balance history starts with the first run.

Notes, imported descriptions and bank metadata are omitted. Labels remain financial information despite masking obvious long digit sequences.

## Failures

- **Version mismatch:** a difference alone is a warning. Newer stable server versions trigger an exact SDK update; older servers continue with the installed SDK. Actual API errors still stop the run. If `sdk_update=failed_using_existing_sdk`, check registry access, write permissions, Node compatibility, and native build support. Reinstall dependencies and clear only cached SDKs after a Node-major or architecture change.
- **npm install-script notice:** a successful sync confirms the required SQLite binding works; no rebuild is needed just to clear an advisory. Version 1.2.1 declares the required SQLite script approval for both installation and SDK updates. If installation scripts are explicitly disabled, restore the intended npm policy before reinstalling. Deprecation and funding notices alone are not export failures.
- **Google access:** enable Sheets API and share the spreadsheet with the service account's email as Editor. A public edit link alone is insufficient.
- **Changed headers or ownership:** restore the managed tab structure before rerunning. Put manual work in separate tabs.
- **Auto-post schedule detected:** stop scheduling and review the budget configuration. Detection occurs after acquisition and cannot prevent SDK startup posting.
- **Existing lock:** confirm the previous process stopped before removing its `state/*.lock` directory and leftover `state/cache-*` cache. Forced termination can leave these behind.
- **Readback failure:** the Google write may already have succeeded. Check for concurrent edits, then rerun; stable IDs prevent duplicate appends.

`Actual_Status` includes `last_attempt_at`, `run_status` (`success`, `warning`, or `error`), `error_code`, `error_message`, `sdk_version`, `server_version`, `version_mismatch`, `version_mismatch_detected` (before updating), and `sdk_update`. A successful sync clears prior errors. An initial mismatch remains observable even when the SDK update resolves it. Unrecognized server version strings are not copied to Google.

On a failed `sync`, a separate best-effort status-only batch preserves `last_success_at` and existing financial rows. A readback failure may mean financial rows were already committed; status reports the failure rather than claiming rollback. Status writes retain ownership/header/budget-binding checks. If configuration cannot be loaded, a lock cannot be acquired, Google authentication/access fails, tabs are missing, or the process is forcibly terminated, reporting may be impossible. Monitor scheduler exit codes and status freshness as well as the sheet; `STATUS_REPORT_FAILED` identifies a failed reporting attempt. `check` and `setup` do not publish failure status.

A single atomic batch updates the financial tabs and successful status. Limits are 50,000 live transactions, fewer than 100,000 rows per tab, an 8 MiB batch and a five-minute deadline. Oversized runs stop without publishing a partial batch.

Exit codes: 0 success, 7 existing lock, 4 forced deadline, 1 other failure. Logs omit raw SDK errors and credentials. Disable the host scheduler entry to stop scheduled runs.

The synthetic SDK test creates a disposable local budget without server credentials. Its offline fixture import can print an expected unauthorized-upload warning.
