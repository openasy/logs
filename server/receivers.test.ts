import { randomBytes, X509Certificate } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect as tcp } from "node:net";
import { connect as tls } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "./kek.ts";
import { startReceivers, syslogTls, type Receivers } from "./receivers.ts";
import { startApp } from "./test-app.ts";

// The syslog listeners over real TLS, TCP and UDP sockets, storing into a real VictoriaLogs.

let app: Awaited<ReturnType<typeof startApp>>;
let rx: Receivers;
const ports = { tls: 0, plain: 0 };
const keyring = createKeyring(randomBytes(32));
let sourceId: string;

beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
  // Only the documentation network at first: messages from this host belong to no source.
  sourceId = app.logs.createSource({ kind: "syslog", name: "network", networks: ["192.0.2.0/24"] }).source.id;
  ports.tls = 20000 + Math.floor(Math.random() * 20000);
  ports.plain = ports.tls + 1;
  rx = startReceivers(app.logs, { tlsPort: ports.tls, plainPort: ports.plain, tls: syslogTls(app.db, keyring, {}, "logs.example.com") });
  await new Promise((r) => setTimeout(r, 200));
}, 30_000);
afterAll(async () => {
  await rx.close();
  await app.close();
}, 30_000);

const sendTls = (frames: string) =>
  new Promise<void>((resolve, reject) => {
    const s = tls({ port: ports.tls, host: "127.0.0.1", rejectUnauthorized: false }, () => s.end(frames));
    s.on("close", () => resolve());
    s.on("error", reject);
  });
const sendTcp = (frames: string) =>
  new Promise<void>((resolve, reject) => {
    const s = tcp({ port: ports.plain, host: "127.0.0.1" }, () => s.end(frames));
    s.on("close", () => resolve());
    s.on("error", reject);
  });
const sendUdp = (msg: string) =>
  new Promise<void>((resolve) => {
    const s = createSocket("udp4");
    s.send(msg, ports.plain, "127.0.0.1", () => s.close(() => resolve()));
  });
const frame = (m: string) => `${Buffer.byteLength(m)} ${m}`;
/** Now, as RFC 3164 writes it: "Oct 21 09:00:00", in UTC. */
const bsdNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

describe("syslog", () => {
  it("makes a certificate once and keeps it, its key sealed", () => {
    const again = syslogTls(app.db, keyring, {}, "logs.example.com");
    expect(new X509Certificate(again.cert).fingerprint256).toBe(rx.fingerprint);
    expect(new X509Certificate(again.cert).subjectAltName).toBe("DNS:logs.example.com");
    const stored = (app.db.prepare("SELECT value FROM settings WHERE key = 'syslogTls'").get() as { value: string }).value;
    expect(stored).not.toContain("PRIVATE KEY");
  });

  it("drops messages from addresses no source takes", async () => {
    await sendTls(frame("<13>1 - h app - - - from nowhere"));
    await new Promise((r) => setTimeout(r, 300));
    expect(rx.stats.unmatched).toBe(1);
  });

  it("takes TLS from the source's networks", { timeout: 15_000 }, async () => {
    app.logs.updateSource(sourceId, { networks: ["127.0.0.0/8", "::1"] });
    await sendTls(
      frame(`<11>1 ${new Date().toISOString()} router-1 bgpd 12 - - neighbor 192.0.2.1 down`) + frame("<14>1 - router-1 bgpd - - - neighbor 192.0.2.1 up"),
    );
    const lines = await app.until("source:network host:router-1", 2);
    expect(lines.find((l) => l.msg.includes("down"))).toMatchObject({
      level: "error",
      service: "bgpd",
      fields: { "syslog.procid": "12", "syslog.facility": "user" },
    });
  });

  it("takes plain TCP and UDP only when the source allows it", { timeout: 15_000 }, async () => {
    const before = rx.stats.unmatched;
    await sendTcp(`<13>${bsdNow()} switch-1 kernel: link down\n`);
    await new Promise((r) => setTimeout(r, 300));
    expect(rx.stats.unmatched).toBe(before + 1);
    app.logs.updateSource(sourceId, { plain: true });
    await sendTcp(`<13>${bsdNow()} switch-1 kernel: link up\n`);
    await sendUdp(`<12>${bsdNow()} switch-1 kernel: fan speed high`);
    const lines = await app.until("source:network host:switch-1", 2);
    expect(lines.map((l) => l.msg).sort()).toEqual(["fan speed high", "link up"]);
    expect(lines.find((l) => l.msg === "fan speed high")!.level).toBe("warn");
  });
});
