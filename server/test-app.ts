// Starts the app on a random port for tests, with a real VictoriaLogs (the pinned binary in vendor/, which npm test
// fetches) in a temporary directory, and a stand-in for logs-agent that speaks the real protocol over HTTP.
// e2e/run.sh uses the real agent against real hosts.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { createKeyring } from "./kek.ts";
import { createLogs } from "./logs.ts";
import { createVlogsClient, startVictoriaLogs, waitHealthy } from "./vlogs.ts";

export const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmXq7hWQvK1eF4s3n0q6X8b9mZ2nqJ8V7cJq3s1kR2x";
export const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9w3m0yQ1L7r2hY8kP4oX6n5aB1cD2eF3gH4iJ5kL6m";
export const CA_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl OpenAsy logs-agent CA";
export const PASSWORD = "correct horse battery staple";
export const BINARY = new URL("../vendor/victoria-logs", import.meta.url).pathname;

export const REPORT = (version: string) => ({
  version,
  caPublicKey: CA_KEY,
  keyPublicKey: HOST_KEY.replace("Fm", "Hm"),
  setup: {
    sshdConfig: "TrustedUserCAKeys /etc/ssh/openasy_logs_ca.pub\n",
    hostSetup: "useradd openasy\nusermod -aG systemd-journal openasy\n",
    authorizedKey: "restrict ssh-ed25519 AAAA",
  },
  running: 0,
});

/** What each fake host answers to a read. */
export interface FakeHost {
  key: string;
  lines: Array<{ time?: string; msg: string; fields?: Record<string, string> }>;
  cursor?: string;
  fail?: { kind: string; message: string };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const dir = mkdtempSync(join(tmpdir(), "openasy-logs-test-"));
  const vlPort = await freePort();
  const victoria = startVictoriaLogs({ binary: BINARY, dataPath: join(dir, "vlogs"), port: vlPort, retentionDays: 30, maxDiskBytes: 0 });
  const vlogs = createVlogsClient(victoria.url);
  if (!(await waitHealthy(vlogs))) throw new Error("VictoriaLogs did not start");

  // Webhooks go to this list instead of the network.
  const webhooks: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const hookStatus = { code: 200 };
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    webhooks.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
    return new Response(null, { status: hookStatus.code });
  }) as typeof fetch;

  const db = openDb(":memory:");
  const logs = createLogs(db, createKeyring(randomBytes(32)), vlogs, { version: opts.version, publicUrl: "https://logs.example.com", fetch: fakeFetch });
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "logs", productName: "OpenAsy Logs", origin: base });
  const settingsChanged: Array<{ retentionDays: number; maxDiskGb: number }> = [];
  handler = createApp({ db, logs, vlogs, auth, victoriaLogs: () => victoria.state, onSettings: async (s) => void settingsChanged.push(s), ...opts });

  // The owner, signed in with a second factor, and an API token for each role.
  const jar = new Map<string, string>();
  const browser = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: base,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  };
  const setup = new URL(auth.setupLink()!).searchParams.get("setup");
  await browser("/api/v1/auth/setup", { body: { token: setup, name: "Olivia", email: "owner@example.com", password: PASSWORD } });
  const { secret } = (await (await browser("/api/v1/auth/me/totp", { body: {} })).json()) as { secret: string };
  await browser("/api/v1/auth/me/totp/confirm", { body: { code: totp(secret) } });
  const token = async (role: string) => ((await (await browser("/api/v1/auth/tokens", { body: { name: role, role } })).json()) as { token: string }).token;
  const tokens = { admin: await token("admin"), editor: await token("editor"), viewer: await token("viewer") };
  const as =
    (role: keyof typeof tokens) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${tokens[role]}`, "content-type": "application/json", ...init.headers } });

  /** A stand-in logs-agent: enrols with the token, then each round asks for jobs and answers them. */
  const fakeAgent = (agentSecret: string) => {
    const hosts = new Map<string, FakeHost>();
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${agentSecret}`, "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(JSON.stringify(body)),
      });
    return {
      hosts,
      async round() {
        const { jobs } = (await (await post("/api/v1/agent/work", REPORT(opts.version))).json()) as {
          jobs: Array<{ id: string; hostId: string; action: string; target: { address: string; hostKeys: string[] }; cursor: { journal: string | null } }>;
        };
        const answers: Response[] = [];
        for (const j of jobs) {
          const h = hosts.get(j.target.address);
          const b = { jobId: j.id, hostId: j.hostId };
          if (!h)
            answers.push(
              await post("/api/v1/agent/results", {
                ...b,
                ok: false,
                error: { kind: "unreachable", message: `ssh: connect to host ${j.target.address} port 22: Connection refused` },
              }),
            );
          else if (j.action === "host-key") answers.push(await post("/api/v1/agent/results", { ...b, ok: true, hostKeys: [h.key] }));
          else if (h.fail) answers.push(await post("/api/v1/agent/results", { ...b, ok: false, error: h.fail }));
          else if (!j.target.hostKeys.includes(h.key))
            answers.push(await post("/api/v1/agent/results", { ...b, ok: false, error: { kind: "host-key-changed", message: "changed" }, hostKeys: [h.key] }));
          else {
            answers.push(
              await post("/api/v1/agent/results", { ...b, ok: true, entries: h.lines, cursor: { journal: h.cursor ?? null, docker: null }, unreadable: [] }),
            );
            h.lines = [];
          }
        }
        return { jobs, answers };
      },
      post,
    };
  };
  const enroll = async (name: string) => {
    const created = (await (await as("admin")("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) })).json()) as {
      agent: { id: string };
      enrollToken: string;
    };
    const r = (await (
      await fetch(`${base}/api/v1/agent/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: created.enrollToken, ...REPORT(opts.version) }),
      })
    ).json()) as { secret: string };
    return { id: created.agent.id, secret: r.secret, ...fakeAgent(r.secret) };
  };

  /** Waits until a LogsQL query finds `n` lines: VictoriaLogs makes new lines searchable within about a second. */
  const until = async (query: string, n: number) => {
    for (let i = 0; i < 60; i++) {
      const lines = await vlogs.query(query, { start: new Date(Date.now() - 3_600_000).toISOString(), end: new Date(Date.now() + 60_000).toISOString() }, 1000);
      if (lines.length >= n) return lines;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${query} did not find ${n} lines`);
  };

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await victoria.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    db,
    logs,
    vlogs,
    victoria,
    base,
    tokens,
    enroll,
    until,
    webhooks,
    hookStatus,
    settingsChanged,
    admin: as("admin"),
    editor: as("editor"),
    viewer: as("viewer"),
    close,
  };
}

function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
