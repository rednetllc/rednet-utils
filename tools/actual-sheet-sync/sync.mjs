#!/usr/bin/env node
import { readFile, mkdir, mkdtemp, chmod, rm, lstat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import {
  check,
  SyncError,
  secretScan,
  setupRequests,
  parseRows,
} from "./protocol.mjs";
import { Sheets, readPrivate } from "./sheets.mjs";
import { SDK_VERSION } from "./source.mjs";
const root = dirname(fileURLToPath(import.meta.url));
export async function configFrom(path) {
  const base = dirname(resolve(path));
  const c = JSON.parse(await readFile(path, "utf8"));
  const allowed = [
    "serverUrl",
    "syncId",
    "spreadsheetId",
    "timezone",
    "currency",
    "serverPasswordFile",
    "sessionTokenFile",
    "encryptionPasswordFile",
    "googleKeyFile",
  ];
  check(
    c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      Object.keys(c).every((k) => allowed.includes(k)),
    "CONFIG",
  );
  check(
    typeof c.spreadsheetId === "string" &&
      /^[A-Za-z0-9_-]{20,100}$/.test(c.spreadsheetId),
    "CONFIG",
  );
  c.serverUrl ??= "http://127.0.0.1:5006";
  c.timezone ??= "UTC";
  c.currency ??= "USD";
  const url = new URL(c.serverUrl);
  check(
    ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "LOCALHOST_REQUIRED",
  );
  new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
  check(/^[A-Z]{3}$/.test(c.currency), "CONFIG");
  for (const k of allowed.filter((k) => k.endsWith("File")))
    if (c[k]) {
      check(typeof c[k] === "string", "CONFIG");
      c[k] = resolve(base, c[k]);
    }
  check(
    c.googleKeyFile,
    "GOOGLE_KEY",
    "Set googleKeyFile to a private local service-account JSON file.",
  );
  return c;
}
async function localSecrets(c) {
  check(
    typeof c.syncId === "string" &&
      c.syncId.length > 0 &&
      Boolean(c.serverPasswordFile) !== Boolean(c.sessionTokenFile) &&
      c.encryptionPasswordFile,
    "CONFIG",
    "Set the explicit Sync ID and local Actual login and encryption credential file paths.",
  );
  const get = async (path) =>
    path ? (await readPrivate(path)).replace(/\r?\n$/, "") : undefined;
  const credentials = {
    password: await get(c.serverPasswordFile),
    sessionToken: await get(c.sessionTokenFile),
    encryptionPassword: await get(c.encryptionPasswordFile),
  };
  check(
    (credentials.password || credentials.sessionToken) &&
      credentials.encryptionPassword,
    "EMPTY_SECRET",
  );
  return credentials;
}
async function runWorker(c, credentials, cache, signal) {
  return new Promise((resolveResult, reject) => {
    const child = fork(join(root, "worker.mjs"), [], {
      cwd: root,
      env: { PATH: process.env.PATH, TZ: c.timezone },
      execArgv: ["--max-old-space-size=512"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let done = false,
      result,
      error;
    const stop = (e) => {
      if (done) return;
      error = e;
      child.kill("SIGKILL");
    };
    const abort = () =>
      stop(
        new SyncError(
          "INTERRUPTED",
          "The run was interrupted; no source output is reused.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    child.on("message", (message) => {
      if (message.ok) {
        result = message.tables;
        child.disconnect();
      } else
        stop(
          new SyncError(
            message.code || "SOURCE_FAILED",
            message.message || "Actual acquisition failed.",
          ),
        );
    });
    child.on("error", () => {
      error = new SyncError(
        "WORKER_FAILED",
        "The Actual worker failed to start.",
      );
    });
    child.on("exit", () => {
      done = true;
      signal.removeEventListener("abort", abort);
      if (error || !result)
        reject(
          error ??
            new SyncError(
              "SOURCE_FAILED",
              "The Actual worker stopped without a result.",
            ),
        );
      else resolveResult(result);
    });
    if (signal.aborted) abort();
    else child.send({ config: c, credentials, cache });
  });
}
async function main() {
  process.umask(0o077);
  const [command = "help", configPath = join(root, "config.json"), ...extra] =
    process.argv.slice(2);
  check(
    !extra.length && ["help", "setup", "check", "sync"].includes(command),
    "USAGE",
    "Usage: node sync.mjs setup|check|sync [config.json]",
  );
  if (command === "help") {
    console.log(
      "node sync.mjs setup|check|sync [config.json]\nsetup: Google-only tab setup\ncheck: acquire Actual data, validate, and check Google access without writing rows\nsync: acquire and reconcile all managed sheet tabs",
    );
    return;
  }
  check(
    Number(process.versions.node.split(".")[0]) === 24,
    "NODE_VERSION",
    "Run this script using Node 24 inside the Actual container.",
  );
  const c = await configFrom(configPath);
  const state = join(root, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  check(!(await lstat(state)).isSymbolicLink(), "STATE_PATH");
  await chmod(state, 0o700);
  const lock = join(
    state,
    createHash("sha256").update(c.spreadsheetId).digest("hex") + ".lock",
  );
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST")
      throw new SyncError(
        "BUSY",
        "Another run owns the lock. After a crash, verify it stopped before removing its lock.",
      );
    throw e;
  }
  const controller = new AbortController();
  let cache;
  const abort = () => controller.abort();
  const deadline = setTimeout(() => {
    controller.abort();
  }, 300000);
  const force = setTimeout(() => {
    console.error(
      JSON.stringify({
        error: "TIMEOUT",
        message:
          "Run exceeded its deadline. Check the sheet status and remove a stale lock only after the process stops.",
      }),
    );
    process.exit(4);
  }, 310000);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const sheets = await Sheets.connect(c);
    if (command === "setup") {
      console.log(
        JSON.stringify({ status: "setup_verified", ...(await sheets.setup()) }),
      );
      return;
    }
    const require = createRequire(import.meta.url);
    const sdkRoot = resolve(dirname(require.resolve("@actual-app/api")), "..");
    check(
      JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"))
        .version === SDK_VERSION,
      "SDK_VERSION",
    );
    const credentials = await localSecrets(c);
    // Check Google access/header ownership before connecting to Actual.
    const meta = await sheets.metadata();
    check(setupRequests(meta).length === 0, "SHEET_NOT_READY");
    const existing = await sheets.read(meta);
    for (const [name, rows] of Object.entries(existing)) parseRows(name, rows);
    cache = await mkdtemp(join(state, "cache-"));
    await chmod(cache, 0o700);
    const tables = await runWorker(c, credentials, cache, controller.signal);
    check(!controller.signal.aborted, "INTERRUPTED");
    const secrets = [c.syncId, ...Object.values(credentials).filter(Boolean)];
    secretScan(tables, secrets);
    if (command === "check") {
      console.log(
        JSON.stringify({
          status: "checks_passed_no_sheet_write",
          transactions: tables.Actual_Transactions.length,
          accounts: tables.Actual_Accounts.length,
        }),
      );
      return;
    }
    const binding = createHash("sha256").update(c.syncId).digest("hex");
    console.log(
      JSON.stringify({
        status: "sheet_sync_verified",
        ...(await sheets.publish(tables, binding, secrets)),
      }),
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    if (cache) await rm(cache, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    const known = e instanceof SyncError;
    console.error(
      JSON.stringify({
        error: known ? e.code : "RUN_FAILED",
        message: known
          ? e.message
          : "Run failed. Verify local files and documented inputs; private error details are suppressed.",
      }),
    );
    process.exitCode = e?.code === "BUSY" ? 7 : 1;
  });
