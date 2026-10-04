import { check, total, dateOK, label, unique, todayIn } from "./protocol.mjs";
export const SDK_VERSION = "26.9.0";
export const TX_FIELDS = [
  "id",
  "date",
  "account",
  "category",
  "payee",
  "amount",
  "is_parent",
  "is_child",
  "parent_id",
  "transfer_id",
  "cleared",
  "reconciled",
  "starting_balance_flag",
];
export function normalize(raw, config, asOf, capturedAt) {
  const accounts = unique(raw.accounts),
    cats = unique(raw.categories),
    payees = unique(raw.payees),
    groups = unique(raw.groups),
    tx = unique(raw.transactions);
  check(
    raw.preferences.budgetType === "tracking",
    "BUDGET_MODE",
    "The budget must already use tracking mode.",
  );
  check(
    !raw.preferences.defaultCurrencyCode ||
      raw.preferences.defaultCurrencyCode === config.currency,
    "CURRENCY_MISMATCH",
  );
  const children = new Map();
  const activity = new Map();
  for (const t of tx.values()) {
    check(
      dateOK(t.date) && Number.isSafeInteger(t.amount),
      "TRANSACTION_INVALID",
    );
    check(
      accounts.has(t.account) &&
        (!t.category || cats.has(t.category)) &&
        (!t.payee || payees.has(t.payee)),
      "REFERENCE_MISSING",
    );
    check(
      !(t.is_parent && t.is_child) &&
        Boolean(t.is_child) === Boolean(t.parent_id),
      "SPLIT_INVALID",
    );
    if (t.is_child) {
      const p = tx.get(t.parent_id);
      check(
        p?.is_parent && p.account === t.account && p.date === t.date,
        "SPLIT_INVALID",
      );
      const list = children.get(t.parent_id) ?? [];
      list.push(t.amount);
      children.set(t.parent_id, list);
    }
    if (t.transfer_id) {
      const p = tx.get(t.transfer_id);
      check(
        p &&
          p.transfer_id === t.id &&
          p.account !== t.account &&
          !t.is_parent &&
          total([t.amount, p.amount]) === 0,
        "TRANSFER_INVALID",
      );
    }
    if (!t.is_parent && t.category && !accounts.get(t.account).offbudget) {
      const k = JSON.stringify([t.date.slice(0, 7), t.category]);
      activity.set(k, total([activity.get(k) ?? 0, t.amount]));
    }
  }
  for (const t of tx.values())
    if (t.is_parent)
      check(
        (children.get(t.id)?.length ?? 0) >= 2 &&
          total(children.get(t.id)) === t.amount,
        "SPLIT_SUM",
      );
  const accountRows = raw.accounts.map((a) => {
    const balance = total(
      raw.transactions
        .filter((t) => t.account === a.id && !t.is_parent && t.date <= asOf)
        .map((t) => t.amount),
    );
    check(
      balance === raw.balances[a.id],
      "BALANCE_MISMATCH",
      "Actual balance and extracted ledger disagree; no sheet update was sent.",
    );
    return {
      id: a.id,
      name: label(a.name),
      offbudget: Boolean(a.offbudget),
      closed: Boolean(a.closed),
      balance_minor: balance,
      balance: balance / 100,
      as_of_date: asOf,
      currency: config.currency,
    };
  });
  const transactions = raw.transactions
    .map((t) => ({
      id: t.id,
      date: t.date,
      account_id: t.account,
      account: label(accounts.get(t.account).name),
      category_id: t.category ?? "",
      category: t.category ? label(cats.get(t.category).name) : "",
      payee_id: t.payee ?? "",
      payee: t.payee ? label(payees.get(t.payee).name) : "",
      amount_minor: t.amount,
      amount: t.amount / 100,
      kind: t.is_parent
        ? "split_parent"
        : t.is_child
          ? "split_child"
          : "normal",
      parent_id: t.parent_id ?? "",
      transfer_id: t.transfer_id ?? "",
      cleared: Boolean(t.cleared),
      reconciled: Boolean(t.reconciled),
      starting_balance: Boolean(t.starting_balance_flag),
      include_in_ledger: !t.is_child,
      include_in_category: !t.is_parent,
      is_future: t.date > asOf,
      deleted: false,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const monthly = [];
  for (const m of raw.months)
    for (const g of m.categoryGroups)
      for (const c of g.categories ?? []) {
        check(cats.has(c.id), "MONTH_CATEGORY");
        const actual = c.is_income ? c.received : c.spent;
        check(
          [c.budgeted, actual, c.balance].every(Number.isSafeInteger),
          "MONTH_SHAPE",
        );
        check(
          c.carryover === undefined ||
            typeof c.carryover === "boolean" ||
            Number.isSafeInteger(c.carryover),
          "MONTH_SHAPE",
        );
        const amount = activity.get(JSON.stringify([m.month, c.id])) ?? 0;
        monthly.push({
          id: `${m.month}/${c.id}`,
          month: m.month,
          category_id: c.id,
          category: label(c.name),
          is_income: Boolean(c.is_income),
          planned_minor: c.budgeted,
          displayed_actual_minor: actual,
          displayed_balance_minor: c.balance,
          carryover: c.carryover ?? "",
          date_activity_minor: amount,
          difference_minor: total([actual, -amount]),
          semantics:
            "Tracking display; difference may include rollover; not available cash",
        });
      }
  unique(monthly);
  return {
    Actual_Transactions: transactions,
    Actual_Accounts: accountRows,
    Actual_Categories: raw.categories.map((c) => {
      check(groups.has(c.group_id), "GROUP_MISSING");
      return {
        id: c.id,
        name: label(c.name),
        group_id: c.group_id,
        group: label(groups.get(c.group_id).name),
        is_income: Boolean(c.is_income),
        hidden: Boolean(c.hidden),
      };
    }),
    Actual_Payees: raw.payees.map((p) => {
      check(
        !p.transfer_acct || accounts.has(p.transfer_acct),
        "PAYEE_REFERENCE",
      );
      return {
        id: p.id,
        name: label(p.name),
        transfer_account_id: p.transfer_acct ?? "",
      };
    }),
    Actual_Monthly: monthly,
    Actual_Schedules: raw.schedules.map((s) => {
      check(
        !s.posts_transaction,
        "AUTO_POST_CHANGED",
        "Auto-post schedules are now present. Stop scheduled export and review the changed source configuration.",
      );
      return {
        id: s.id,
        name: label(s.name ?? ""),
        next_date: s.next_date ?? "",
        account_id: s.account ?? "",
        payee_id: s.payee ?? "",
        amount_minor: Number.isSafeInteger(s.amount) ? s.amount : "",
        amount_rule: ["is", "isapprox", "isbetween"].includes(s.amountOp)
          ? s.amountOp
          : "unknown",
        auto_post: Boolean(s.posts_transaction),
        completed: Boolean(s.completed),
      };
    }),
    Actual_Balances: accountRows.map((a) => ({
      id: `${asOf}/${a.id}`,
      date: asOf,
      account_id: a.id,
      account: a.name,
      balance_minor: a.balance_minor,
      balance: a.balance,
      offbudget: a.offbudget,
      closed: a.closed,
      captured_at: capturedAt,
      currency: config.currency,
    })),
    Actual_Status: [
      { key: "last_success_at", value: capturedAt },
      { key: "as_of_date", value: asOf },
      { key: "sdk_version", value: SDK_VERSION },
      { key: "server_version", value: raw.serverVersion },
      { key: "budget_mode", value: "tracking" },
      { key: "currency", value: config.currency },
      {
        key: "currency_source",
        value: raw.preferences.defaultCurrencyCode
          ? "Actual preference"
          : "operator configuration",
      },
      { key: "balance_validation", value: "passed" },
      {
        key: "monthly_bridge",
        value:
          "raw source and date activity only; rollover interpretation not verified",
      },
      {
        key: "monthly_coverage",
        value: raw.months.map((m) => m.month).join(","),
      },
      { key: "transaction_rows", value: transactions.length },
      {
        key: "period",
        value:
          "Full recorded ledger; future rows flagged. Monthly source displays cover available months within 12 completed months plus current month.",
      },
    ],
  };
}
export async function readBudget(api, config, asOf) {
  const preferences = await api.getPreferences();
  const accounts = await api.getAccounts();
  const groups = await api.getCategoryGroups();
  const categories = await api.getCategories();
  const payees = await api.getPayees();
  const { data: transactions } = await api.aqlQuery(
    api.q("transactions").select(TX_FIELDS).options({ splits: "all" }),
  );
  check(
    Array.isArray(transactions) && transactions.length <= 50000,
    "SOURCE_LIMIT",
  );
  const balances = {};
  for (const a of accounts)
    balances[a.id] = await api.getAccountBalance(
      a.id,
      new Date(asOf + "T12:00:00"),
    );
  const schedules = await api.getSchedules();
  const months = [];
  const available = new Set(await api.getBudgetMonths());
  let month = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4, 7)}`;
  while (month <= asOf.slice(0, 7)) {
    if (available.has(month)) months.push(await api.getBudgetMonth(month));
    const [y, m] = month.split("-").map(Number);
    month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return {
    preferences,
    accounts,
    groups,
    categories,
    payees,
    transactions,
    balances,
    schedules,
    months,
  };
}
export async function acquire(api, config, credentials, cache) {
  const asOf = todayIn(config.timezone);
  let serverVersion;
  try {
    await api.init({
      dataDir: cache,
      serverURL: config.serverUrl,
      ...(credentials.password
        ? { password: credentials.password }
        : { sessionToken: credentials.sessionToken }),
      verbose: false,
    });
    const version = await api.getServerVersion();
    check(
      version.version === SDK_VERSION,
      "VERSION_MISMATCH",
      "Use the matching Actual server/API version before downloading a budget.",
    );
    serverVersion = version.version;
    const remote = (await api.getBudgets()).filter(
      (b) => b.groupId === config.syncId,
    );
    check(
      remote.length === 1 && remote[0].encryptKeyId,
      "ENCRYPTED_BUDGET_REQUIRED",
      "The explicit Sync ID must identify one encrypted budget.",
    );
    await api.downloadBudget(config.syncId, {
      password: credentials.encryptionPassword,
    });
    const local = (await api.getBudgets()).find(
      (b) => b.groupId === config.syncId && b.id && b.state !== "remote",
    );
    check(local?.id, "BUDGET_NOT_FOUND");
    // Fresh process-local settings are reset by shutdown. Reopen the downloaded
    // copy without serverURL so every financial read uses one offline snapshot.
    await api.shutdown();
    await api.init({ dataDir: cache, verbose: false });
    await api.loadBudget(local.id);
    const raw = await readBudget(api, config, asOf);
    raw.serverVersion = serverVersion;
    return normalize(raw, config, asOf, new Date().toISOString());
  } finally {
    await api.shutdown();
  }
}
