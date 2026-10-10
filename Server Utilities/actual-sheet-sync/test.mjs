import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  chmod,
  rm,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADERS,
  OWNER,
  mergeById,
  parseRows,
  publishRequests,
  setupRequests,
  secretScan,
  todayIn,
} from "./protocol.mjs";
import { normalize, acquire, SDK_VERSION } from "./source.mjs";
import { Sheets, readPrivate } from "./sheets.mjs";
import { newer, release, updateSdk, currentSdk } from "./versions.mjs";
import { configFrom, runWorker } from "./sync.mjs";
const config = { currency: "USD", timezone: "America/New_York" };
function fixture() {
  return {
    preferences: { budgetType: "tracking", defaultCurrencyCode: "USD" },
    serverVersion: SDK_VERSION,
    accounts: [
      { id: "a", name: "Cash", offbudget: false, closed: false },
      { id: "b", name: "Closed savings", offbudget: false, closed: true },
    ],
    categories: [
      { id: "c", name: "Food", group_id: "g", is_income: false, hidden: false },
    ],
    groups: [{ id: "g", name: "Expenses" }],
    payees: [{ id: "p", name: "Shop" }],
    transactions: [
      {
        id: "opening",
        account: "a",
        amount: 10000,
        date: "2025-12-31",
        starting_balance_flag: true,
      },
      {
        id: "parent",
        account: "a",
        amount: -3000,
        date: "2026-01-01",
        is_parent: true,
      },
      {
        id: "child1",
        parent_id: "parent",
        is_child: true,
        account: "a",
        category: "c",
        payee: "p",
        amount: -1000,
        date: "2026-01-01",
      },
      {
        id: "child2",
        parent_id: "parent",
        is_child: true,
        account: "a",
        category: "c",
        payee: "p",
        amount: -2000,
        date: "2026-01-01",
      },
      {
        id: "out",
        account: "a",
        amount: -5000,
        date: "2026-01-02",
        transfer_id: "in",
      },
      {
        id: "in",
        account: "b",
        amount: 5000,
        date: "2026-01-02",
        transfer_id: "out",
      },
      {
        id: "refund",
        account: "a",
        amount: 500,
        date: "2026-01-03",
        category: "c",
        payee: "p",
      },
      {
        id: "future",
        account: "a",
        amount: -200,
        date: "2027-01-01",
        category: "c",
      },
    ],
    balances: { a: 2500, b: 5000 },
    schedules: [],
    months: [
      {
        month: "2026-01",
        categoryGroups: [
          {
            categories: [
              {
                id: "c",
                name: "Food",
                is_income: false,
                budgeted: 5000,
                spent: -2500,
                balance: 2500,
                carryover: false,
              },
            ],
          },
        ],
      },
    ],
  };
}
function tables() {
  return normalize(fixture(), config, "2026-01-31", "2026-01-31T15:00:00Z");
}
function metadata() {
  return {
    sheets: Object.keys(HEADERS).map((title, i) => ({
      properties: {
        title,
        sheetId: i + 1,
        gridProperties: { rowCount: 1000, columnCount: 26 },
      },
      developerMetadata: [
        { metadataKey: "actual-sheet-sync", metadataValue: OWNER },
      ],
    })),
  };
}
const empty = () =>
  Object.fromEntries(Object.entries(HEADERS).map(([n, h]) => [n, [h]]));
test("split flags, independent balance and refunds stay in signed cents", () => {
  const t = tables();
  assert.equal(t.Actual_Accounts[0].balance_minor, 2500);
  assert.equal(
    t.Actual_Transactions.find((t) => t.id === "child1").include_in_ledger,
    false,
  );
  assert.equal(
    t.Actual_Transactions.find((t) => t.id === "parent").include_in_category,
    false,
  );
  assert.equal(t.Actual_Monthly[0].date_activity_minor, -2500);
  assert.equal(
    t.Actual_Transactions.find((t) => t.id === "future").is_future,
    true,
  );
  assert.equal(t.Actual_Accounts[1].closed, true);
});
test("invalid split, independent anchor, missing reference and transfer fail", () => {
  for (const mutate of [
    (r) => r.transactions[2].amount++,
    (r) => r.balances.a++,
    (r) => (r.transactions[0].account = "missing"),
    (r) => (r.transactions[5].transfer_id = "missing"),
  ]) {
    const r = fixture();
    mutate(r);
    assert.throws(() =>
      normalize(r, config, "2026-01-31", "2026-01-31T15:00:00Z"),
    );
  }
});
test("auto-post configuration change and wrong mode fail", () => {
  const r = fixture();
  r.schedules = [{ id: "s", name: "Schedule", posts_transaction: true }];
  assert.throws(() =>
    normalize(r, config, "2026-01-31", "2026-01-31T15:00:00Z"),
  );
  r.schedules = [];
  r.preferences.budgetType = "envelope";
  assert.throws(() =>
    normalize(r, config, "2026-01-31", "2026-01-31T15:00:00Z"),
  );
});
test("notes, bank metadata, imported descriptions never enter mapped tables", () => {
  const r = fixture();
  r.transactions[0].notes = "SENTINEL_PRIVATE";
  r.transactions[0].raw_synced_data = "SENTINEL_PRIVATE";
  r.accounts[0].name = "Cash 123456789";
  const t = normalize(r, config, "2026-01-31", "2026-01-31T15:00:00Z");
  assert.ok(!JSON.stringify(t).includes("SENTINEL_PRIVATE"));
  assert.match(t.Actual_Accounts[0].name, /redacted/);
  assert.throws(() => secretScan(t, ["Cash"]));
});
test("transaction upsert is idempotent, captures edits, and marks deletion", () => {
  const old = [
    { id: "one", amount: 5, deleted: false },
    { id: "two", amount: 8, deleted: false },
  ];
  const input = [
    { id: "one", amount: 6, deleted: false },
    { id: "three", amount: 8, deleted: false },
  ];
  const first = mergeById(old, input, { deletions: true });
  assert.deepEqual(first, [input[0], { ...old[1], deleted: true }, input[1]]);
  assert.deepEqual(mergeById(first, input, { deletions: true }), first);
  assert.throws(() => mergeById([], [input[0], input[0]]));
});
test("balance snapshots keep history and replace same-day IDs", () => {
  const old = [
    { id: "2026-01-01/a", balance: 1 },
    { id: "2026-01-02/a", balance: 2 },
  ];
  assert.deepEqual(mergeById(old, [{ id: "2026-01-02/a", balance: 3 }]), [
    old[0],
    { id: "2026-01-02/a", balance: 3 },
  ]);
});
test("setup adds managed tabs, preserves preexisting Sheet1 and fails collisions", () => {
  const requests = setupRequests({
    sheets: [{ properties: { title: "Sheet1", sheetId: 0 } }],
  });
  assert.equal(requests.filter((r) => r.addSheet).length, 8);
  assert.ok(!requests.some((r) => r.deleteSheet));
  assert.deepEqual(setupRequests(metadata()), []);
  assert.throws(() =>
    setupRequests({
      sheets: [{ properties: { title: "Actual_Transactions", sheetId: 4 } }],
    }),
  );
});
test("typed Sheets cells cannot execute label formulas", () => {
  const t = tables();
  t.Actual_Payees[0].name = '=IMPORTXML("https://example.invalid")';
  const requests = publishRequests(metadata(), empty(), t);
  const p = requests.find((r) => r.updateCells?.range.sheetId === 4);
  assert.equal(
    p.updateCells.rows[1].values[1].userEnteredValue.stringValue,
    t.Actual_Payees[0].name,
  );
  assert.ok(!JSON.stringify(requests).includes("formulaValue"));
});
test("changed headers and removed ownership markers block writes", () => {
  const before = empty();
  before.Actual_Accounts[0] = ["unexpected"];
  assert.throws(() => publishRequests(metadata(), before, tables()));
  const meta = metadata();
  meta.sheets[0].developerMetadata = [];
  assert.throws(() => publishRequests(meta, empty(), tables()));
});
test("calendar snapshot day follows New York", () => {
  assert.equal(
    todayIn("America/New_York", new Date("2026-01-01T01:00:00Z")),
    "2025-12-31",
  );
});
test("private credential files enforce permissions and no logging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actual-sheet-test-"));
  try {
    const p = join(dir, "secret");
    await writeFile(p, "  pass  \n", { mode: 0o600 });
    assert.equal(await readPrivate(p), "  pass  \n");
    await chmod(p, 0o644);
    await assert.rejects(readPrivate(p));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("config allows loopback only and resolves secret paths locally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actual-config-"));
  try {
    const path = join(dir, "config.json");
    const data = {
      spreadsheetId: "synthetic-sheet-identifier",
      googleKeyFile: "key.json",
      serverUrl: "http://127.0.0.1:5006",
    };
    await writeFile(path, JSON.stringify(data));
    assert.equal((await configFrom(path)).googleKeyFile, join(dir, "key.json"));
    assert.equal((await configFrom(path)).timezone, "UTC");
    await writeFile(
      path,
      JSON.stringify({ ...data, timezone: "Pacific/Auckland" }),
    );
    assert.equal((await configFrom(path)).timezone, "Pacific/Auckland");
    await writeFile(
      path,
      JSON.stringify({ ...data, timezone: "Invalid/Timezone" }),
    );
    await assert.rejects(configFrom(path));
    await writeFile(
      path,
      JSON.stringify({ ...data, serverUrl: "http://public.example.com" }),
    );
    await assert.rejects(configFrom(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("config accepts container loopback forms but rejects credential-bearing and nonlocal URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actual-config-"));
  try {
    const path = join(dir, "config.json");
    const data = {
      spreadsheetId: "synthetic-sheet-identifier",
      googleKeyFile: "key.json",
    };
    for (const serverUrl of [
      "http://localhost:5006",
      "http://[::1]:5006",
      "http://127.0.0.1:8080",
    ]) {
      await writeFile(path, JSON.stringify({ ...data, serverUrl }));
      assert.equal((await configFrom(path)).serverUrl, serverUrl);
    }
    for (const serverUrl of [
      "http://actual-server:5006",
      "http://host.docker.internal:5006",
      "http://user:password@localhost:5006",
      "http://localhost:5006/?token=synthetic",
      "http://localhost:5006/#synthetic",
      "http://localhost:5006/path",
      "file:///tmp/budget",
    ]) {
      await writeFile(path, JSON.stringify({ ...data, serverUrl }));
      await assert.rejects(configFrom(path), { code: "LOCALHOST_REQUIRED" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("version mismatch permits download and propagates actual download errors", async () => {
  let downloaded = false,
    closed = false;
  const fake = {
    init: async () => {},
    getServerVersion: async () => ({ version: "26.8.0" }),
    getBudgets: async () => [{ groupId: "id", encryptKeyId: "encrypted" }],
    downloadBudget: async () => {
      downloaded = true;
      throw new Error("synthetic download failure");
    },
    shutdown: async () => {
      closed = true;
    },
  };
  await assert.rejects(
    acquire(
      fake,
      { ...config, serverUrl: "http://127.0.0.1:5006", syncId: "id" },
      { password: "fake", encryptionPassword: "fake2" },
      "/unused",
    ),
    /synthetic download failure/,
  );
  assert.equal(downloaded, true);
  assert.equal(closed, true);
});
test("plain budget rejected before download despite supplied encryption password", async () => {
  let downloaded = false;
  const fake = {
    init: async () => {},
    getServerVersion: async () => ({ version: SDK_VERSION }),
    getBudgets: async () => [{ groupId: "id" }],
    downloadBudget: async () => {
      downloaded = true;
    },
    shutdown: async () => {},
  };
  await assert.rejects(
    acquire(
      fake,
      { ...config, serverUrl: "http://127.0.0.1:5006", syncId: "id" },
      { password: "fake", encryptionPassword: "fake2" },
      "/unused",
    ),
  );
  assert.equal(downloaded, false);
});
test("mismatched server exports successfully using offline reads and no explicit write API", async () => {
  let offline = false,
    downloaded = false;
  const fixtureData = fixture();
  const calls = [];
  const fake = new Proxy(
    {
      init: async (c) => {
        offline = !c.serverURL;
        calls.push(offline ? "offline-init" : "online-init");
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
      getServerVersion: async () => ({ version: "26.8.0" }),
      getBudgets: async () =>
        downloaded
          ? [{ groupId: "id", id: "local" }]
          : [{ groupId: "id", encryptKeyId: "encrypted" }],
      downloadBudget: async () => {
        downloaded = true;
        calls.push("download");
      },
      loadBudget: async () => {
        assert.equal(offline, true);
      },
      getPreferences: async () => {
        assert.equal(offline, true);
        return fixtureData.preferences;
      },
      getAccounts: async () => fixtureData.accounts,
      getCategories: async () => fixtureData.categories,
      getCategoryGroups: async () => fixtureData.groups,
      getPayees: async () => fixtureData.payees,
      getSchedules: async () => [],
      q: () => ({
        select() {
          return this;
        },
        options() {
          return this;
        },
      }),
      aqlQuery: async () => ({ data: fixtureData.transactions }),
      getAccountBalance: async (id) => fixtureData.balances[id],
      getBudgetMonths: async () => ["2026-01"],
      getBudgetMonth: async (month) => ({ ...fixtureData.months[0], month }),
    },
    {
      get(target, k) {
        assert.ok(k in target, `Unexpected SDK access ${String(k)}`);
        return target[k];
      },
    },
  );
  const result = await acquire(
    fake,
    { ...config, serverUrl: "http://127.0.0.1:5006", syncId: "id" },
    { password: "fake", encryptionPassword: "fake2" },
    "/unused",
  );
  assert.equal(
    result.Actual_Status.find((r) => r.key === "server_version").value,
    "26.8.0",
  );
  assert.equal(result.Actual_Accounts[0].balance_minor, 2500);
  assert.deepEqual(calls, [
    "online-init",
    "download",
    "shutdown",
    "offline-init",
    "shutdown",
  ]);
});
test("Google errors are sanitized and mutations are never automatically retried", async () => {
  const s = new Sheets("synthetic-sheet", {
    request: async (options) => {
      assert.equal(options.retry, false);
      throw { response: { status: 403 }, message: "PRIVATE_TOKEN" };
    },
  });
  await assert.rejects(
    s.request(":batchUpdate", { requests: [] }),
    (e) => e.code === "GOOGLE_ACCESS" && !e.message.includes("PRIVATE_TOKEN"),
  );
});
test("publisher makes one atomic batch and verifies typed row readback", async () => {
  const s = new Sheets("synthetic-sheet", {});
  s.metadata = async () => metadata();
  let snapshot = empty(),
    writes = 0;
  s.read = async () => snapshot;
  s.request = async (suffix, body) => {
    assert.equal(suffix, ":batchUpdate");
    writes++;
    for (const request of body.requests)
      if (request.updateCells) {
        const name =
          Object.keys(HEADERS)[request.updateCells.range.sheetId - 1];
        snapshot[name] = request.updateCells.rows.map((r) =>
          r.values.map((c) => Object.values(c.userEnteredValue)[0]),
        );
      }
    return {};
  };
  const t = tables();
  await s.publish(t, "binding", []);
  await s.publish(t, "binding", []);
  assert.equal(writes, 2);
  assert.equal(
    parseRows("Actual_Balances", snapshot.Actual_Balances).length,
    2,
  );
  await assert.rejects(s.publish(t, "different-budget", []));
  assert.equal(writes, 2);
});

test("updates compare numeric releases and reject package/path injection", () => {
  assert.equal(newer("26.10.0", "26.9.0"), true);
  assert.equal(newer("26.9.1", "26.9.0"), true);
  for (const version of [
    "26.9.0",
    "26.8.0",
    "26.10.0-beta.1",
    "latest",
    "../../bad",
    "26.10.0;echo bad",
  ])
    assert.equal(newer(version, "26.9.0"), false);
  assert.equal(release("26.10.0"), true);
});
test("failed SDK installation leaves active selection intact and removes staging", async () => {
  const state = await mkdtemp(join(tmpdir(), "actual-upgrade-"));
  try {
    await writeFile(join(state, "sdk-version"), "26.9.0");
    await assert.rejects(
      updateSdk(state, "26.10.0", undefined, async () => {
        throw new Error("synthetic registry failure");
      }),
    );
    assert.equal(await readFile(join(state, "sdk-version"), "utf8"), "26.9.0");
    assert.deepEqual(await readdir(state), ["sdk-version"]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
test("successful SDK update activates exact version for future fresh workers", async () => {
  const state = await mkdtemp(join(tmpdir(), "actual-upgrade-"));
  try {
    const sdk = await updateSdk(
      state,
      "26.10.0",
      undefined,
      async (cmd, args, options) => {
        assert.equal(cmd, "npm");
        assert.ok(args.includes("--registry=https://registry.npmjs.org"));
        const pkg = JSON.parse(
          await readFile(join(options.cwd, "package.json"), "utf8"),
        );
        assert.equal(pkg.dependencies["@actual-app/api"], "26.10.0");
        assert.deepEqual(pkg.allowScripts, { "better-sqlite3": true });
        const base = join(options.cwd, "node_modules/@actual-app/api");
        await mkdir(join(base, "lib"), { recursive: true });
        await writeFile(
          join(base, "package.json"),
          JSON.stringify({ version: "26.10.0", main: "lib/index.js" }),
        );
        await writeFile(join(base, "lib/index.js"), "module.exports = {};");
        const sqlite = join(options.cwd, "node_modules/better-sqlite3");
        await mkdir(sqlite, { recursive: true });
        await writeFile(
          join(sqlite, "index.js"),
          'module.exports = class { constructor(path) { if (path !== ":memory:") throw new Error("Unexpected database"); } close() {} };',
        );
      },
    );
    assert.equal(sdk.version, "26.10.0");
    assert.deepEqual(await currentSdk("/unused", state), sdk);
    assert.ok(
      !(await readdir(state)).some((name) => name.startsWith("sdk-install-")),
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
test("failure reporting updates only status and preserves success and binding", async () => {
  const s = new Sheets("synthetic-sheet", {});
  const before = empty();
  before.Actual_Status.push(
    ["last_success_at", "2026-01-01"],
    ["budget_binding", "synthetic-binding"],
  );
  s.metadata = async () => metadata();
  s.read = async () => before;
  let requests;
  s.request = async (_, body) => {
    requests = body.requests;
  };
  await s.reportStatus(
    { run_status: "error", error_code: "ACTUAL_FAILED" },
    "synthetic-binding",
  );
  const statusId = metadata().sheets.find(
    (s) => s.properties.title === "Actual_Status",
  ).properties.sheetId;
  for (const request of requests) {
    const target =
      request.updateCells?.range ??
      request.repeatCell?.range ??
      request.setBasicFilter?.filter.range ??
      request.updateSheetProperties?.properties;
    assert.equal(target.sheetId, statusId);
  }
  assert.match(JSON.stringify(requests), /2026-01-01/);
  assert.match(JSON.stringify(requests), /synthetic-binding/);
  await assert.rejects(
    s.reportStatus({ run_status: "error" }, "wrong-binding"),
    { code: "BUDGET_CHANGED" },
  );
  before.Actual_Status[0] = ["wrong", "header"];
  await assert.rejects(
    s.reportStatus({ run_status: "error" }, "synthetic-binding"),
    { code: "HEADERS_CHANGED" },
  );
});

test("worker probes selected SDK in a fresh process and returns sanitized errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actual-worker-"));
  try {
    const entry = join(dir, "sdk.mjs");
    await writeFile(
      entry,
      'export async function init() {} export async function shutdown() {} export async function getServerVersion() {return {version: "26.10.0"}}',
    );
    const sdk = { version: "26.10.0", entry };
    const controller = new AbortController();
    assert.deepEqual(
      await runWorker(config, {}, dir, controller.signal, sdk, true),
      { version: "26.10.0" },
    );
    await writeFile(
      entry,
      'export async function init() {throw new Error("PRIVATE_TOKEN")} export async function shutdown() {}',
    );
    await assert.rejects(
      runWorker(config, {}, dir, controller.signal, sdk, true),
      (e) => e.code === "ACTUAL_FAILED" && !e.message.includes("PRIVATE_TOKEN"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK import success with broken SQLite binding does not activate update", async () => {
  const state = await mkdtemp(join(tmpdir(), "actual-upgrade-"));
  try {
    await writeFile(join(state, "sdk-version"), "26.9.0");
    await assert.rejects(
      updateSdk(state, "26.10.0", undefined, async (_cmd, _args, options) => {
        const base = join(options.cwd, "node_modules/@actual-app/api");
        await mkdir(join(base, "lib"), { recursive: true });
        await writeFile(
          join(base, "package.json"),
          JSON.stringify({ version: "26.10.0", main: "lib/index.js" }),
        );
        await writeFile(join(base, "lib/index.js"), "module.exports = {};");
        const sqlite = join(options.cwd, "node_modules/better-sqlite3");
        await mkdir(sqlite, { recursive: true });
        await writeFile(
          join(sqlite, "index.js"),
          'module.exports = class { constructor() { throw new Error("Missing native binding"); } };',
        );
      }),
      /Missing native binding/,
    );
    assert.equal(await readFile(join(state, "sdk-version"), "utf8"), "26.9.0");
    assert.deepEqual(await readdir(state), ["sdk-version"]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
