export const OWNER = "actual-sheet-sync:v1";
export const HEADERS = {
  Actual_Transactions: [
    "id",
    "date",
    "account_id",
    "account",
    "category_id",
    "category",
    "payee_id",
    "payee",
    "amount_minor",
    "amount",
    "kind",
    "parent_id",
    "transfer_id",
    "cleared",
    "reconciled",
    "starting_balance",
    "include_in_ledger",
    "include_in_category",
    "is_future",
    "deleted",
  ],
  Actual_Accounts: [
    "id",
    "name",
    "offbudget",
    "closed",
    "balance_minor",
    "balance",
    "as_of_date",
    "currency",
  ],
  Actual_Categories: ["id", "name", "group_id", "group", "is_income", "hidden"],
  Actual_Payees: ["id", "name", "transfer_account_id"],
  Actual_Monthly: [
    "id",
    "month",
    "category_id",
    "category",
    "is_income",
    "planned_minor",
    "displayed_actual_minor",
    "displayed_balance_minor",
    "carryover",
    "date_activity_minor",
    "difference_minor",
    "semantics",
  ],
  Actual_Schedules: [
    "id",
    "name",
    "next_date",
    "account_id",
    "payee_id",
    "amount_minor",
    "amount_rule",
    "auto_post",
    "completed",
  ],
  Actual_Balances: [
    "id",
    "date",
    "account_id",
    "account",
    "balance_minor",
    "balance",
    "offbudget",
    "closed",
    "captured_at",
    "currency",
  ],
  Actual_Status: ["key", "value"],
};
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function check(
  ok,
  code = "DATA_INVALID",
  message = "Check the configuration, source data, and documented requirements.",
) {
  if (!ok) throw new SyncError(code, message);
}
export function total(values) {
  let n = 0;
  for (const value of values) {
    check(Number.isSafeInteger(value), "AMOUNT_INVALID");
    n += value;
    check(Number.isSafeInteger(n), "AMOUNT_OVERFLOW");
  }
  return n;
}
export function dateOK(s) {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + "T12:00:00Z")) &&
    new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s
  );
}
export function todayIn(zone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k).value)
    .join("-");
}
export const label = (value) => {
  check(typeof value === "string" && value.length <= 4096, "LABEL_INVALID");
  return value.replace(/\b\d(?:[ -]?\d){6,}\b/g, "[redacted-number]");
};
export function unique(rows) {
  const m = new Map();
  for (const r of rows) {
    check(
      typeof r.id === "string" &&
        r.id.length > 0 &&
        r.id.length <= 256 &&
        !m.has(r.id),
      "DUPLICATE_OR_MISSING_ID",
    );
    m.set(r.id, r);
  }
  return m;
}
export function secretScan(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean))
    check(
      !text.includes(secret),
      "SECRET_IN_OUTPUT",
      "A credential matched outgoing data; no sheet update was sent.",
    );
}
export const rowValues = (name, rows) =>
  rows.map((r) => HEADERS[name].map((k) => r[k] ?? ""));
export function mergeById(existing, incoming, { deletions = false } = {}) {
  const old = unique(existing),
    fresh = unique(incoming);
  const result = [];
  for (const [id, row] of old) {
    if (fresh.has(id)) {
      result.push(fresh.get(id));
      fresh.delete(id);
    } else result.push(deletions ? { ...row, deleted: true } : row);
  }
  for (const row of fresh.values()) result.push(row);
  return result;
}
const cell = (value) => ({
  userEnteredValue:
    typeof value === "number"
      ? { numberValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: String(value ?? "") },
});
export function writeRequest(sheetId, name, rows) {
  const values = [HEADERS[name], ...rowValues(name, rows)];
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: values.length,
        startColumnIndex: 0,
        endColumnIndex: HEADERS[name].length,
      },
      rows: values.map((v) => ({ values: v.map(cell) })),
      fields: "userEnteredValue",
    },
  };
}
export function setupRequests(meta) {
  const requests = [];
  let id = Math.max(0, ...meta.sheets.map((s) => s.properties.sheetId)) + 1;
  for (const [name, columns] of Object.entries(HEADERS)) {
    const existing = meta.sheets.find((s) => s.properties.title === name);
    if (existing) {
      check(
        existing.developerMetadata?.some(
          (m) =>
            m.metadataKey === "actual-sheet-sync" && m.metadataValue === OWNER,
        ),
        "TAB_NOT_OWNED",
        "A matching tab exists without the script ownership marker. Preserve it and resolve the name collision.",
      );
      continue;
    }
    const sheetId = id++;
    requests.push(
      {
        addSheet: {
          properties: {
            sheetId,
            title: name,
            gridProperties: {
              rowCount: 1000,
              columnCount: Math.max(10, columns.length),
              frozenRowCount: 1,
            },
          },
        },
      },
      {
        createDeveloperMetadata: {
          developerMetadata: {
            metadataKey: "actual-sheet-sync",
            metadataValue: OWNER,
            visibility: "DOCUMENT",
            location: { sheetId },
          },
        },
      },
      writeRequest(sheetId, name, []),
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: columns.length,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
              textFormat: { bold: true },
              wrapStrategy: "WRAP",
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: columns.length,
          },
          properties: { pixelSize: 160 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 42 },
          fields: "pixelSize",
        },
      },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1000,
              startColumnIndex: 0,
              endColumnIndex: columns.length,
            },
          },
        },
      },
    );
  }
  return requests;
}
export function publishRequests(
  meta,
  previous,
  tables,
  names = Object.keys(HEADERS),
) {
  const requests = [];
  for (const name of names) {
    const columns = HEADERS[name];
    const sheet = meta.sheets.find((s) => s.properties.title === name);
    check(sheet, "TAB_MISSING", "Run setup once before scheduling sync.");
    check(
      sheet.developerMetadata?.some(
        (m) =>
          m.metadataKey === "actual-sheet-sync" && m.metadataValue === OWNER,
      ),
      "TAB_NOT_OWNED",
    );
    const before = previous[name] ?? [];
    check(
      JSON.stringify(before[0]) === JSON.stringify(columns),
      "HEADERS_CHANGED",
      "A managed header changed; no update was sent.",
    );
    const sheetId = sheet.properties.sheetId,
      rows = tables[name];
    check(rows.length < 100000, "ROW_LIMIT");
    const needed = rows.length + 1;
    if (needed > sheet.properties.gridProperties.rowCount)
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { rowCount: needed } },
          fields: "gridProperties.rowCount",
        },
      });
    requests.push(writeRequest(sheetId, name, rows));
    if (before.length > needed)
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: needed,
            endRowIndex: before.length,
            startColumnIndex: 0,
            endColumnIndex: columns.length,
          },
          cell: {},
          fields: "userEnteredValue",
        },
      });
    requests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: Math.max(2, needed),
            startColumnIndex: 0,
            endColumnIndex: columns.length,
          },
        },
      },
    });
  }
  check(
    Buffer.byteLength(JSON.stringify({ requests })) <= 8 * 1024 * 1024,
    "BATCH_TOO_LARGE",
    "The sheet update exceeds the 8 MiB script limit; no partial update was sent.",
  );
  return requests;
}
export function parseRows(name, values) {
  check(
    JSON.stringify(values?.[0]) === JSON.stringify(HEADERS[name]),
    "HEADERS_CHANGED",
  );
  return values
    .slice(1)
    .filter((r) => r.some((v) => v !== "" && v !== null))
    .map((r) =>
      Object.fromEntries(HEADERS[name].map((k, i) => [k, r[i] ?? ""])),
    );
}
