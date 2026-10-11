import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "./store.js";
import { createApp, type AppConfig } from "./app.js";
import { secret } from "./security.js";
import { deliverOutbox } from "./integrations.js";

process.umask(0o077);
const origin = new URL(process.env.QR_ORIGIN || "");
if (
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  (origin.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      process.env.QR_ALLOW_LOCAL === "1" &&
      origin.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(origin.hostname)
    ))
)
  throw new Error(
    "QR_ORIGIN must be an HTTPS origin without a path. Local HTTP requires QR_ALLOW_LOCAL=1 outside production.",
  );
const path = resolve(process.env.QR_DB_PATH || "data/qr.sqlite");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new Store(path);
const config: AppConfig = {
  origin: origin.origin,
  signingKey: secret(process.env.QR_SIGNING_KEY),
  root: process.cwd(),
  analyticsSnapshotUrl: process.env.ANALYTICS_SNAPSHOT_URL,
  analyticsDeliveryUrl: process.env.ANALYTICS_CHECKIN_URL,
  analyticsToken: process.env.ANALYTICS_API_TOKEN,
  passVerifyUrl: process.env.PASS_VERIFY_URL,
  passToken: process.env.PASS_API_TOKEN,
};
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = createApp(db, config);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(
    `Unity QR server listening on port ${port}; configure HTTPS at the reverse proxy.`,
  ),
);
// Local outbox is durable; remote delivery is enabled only by real server-side configuration.
const sync = setInterval(() => {
  void deliverOutbox(db, config).catch(() =>
    console.error(
      "Analytics delivery configuration unavailable; local records are retained.",
    ),
  );
}, 60000);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(sync);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 20000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
