import { readFile, writeFile, mkdtemp, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { check } from "./protocol.mjs";
const exec = promisify(execFile);
// Only exact stable releases are eligible for automatic installation.
export function release(value) {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.length < 40
  );
}
export function newer(server, sdk) {
  if (!release(server) || !release(sdk)) return false;
  const a = server.split(".").map(Number),
    b = sdk.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export async function installed(base) {
  const require = createRequire(join(base, "package.json"));
  const entry = require.resolve("@actual-app/api");
  const pkg = JSON.parse(
    await readFile(resolve(dirname(entry), "../package.json"), "utf8"),
  );
  check(typeof pkg.version === "string", "SDK_VERSION");
  return { version: pkg.version, entry };
}
export async function currentSdk(root, state) {
  try {
    const version = (await readFile(join(state, "sdk-version"), "utf8")).trim();
    check(release(version), "SDK_VERSION");
    const sdk = await installed(join(state, `sdk-${version}`));
    check(sdk.version === version, "SDK_VERSION");
    return sdk;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return installed(root);
  }
}
export async function updateSdk(state, version, signal, install = exec) {
  check(release(version), "SDK_VERSION");
  const stage = await mkdtemp(join(state, "sdk-install-"));
  try {
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@actual-app/api": version },
        // The SQLite version follows the selected SDK. Approve only this native dependency.
        allowScripts: { "better-sqlite3": true },
      }),
    );
    await install(
      "npm",
      [
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ],
      {
        cwd: stage,
        signal,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, npm_config_engine_strict: "true" },
      },
    );
    const sdk = await installed(stage);
    check(sdk.version === version, "SDK_VERSION");
    // Importing the SDK alone does not load its native SQLite binding.
    // Open a disposable in-memory database before activating the new SDK.
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createRequire } from "node:module";
        await import(process.argv[1]);
        const Database = createRequire(process.argv[1])("better-sqlite3");
        const db = new Database(":memory:");
        db.close();`,
        pathToFileURL(sdk.entry).href,
      ],
      { signal, timeout: 15000 },
    );
    const destination = join(state, `sdk-${version}`);
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
    await writeFile(join(state, "sdk-version.tmp"), version);
    await rename(join(state, "sdk-version.tmp"), join(state, "sdk-version"));
    return installed(destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
