import { pathToFileURL } from "node:url";
import { acquire } from "./source.mjs";
import { SyncError } from "./protocol.mjs";
process.once(
  "message",
  async ({ config, credentials, cache, sdkEntry, probe }) => {
    try {
      const api = await import(
        sdkEntry ? pathToFileURL(sdkEntry).href : "@actual-app/api"
      );
      if (probe) {
        let version;
        try {
          await api.init({
            dataDir: cache,
            serverURL: config.serverUrl,
            ...(credentials.password
              ? { password: credentials.password }
              : { sessionToken: credentials.sessionToken }),
            verbose: false,
          });
          version = await api.getServerVersion();
          if (version?.error || typeof version?.version !== "string")
            throw new SyncError(
              "SERVER_VERSION",
              "Actual did not return a server version.",
            );
        } finally {
          await api.shutdown();
        }
        process.send({ ok: true, tables: version }, () => process.exit(0));
        return;
      }
      const tables = await acquire(api, config, credentials, cache);
      process.send({ ok: true, tables }, () => process.exit(0));
    } catch (e) {
      const codes = {
        "invalid-password": "SERVER_LOGIN_FAILED",
        "token-expired": "SERVER_TOKEN_FAILED",
        "decrypt-failure": "ENCRYPTION_PASSWORD_FAILED",
        "missing-key": "ENCRYPTION_PASSWORD_REQUIRED",
        "network-failure": "ACTUAL_CONNECTION_FAILED",
        network: "ACTUAL_CONNECTION_FAILED",
      };
      process.send(
        {
          ok: false,
          code:
            e instanceof SyncError
              ? e.code
              : (codes[e?.code] ?? "ACTUAL_FAILED"),
          message:
            e instanceof SyncError
              ? e.message
              : "Actual could not be read. Check the matching local credentials, server version and connection.",
        },
        () => process.exit(1),
      );
    }
  },
);
