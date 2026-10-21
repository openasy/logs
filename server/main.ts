import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { collectGauges, createApp, createMetricsHandler } from "./app.ts";
import { openDb } from "./db.ts";
import { createKeyring } from "./kek.ts";
import { log } from "./log.ts";
import { createLogs } from "./logs.ts";
import { parseProducts } from "./products.ts";
import { startReceivers, syslogTls, type Receivers } from "./receivers.ts";
import { createVlogsClient, startVictoriaLogs, waitHealthy } from "./vlogs.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.LOGS_DATA ?? "/data";
const dbPath = process.env.LOGS_DB ?? join(dataDir, "logs.db");
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.LOGS_HEADLESS === "true";
const secretsKeyFile = process.env.LOGS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const binary = process.env.LOGS_VICTORIALOGS_BIN ?? new URL("../vendor/victoria-logs", import.meta.url).pathname;
const vlogsPort = Number(process.env.LOGS_VICTORIALOGS_PORT ?? 9428);
const syslogEnabled = process.env.LOGS_SYSLOG !== "false";

// Sign-in secrets, webhook secrets and the syslog TLS key are sealed with it (ADR 0021): Logs does not start without it.
const kek = readSecretsKey(secretsKeyFile);
if (!kek) {
  log("error", "no key-encryption key: mount 32 random bytes (openssl rand -hex 32) and set LOGS_SECRETS_KEY_FILE if not at the default", { file: secretsKeyFile });
  process.exit(1);
}
if (!existsSync(binary)) {
  log("error", "VictoriaLogs is not where it should be; the image has it, and npm run victorialogs fetches it for development", { binary });
  process.exit(1);
}

const db = openDb(dbPath);
const keyring = createKeyring(kek);
// The address people open Logs at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC use it.
const publicUrl = (process.env.LOGS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");

const vlogs = createVlogsClient(`http://127.0.0.1:${vlogsPort}`);
const logs = createLogs(db, keyring, vlogs, { version, publicUrl });
const retention = logs.settings();
const victoria = startVictoriaLogs({ binary, dataPath: join(dataDir, "vlogs"), port: vlogsPort, retentionDays: retention.retentionDays, maxDiskBytes: retention.maxDiskGb * 1024 ** 3 });
if (!(await waitHealthy(vlogs))) log("warn", "VictoriaLogs is not answering yet; Logs starts anyway and /readyz says so");

const auth = createAuth({
  db,
  product: "logs",
  productName: "OpenAsy Logs",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.LOGS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "LOGS_"),
  secretsKey: kek,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" || event.type === "session-ended" ? "warn" : "info", "auth", { event }),
});

let receivers: Receivers | undefined;
if (syslogEnabled) {
  const tls = syslogTls(db, keyring, { cert: process.env.LOGS_SYSLOG_TLS_CERT_FILE, key: process.env.LOGS_SYSLOG_TLS_KEY_FILE }, new URL(publicUrl).hostname);
  receivers = startReceivers(logs, { tlsPort: Number(process.env.LOGS_SYSLOG_TLS_PORT ?? 6514), plainPort: Number(process.env.LOGS_SYSLOG_PORT ?? 1514), tls });
}
const syslog = () =>
  receivers && {
    // The ports senders use, which compose may map differently from the ones inside the container.
    tlsPort: Number(process.env.LOGS_SYSLOG_PUBLIC_TLS_PORT ?? process.env.LOGS_SYSLOG_TLS_PORT ?? 6514),
    plainPort: Number(process.env.LOGS_SYSLOG_PUBLIC_PORT ?? 514),
    fingerprint: receivers.fingerprint,
    certificate: receivers.certificate,
    origin: (process.env.LOGS_SYSLOG_TLS_CERT_FILE ? "file" : "generated") as "file" | "generated",
    stats: receivers.stats,
  };

const metricsPort = process.env.LOGS_METRICS_PORT ? Number(process.env.LOGS_METRICS_PORT) : undefined;
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    logs,
    vlogs,
    auth,
    version,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    syslog,
    victoriaLogs: () => victoria.state,
    onSettings: async (s) => {
      log("info", "retention changed; starting VictoriaLogs again with it", s);
      await victoria.restart({ retentionDays: s.retentionDays, maxDiskBytes: s.maxDiskGb * 1024 ** 3 });
      await waitHealthy(vlogs);
    },
    products: products.products,
  }),
);
// Long batches from shippers and agents: allow them the time to arrive.
server.requestTimeout = 5 * 60_000;
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(() => collectGauges({ logs, vlogs, syslog, victoriaLogs: () => victoria.state }), version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "logs started", { version, port, data: dataDir, headless, syslog: syslogEnabled }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "LOGS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and ingest tokens travel in clear. Put Logs behind TLS (ADR 0026)", { url: publicUrl });
}
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

let checking = false;
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => {
    if (checking) return;
    checking = true;
    logs
      .checkAlerts()
      .catch((err: unknown) => log("error", "checking thresholds failed", { error: String(err) }))
      .finally(() => (checking = false));
  }, 60_000),
  setInterval(() => logs.purge(), 24 * 3_600_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  setTimeout(() => process.exit(1), 15_000).unref();
  server.close(async () => {
    await receivers?.close();
    // VictoriaLogs flushes what it holds in memory when it stops.
    await victoria.stop();
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
