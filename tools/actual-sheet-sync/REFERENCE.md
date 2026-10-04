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
| Actual_Status | Last successful capture, versions, coverage and validation. |

For transaction totals, filter `deleted=false`. Use `include_in_ledger=true` for account totals or `include_in_category=true` for category activity to avoid double-counting splits. Exclude future rows for current totals, and handle transfers and off-budget accounts according to the analysis.

Amounts use signed minor units and a 100:1 display scale, intended for USD or another currency with two fractional digits. No currency conversion occurs. Monthly differences may reflect rollover; they are not a verified cash-availability calculation. Balance history starts with the first run.

Notes, imported descriptions and bank metadata are omitted. Labels remain financial information despite masking obvious long digit sequences.

## Failures

- **Version mismatch:** use the pinned Actual/API 26.9.0 combination. Reinstall dependencies inside the container after a Node-major or architecture change.
- **Google access:** enable Sheets API and share the spreadsheet with the service account's email as Editor. A public edit link alone is insufficient.
- **Changed headers or ownership:** restore the managed tab structure before rerunning. Put manual work in separate tabs.
- **Auto-post schedule detected:** stop scheduling and review the budget configuration. Detection occurs after acquisition and cannot prevent SDK startup posting.
- **Existing lock:** confirm the previous process stopped before removing its `state/*.lock` directory and leftover `state/cache-*` cache. Forced termination can leave these behind.
- **Readback failure:** the Google write may already have succeeded. Check for concurrent edits, then rerun; stable IDs prevent duplicate appends.

A single atomic batch updates the managed tabs. Limits are 50,000 live transactions, fewer than 100,000 rows per tab, an 8 MiB batch and a five-minute deadline. Oversized runs stop without publishing a partial batch.

Exit codes: 0 success, 7 existing lock, 4 forced deadline, 1 other failure. Logs omit raw SDK errors and credentials. Disable the host scheduler entry to stop scheduled runs.

The synthetic SDK test creates a disposable local budget without server credentials. Its offline fixture import can print an expected unauthorized-upload warning.
