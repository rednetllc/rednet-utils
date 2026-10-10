# Credentials

Use three local files: the Google JSON key, the budget encryption password, and **either** an Actual server password **or** an Actual session token.

## Google service account

1. Open [Google Cloud → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), select your project, and choose **Create service account**. The account ID becomes part of its email address.
2. Open that account → **Keys → Add key → Create new key → JSON**. Save the downloaded file as `secrets/google-service-account.json` without editing it.
3. Enable [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com) in the same project. Share your spreadsheet with the key's `client_email` as **Editor**; keep General access **Restricted**.

[Google's key creation instructions](https://docs.cloud.google.com/iam/docs/keys-create-delete).

The downloaded JSON looks like this (placeholders are not usable credentials):

```json
{
  "type": "service_account",
  "project_id": "your-project",
  "private_key_id": "REPLACE_WITH_DOWNLOADED_VALUE",
  "private_key": "REPLACE_WITH_DOWNLOADED_PRIVATE_KEY",
  "client_email": "actual-sheets@your-project.iam.gserviceaccount.com",
  "client_id": "REPLACE_WITH_DOWNLOADED_VALUE",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "REPLACE_WITH_DOWNLOADED_VALUE",
  "universe_domain": "googleapis.com"
}
```

The real `private_key` contains PEM text with escaped `\n` line breaks. Preserve the downloaded JSON exactly. This is a service-account key, not an OAuth client ID or ordinary API key.

## Actual: choose your sign-in method

### Server password

Use [config.example.json](config.example.json). Put only the Actual server password in `secrets/actual-server-password`:

```text
your-actual-server-password
```

No quotes, variable names or JSON. **Never put your Google account password here.**

### Google / OpenID

Use [config.openid.example.json](config.openid.example.json) as `config.json`. It uses `sessionTokenFile` instead of `serverPasswordFile`; do not set both.

Actual issues a session token when you sign in. There is no Google page that generates this file. Open **your usual Actual web address** and sign in through Google/OpenID, then:

1. Open your browser's Developer Tools → **Network**.
2. Reload Actual while signed in. Select an authenticated request to your Actual server, such as `/account/validate`.
3. Under **Request Headers**, copy only the value of `X-ACTUAL-TOKEN` (header names may appear lowercase).
4. Save that value as plain text in `secrets/actual-session-token`, using a local text editor. Do not include the header name, quotes or a `Bearer` prefix.

```text
your-actual-session-token
```

Use the token sent to **Actual**, not a Google access token or ID token. If the header is absent, confirm the request belongs to your signed-in Actual server; do not copy unrelated headers. The token grants your Actual session's access and may expire or be revoked; repeat these steps when renewal is needed. Keep it out of chat, screenshots and Git.

This procedure follows the [Actual 26.9.0 authentication source](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/auth/app.ts), which sends the session token in `X-ACTUAL-TOKEN`. [Actual's API documentation](https://actualbudget.org/docs/api/) describes token-expiry errors. Your server address is installation-specific; the script still connects to localhost inside the container.

## Budget encryption password

Both sign-in methods also need `secrets/actual-encryption-password`, containing only the separate password that unlocks your encrypted budget:

```text
your-budget-encryption-password
```

## File permissions

Save files under the script's `secrets/` folder, owned by the container user. Run these commands from the installation directory **inside the Linux container**, not in the Windows host shell:

```sh
chmod 700 secrets
chmod 600 config.json secrets/*
```

Credential paths resolve relative to `config.json`. Passwords and tokens are plain text; the Google key is JSON. A final newline is accepted in the Actual credential files. See the [installation guide](README.md) for host-side copy and permission commands. Docker-managed Linux volumes are preferable when host bind mounts cannot retain private POSIX permissions. Protect local host copies with host file permissions, too.
