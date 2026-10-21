// The syslog listeners (ADR 0035): TLS on 6514 for every syslog source, and plain TCP and UDP only when a source
// allows them. Lines are gathered per source and stored once a second or every 1000 lines, whichever comes first.
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { Keyring } from "./kek.ts";
import { log } from "./log.ts";
import type { Logs } from "./logs.ts";
import type { Entry } from "./pipeline.ts";
import { parseSyslog, splitFrames } from "./syslog.ts";

export interface TlsMaterial {
  cert: string;
  key: string;
  /** Where it came from: mounted files, or made by Logs on first start. */
  origin: "file" | "generated";
}

/**
 * The certificate senders check: from mounted files when set, otherwise one Logs makes once and keeps, its key sealed
 * with the key-encryption key (ADR 0021). Senders pin its fingerprint, shown under Sources.
 */
export function syslogTls(db: DatabaseSync, keyring: Keyring, files: { cert?: string; key?: string }, hostname: string): TlsMaterial {
  if (files.cert && files.key) return { cert: readFileSync(files.cert, "utf8"), key: readFileSync(files.key, "utf8"), origin: "file" };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'syslogTls'").get() as { value: string } | undefined;
  if (row) {
    const v = JSON.parse(row.value) as { cert: string; key: string };
    return { cert: v.cert, key: keyring.open(v.key).toString("utf8"), origin: "generated" };
  }
  const dir = mkdtempSync(join(tmpdir(), "openasy-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650",
      "-subj", `/CN=${hostname}/O=OpenAsy Logs`, "-addext", `subjectAltName=DNS:${hostname}`,
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    db.prepare("INSERT INTO settings (key, value) VALUES ('syslogTls', ?)").run(JSON.stringify({ cert, key: keyring.seal(key) }));
    log("info", "made a certificate for syslog over TLS", { fingerprint: new X509Certificate(cert).fingerprint256 });
    return { cert, key, origin: "generated" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ReceiverOptions {
  tlsPort: number;
  plainPort: number;
  tls: TlsMaterial;
  /** Largest message; longer frames close the connection. */
  maxFrame?: number;
}

export interface ReceiverStats {
  received: number;
  unmatched: number;
  connections: number;
  errors: number;
}

export function startReceivers(logs: Logs, o: ReceiverOptions) {
  const stats: ReceiverStats = { received: 0, unmatched: 0, connections: 0, errors: 0 };
  const batches = new Map<string, { source: ReturnType<Logs["syslogSourceFor"]> & object; entries: Entry[] }>();
  const unmatchedWarned = new Set<string>();

  async function flush() {
    const all = [...batches.values()];
    batches.clear();
    for (const b of all) {
      try {
        await logs.ingest(b.source, b.entries);
      } catch (err) {
        stats.errors++;
        log("error", "syslog lines could not be stored", { source: b.source.name, lines: b.entries.length, error: (err as Error).message });
      }
    }
  }
  const timer = setInterval(() => void flush(), 1000);

  function take(addr: string, plain: boolean, messages: string[]) {
    const source = logs.syslogSourceFor(addr, plain);
    if (!source) {
      stats.unmatched += messages.length;
      // Once per address: a device sending to the wrong place should be noticed, not flood the log.
      if (!unmatchedWarned.has(addr) && unmatchedWarned.size < 1000) {
        unmatchedWarned.add(addr);
        log("warn", "syslog from an address no source takes", { address: addr, plain });
      }
      return;
    }
    stats.received += messages.length;
    const b = batches.get(source.id) ?? { source, entries: [] };
    for (const m of messages) b.entries.push(parseSyslog(m));
    batches.set(source.id, b);
    if (b.entries.length >= 1000) void flush();
  }

  const open = new Set<Socket>();
  function stream(socket: Socket | TLSSocket, plain: boolean) {
    const addr = socket.remoteAddress ?? "";
    stats.connections++;
    open.add(socket);
    let rest: Buffer = Buffer.alloc(0);
    socket.setTimeout(10 * 60_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      try {
        const r = splitFrames(rest.length ? Buffer.concat([rest, chunk]) : chunk, o.maxFrame);
        rest = Buffer.from(r.rest);
        if (r.messages.length) take(addr, plain, r.messages);
      } catch (err) {
        stats.errors++;
        log("warn", "syslog connection closed", { address: addr, error: (err as Error).message });
        socket.destroy();
      }
    });
    socket.on("end", () => {
      const last = rest.toString("utf8").trim();
      if (last) take(addr, plain, [last]);
    });
    socket.on("error", () => {});
    socket.on("close", () => (stats.connections--, open.delete(socket)));
  }

  const servers: Array<Server | UdpSocket> = [];
  const tlsServer = createTlsServer({ cert: o.tls.cert, key: o.tls.key, minVersion: "TLSv1.2" }, (s) => stream(s, false));
  tlsServer.on("tlsClientError", () => stats.errors++);
  tlsServer.listen(o.tlsPort, () => log("info", "syslog over TLS", { port: o.tlsPort }));
  servers.push(tlsServer);

  // Plain syslog listens always, but takes messages only from sources that allow it.
  const tcp = createServer((s) => stream(s, true));
  tcp.listen(o.plainPort, () => log("info", "plain syslog over TCP and UDP, for sources that allow it", { port: o.plainPort }));
  servers.push(tcp);
  const udp = (type: "udp6" | "udp4"): UdpSocket => {
    const sock = createSocket(type === "udp6" ? { type, ipv6Only: false } : { type });
    sock.on("message", (msg, rinfo) => take(rinfo.address, true, [msg.toString("utf8")]));
    sock.on("error", (err) => {
      // Hosts without IPv6 cannot bind udp6; IPv4 alone then.
      if (type === "udp6" && (err as NodeJS.ErrnoException).code === "EAFNOSUPPORT") {
        servers.splice(servers.indexOf(sock), 1, udp("udp4"));
        return;
      }
      log("error", "syslog over UDP stopped", { error: String(err) });
    });
    sock.bind(o.plainPort);
    return sock;
  };
  servers.push(udp("udp6"));

  return {
    stats,
    flush,
    async close() {
      clearInterval(timer);
      // Senders keep connections open for days: close them, or the servers never finish closing.
      for (const sock of open) sock.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => ("send" in s ? s.close(() => resolve()) : s.close(() => resolve())))));
      await flush();
    },
    fingerprint: new X509Certificate(o.tls.cert).fingerprint256,
    certificate: o.tls.cert,
  };
}

export type Receivers = ReturnType<typeof startReceivers>;
