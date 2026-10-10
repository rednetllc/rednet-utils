import { GoogleAuth } from "google-auth-library";
import { readFile, stat } from "node:fs/promises";
import {
  HEADERS,
  SyncError,
  check,
  setupRequests,
  publishRequests,
  parseRows,
  mergeById,
  secretScan,
} from "./protocol.mjs";
export async function readPrivate(path) {
  const s = await stat(path);
  check(
    s.isFile() &&
      s.size <= 65536 &&
      (process.platform === "win32" || (s.mode & 0o077) === 0),
    "SECRET_FILE",
    "Secret files must exist, be small, and have private POSIX permissions (0600).",
  );
  return readFile(path, "utf8");
}
export class Sheets {
  constructor(spreadsheetId, client, secrets = []) {
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    this.client = client;
    this.secrets = secrets;
  }
  static async connect(config) {
    const key = JSON.parse(await readPrivate(config.googleKeyFile));
    check(
      key.type === "service_account" &&
        typeof key.private_key === "string" &&
        typeof key.client_email === "string" &&
        key.client_email.endsWith(".iam.gserviceaccount.com") &&
        key.token_uri === "https://oauth2.googleapis.com/token",
      "GOOGLE_KEY",
      "Use a locally stored Google service-account JSON key, shared as Editor on the target sheet.",
    );
    const auth = new GoogleAuth({
      credentials: key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return new Sheets(config.spreadsheetId, await auth.getClient(), [
      key.private_key,
      key.private_key_id,
    ]);
  }
  async request(suffix = "", data) {
    try {
      const r = await this.client.request({
        url: this.base + suffix,
        method: data ? "POST" : "GET",
        ...(data ? { data } : {}),
        timeout: 60000,
        retry: false,
      });
      return r.data;
    } catch (e) {
      const status = e?.response?.status;
      throw new SyncError(
        status === 401 || status === 403 ? "GOOGLE_ACCESS" : "GOOGLE_REQUEST",
        status === 401 || status === 403
          ? "Enable Sheets API and share the target spreadsheet with the service-account email as Editor."
          : "Google Sheets request failed. The next run can safely reconcile by ID.",
      );
    }
  }
  metadata() {
    return this.request(
      "?fields=spreadsheetId,sheets(properties,developerMetadata)",
    );
  }
  async read(meta) {
    const q = new URLSearchParams({
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    for (const [name, columns] of Object.entries(HEADERS)) {
      const sheet = meta.sheets.find((s) => s.properties.title === name);
      check(sheet, "TAB_MISSING", "Run setup once.");
      const count = sheet.properties.gridProperties.rowCount;
      check(count <= 100000, "SHEET_LIMIT");
      q.append(
        "ranges",
        `'${name}'!A1:${String.fromCharCode(64 + columns.length)}${count}`,
      );
    }
    const response = await this.request("/values:batchGet?" + q);
    check(
      response.valueRanges?.length === Object.keys(HEADERS).length,
      "SHEET_READ",
    );
    return Object.fromEntries(
      Object.keys(HEADERS).map((name, i) => [
        name,
        response.valueRanges[i].values ?? [],
      ]),
    );
  }
  async setup() {
    const meta = await this.metadata();
    const requests = setupRequests(meta);
    if (requests.length) await this.request(":batchUpdate", { requests });
    const after = await this.metadata();
    const rows = await this.read(after);
    for (const n of Object.keys(HEADERS)) parseRows(n, rows[n]);
    return { tabs: Object.keys(HEADERS).length };
  }
  async reportStatus(fields, budgetBinding) {
    const meta = await this.metadata();
    const before = await this.read(meta);
    const status = parseRows("Actual_Status", before.Actual_Status);
    const binding = status.find((r) => r.key === "budget_binding")?.value;
    check(!binding || binding === budgetBinding, "BUDGET_CHANGED");
    const values = new Map(status.map((r) => [r.key, r.value]));
    for (const [key, value] of Object.entries(fields)) values.set(key, value);
    const tables = {
      Actual_Status: [...values].map(([key, value]) => ({ key, value })),
    };
    secretScan(tables, this.secrets);
    await this.request(":batchUpdate", {
      requests: publishRequests(meta, before, tables, ["Actual_Status"]),
    });
  }
  async publish(tables, budgetBinding, secrets) {
    const meta = await this.metadata();
    const before = await this.read(meta);
    const status = parseRows("Actual_Status", before.Actual_Status);
    const binding = status.find((r) => r.key === "budget_binding")?.value;
    check(
      !binding || binding === budgetBinding,
      "BUDGET_CHANGED",
      "This sheet already belongs to a different Sync ID; choose a separate sheet.",
    );
    const merged = {
      ...tables,
      Actual_Transactions: mergeById(
        parseRows("Actual_Transactions", before.Actual_Transactions),
        tables.Actual_Transactions,
        { deletions: true },
      ),
      Actual_Balances: mergeById(
        parseRows("Actual_Balances", before.Actual_Balances),
        tables.Actual_Balances,
      ),
      Actual_Status: [
        ...tables.Actual_Status,
        { key: "budget_binding", value: budgetBinding },
      ],
    };
    secretScan(merged, [...secrets, ...this.secrets]);
    const requests = publishRequests(meta, before, merged);
    // One atomic write covers current records, daily balance history and success
    // status. No append request is retried; a later run reconciles stable IDs.
    await this.request(":batchUpdate", { requests });
    const after = await this.read(await this.metadata());
    for (const name of Object.keys(HEADERS)) {
      const rows = parseRows(name, after[name]);
      const expected = merged[name].map((r) =>
        Object.fromEntries(HEADERS[name].map((k) => [k, r[k] ?? ""])),
      );
      check(
        JSON.stringify(rows) === JSON.stringify(expected),
        "READBACK_MISMATCH",
        "Google accepted the write but readback differs; check for concurrent edits before relying on the sheet.",
      );
    }
    return {
      transactions: merged.Actual_Transactions.length,
      accounts: merged.Actual_Accounts.length,
    };
  }
}
