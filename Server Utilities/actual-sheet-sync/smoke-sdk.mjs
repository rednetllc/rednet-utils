// Disposable synthetic budget only. No server, credentials, or Google calls.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "@actual-app/api";
import { readBudget, normalize, SDK_VERSION } from "./source.mjs";
const cache = await mkdtemp(join(tmpdir(), "actual-sheet-smoke-"));
try {
  const engine = await api.init({ dataDir: cache, verbose: false });
  let account, hiddenCategory;
  await api.runImport("Disposable sheet-sync fixture", async () => {
    account = await api.createAccount(
      { name: "Synthetic checking", offbudget: false, closed: false },
      0,
    );
    const group = await api.createCategoryGroup({
      name: "Synthetic group",
      is_income: false,
      hidden: false,
    });
    hiddenCategory = await api.createCategory({
      name: "Hidden synthetic category",
      group_id: group,
      is_income: false,
      hidden: true,
    });
    await api.addTransactions(account, [
      { date: "2026-09-01", amount: 12345 },
      {
        date: "2026-09-02",
        amount: -300,
        subtransactions: [
          { amount: -100, category: hiddenCategory },
          { amount: -200, category: hiddenCategory },
        ],
      },
    ]);
  });
  // Fixture setup only; production source.mjs never changes preferences.
  await engine.send("preferences/save", {
    id: "budgetType",
    value: "tracking",
  });
  await engine.send("preferences/save", {
    id: "defaultCurrencyCode",
    value: "USD",
  });
  const local = (await api.getBudgets()).find((b) => b.state !== "remote");
  assert.ok(local?.id);
  await api.shutdown();
  await api.init({ dataDir: cache, verbose: false });
  await api.loadBudget(local.id);
  const config = { timezone: "UTC", currency: "USD" };
  const raw = await readBudget(api, config, "2026-09-13");
  raw.serverVersion = SDK_VERSION;
  const tables = normalize(raw, config, "2026-09-13", "2026-09-13T12:00:00Z");
  assert.equal(
    tables.Actual_Accounts.find((a) => a.id === account).balance_minor,
    12045,
  );
  assert.equal(tables.Actual_Transactions.length, 4);
  assert.equal(
    tables.Actual_Transactions.filter((t) => t.kind === "split_child").length,
    2,
  );
  assert.equal(
    tables.Actual_Categories.find((c) => c.id === hiddenCategory).hidden,
    true,
  );
  assert.ok(tables.Actual_Monthly.length > 0);
  console.log(
    "Synthetic SDK offline reopen, queries, normalization and balance passed.",
  );
} finally {
  await api.shutdown();
  await rm(cache, { recursive: true, force: true });
}
