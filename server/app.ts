import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createGunzip, createInflate } from "node:zlib";
import { AuthError, mergeOpenApi, sendProblem, type Auth, type Principal, type Role } from "@openasy/auth";
import type { HostsFileState } from "./hosts.ts";
import { IngestError, parseBulk, parseJsonLines, parseOtlpJson, parseOtlpProtobuf } from "./ingest.ts";
import { log } from "./log.ts";
import { LogsError, type Actor, type Logs, type ProblemCode } from "./logs.ts";
import { countIngest, countRequest, renderMetrics, type Gauges } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import type { Entry } from "./pipeline.ts";
import type { VlogsClient } from "./vlogs.ts";

export interface SyslogInfo {
  tlsPort: number;
  plainPort: number;
  fingerprint: string;
  certificate: string;
  origin: "file" | "generated";
  stats: Gauges["syslog"];
}

export interface AppOptions {
  db: DatabaseSync;
  logs: Logs;
  vlogs: VlogsClient;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The syslog listeners, when running. */
  syslog?: () => SyslogInfo | undefined;
  /** VictoriaLogs' supervisor state, for /readyz and /metrics. */
  victoriaLogs?: () => { running: boolean; restarts: number };
  /** Retention changed: VictoriaLogs is started again with it. */
  onSettings?: (s: { retentionDays: number; maxDiskGb: number }) => Promise<void>;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Where the hosts file stands (OPENASY_HOSTS, ADR 0052); absent when there is none. */
  hostsFile?: () => HostsFileState;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-json": "Invalid JSON",
  "invalid-token": "Invalid token",
  "version-mismatch": "Version mismatch",
  "invalid-body": "Invalid request body",
  "invalid-query": "Invalid query",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  unavailable: "Storage unavailable",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads a body, decompressing gzip and deflate (shippers send both), up to limit bytes after decompression. */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "gzip" && encoding !== "deflate" && encoding !== "identity")
    throw new LogsError(415, "invalid-body", "Content-Encoding must be gzip, deflate or absent.");
  const source = encoding === "gzip" ? req.pipe(createGunzip()) : encoding === "deflate" ? req.pipe(createInflate()) : req;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new LogsError(413, "invalid-body", `The body is larger than ${Math.round(limit / 1024 / 1024)} MiB. Send smaller batches.`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof LogsError) throw err;
    throw new LogsError(400, "invalid-json", "The compressed body could not be read.");
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = await readRaw(req, limit).catch((err: unknown) => {
    if (err instanceof LogsError && err.status === 413)
      throw new LogsError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    throw err;
  });
  try {
    const body = JSON.parse(raw.toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new LogsError(400, "invalid-json", "The body must be a JSON object.");
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  raw: () => Promise<Buffer>;
  /** The calling agent, on agent routes. */
  agent: ReturnType<Logs["agentBySecret"]>;
  /** The source behind the ingest token, on ingest routes. */
  source: ReturnType<Logs["sourceByToken"]>;
  /** Who asks, on routes for people and API tokens. */
  actor: Actor;
  principal: Principal;
}
interface Route {
  method: string;
  path: string;
  /** The role a route needs (ADR 0003), "agent" for logs-agent with its secret, "source" for an ingest token. */
  auth: "none" | "agent" | "source" | Role;
  /** Largest body; 64 KiB by default. */
  bodyLimit?: number;
  handle: (ctx: Ctx) => unknown;
}

/** A batch from a shipper, or a read from an agent, uncompressed. */
const INGEST_LIMIT = 32 * 1024 * 1024;

function limitOf(url: URL, max = 500, fallback = 100) {
  const v = url.searchParams.get("limit");
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new LogsError(422, "invalid-body", `limit is 1 to ${max}.`);
  return n;
}
function cursorOf(url: URL) {
  const v = url.searchParams.get("cursor");
  if (v === null) return undefined;
  if (!/^\d+$/.test(v)) throw new LogsError(422, "invalid-body", "cursor is the nextCursor of the previous page.");
  return Number(v);
}
const actorOf = (p: Principal): Actor =>
  p.kind === "session" ? { id: p.user.id, name: p.user.name } : { id: `token:${p.tokenId}`, name: `API token ${p.name}` };
const searchParams = (url: URL) => ({
  query: url.searchParams.get("query") ?? undefined,
  start: url.searchParams.get("start") ?? undefined,
  end: url.searchParams.get("end") ?? undefined,
});

/** What /metrics shows, gathered when it is asked for. */
export async function collectGauges(o: Pick<AppOptions, "logs" | "vlogs" | "syslog" | "victoriaLogs">): Promise<Gauges> {
  const s = await o.logs.summary();
  return {
    sources: s.sources,
    hosts: s.hosts,
    storedBytes: s.storedBytes,
    alertsFiring: s.alertsFiring,
    victoriaLogsUp: await o.vlogs.healthy(),
    victoriaLogsRestarts: o.victoriaLogs?.().restarts ?? 0,
    syslog: o.syslog?.()?.stats ?? null,
  };
}

/** Answers Elasticsearch clients the way they expect, so Beats, Fluent Bit and Vector send without changes. */
const ES_HEADERS = { "x-elastic-product": "Elasticsearch" };

export function createApp({
  db,
  logs,
  vlogs,
  version,
  auth,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  syslog,
  victoriaLogs,
  onSettings,
  products = [],
  hostsFile,
}: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const created = (res: ServerResponse, data: unknown) => (json(res, 201, data), undefined);
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const accepted = (res: ServerResponse, data: unknown = { status: "requested" }) => (json(res, 202, data), undefined);

  const gauges = () => collectGauges({ logs, vlogs, syslog, victoriaLogs });

  /** Runs a parsed batch through the source and answers how much was kept. */
  async function take(source: Ctx["source"], via: string, entries: Entry[]) {
    countIngest(via, entries.length);
    return logs.ingest(source, entries);
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "logs", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: async () => ({ ...(await logs.summary()), hostsFile: hostsFile?.() ?? null }) },

    // Search (ADR 0035): LogsQL as it is. Every search is recorded with who asked.
    {
      method: "GET",
      path: "/api/v1/search",
      auth: "viewer",
      handle: ({ url, actor }) => logs.search(actor, { ...searchParams(url), limit: limitOf(url, 5000, 200) }),
    },
    { method: "GET", path: "/api/v1/volume", auth: "viewer", handle: ({ url }) => logs.volume(searchParams(url)) },
    { method: "GET", path: "/api/v1/facets", auth: "viewer", handle: ({ url }) => logs.facets(searchParams(url)) },
    {
      method: "GET",
      path: "/api/v1/tail",
      auth: "viewer",
      handle: async ({ req, res, url, actor }) => {
        const abort = new AbortController();
        req.on("close", () => abort.abort());
        const lines = await logs.tail(actor, url.searchParams.get("query"), abort.signal);
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write(": tail\n\n");
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        try {
          for await (const line of lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
        } catch {
          // The browser went away, or VictoriaLogs did: the stream ends and the page reconnects.
        } finally {
          clearInterval(beat);
          res.end();
        }
        return undefined;
      },
    },
    { method: "GET", path: "/api/v1/searches", auth: "admin", handle: ({ url }) => logs.searches({ limit: limitOf(url), cursor: cursorOf(url) }) },

    // Saved views, and thresholds that call a signed webhook.
    { method: "GET", path: "/api/v1/views", auth: "viewer", handle: ({ actor }) => ({ views: logs.listViews(actor) }) },
    { method: "POST", path: "/api/v1/views", auth: "editor", handle: async ({ res, body, actor }) => created(res, logs.createView(actor, await body())) },
    { method: "GET", path: "/api/v1/views/:id", auth: "viewer", handle: ({ params, actor }) => logs.view(actor, params[0]!) },
    {
      method: "PATCH",
      path: "/api/v1/views/:id",
      auth: "editor",
      handle: async ({ params, body, actor, principal }) => logs.updateView(actor, principal.role === "admin", params[0]!, await body()),
    },
    {
      method: "DELETE",
      path: "/api/v1/views/:id",
      auth: "editor",
      handle: ({ res, params, actor, principal }) => (logs.deleteView(actor, principal.role === "admin", params[0]!), noContent(res)),
    },

    // Sources and their pipelines.
    { method: "GET", path: "/api/v1/sources", auth: "viewer", handle: () => ({ sources: logs.listSources() }) },
    { method: "POST", path: "/api/v1/sources", auth: "admin", handle: async ({ res, body }) => created(res, logs.createSource(await body())) },
    { method: "GET", path: "/api/v1/sources/:id", auth: "viewer", handle: ({ params }) => logs.source(params[0]!) },
    { method: "PATCH", path: "/api/v1/sources/:id", auth: "admin", handle: async ({ params, body }) => logs.updateSource(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/sources/:id", auth: "admin", handle: ({ res, params }) => (logs.deleteSource(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/sources/:id/token", auth: "admin", handle: ({ params }) => logs.rotateToken(params[0]!) },
    { method: "POST", path: "/api/v1/pipelines/preview", auth: "editor", bodyLimit: 1024 * 1024, handle: async ({ body }) => logs.preview(await body()) },
    {
      method: "GET",
      path: "/api/v1/syslog",
      auth: "viewer",
      handle: () => {
        const s = syslog?.();
        if (!s) throw new LogsError(409, "not-configured", "The syslog listeners are not running.");
        return s;
      },
    },

    // What shippers call, with a source's ingest token.
    {
      method: "POST",
      path: "/api/v1/ingest/jsonline",
      auth: "source",
      bodyLimit: INGEST_LIMIT,
      handle: async ({ res, raw, source }) => accepted(res, await take(source, "jsonline", parseJsonLines((await raw()).toString("utf8")))),
    },
    {
      method: "POST",
      path: "/api/v1/ingest/otlp/v1/logs",
      auth: "source",
      bodyLimit: INGEST_LIMIT,
      handle: async ({ req, res, raw, source }) => {
        const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
        const body = await raw();
        let entries: Entry[];
        if (type === "application/x-protobuf") entries = parseOtlpProtobuf(body);
        else if (type === "application/json") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            throw new LogsError(400, "invalid-json", "The body must be OTLP JSON.");
          }
          entries = parseOtlpJson(parsed);
        } else throw new LogsError(415, "invalid-body", "Content-Type is application/x-protobuf or application/json.");
        await take(source, "otlp", entries);
        // An empty ExportLogsServiceResponse: no partial success to report.
        if (type === "application/x-protobuf") send(res, 200, Buffer.alloc(0), "application/x-protobuf");
        else json(res, 200, {});
        return undefined;
      },
    },
    {
      method: "GET",
      path: "/api/v1/ingest/elasticsearch",
      auth: "source",
      handle: ({ res }) => (
        json(
          res,
          200,
          {
            name: "openasy-logs",
            cluster_name: "openasy",
            version: { number: "8.17.0", build_flavor: "default" },
            tagline: "OpenAsy Logs takes the bulk API only.",
          },
          ES_HEADERS,
        ),
        undefined
      ),
    },
    {
      method: "GET",
      path: "/api/v1/ingest/elasticsearch/_license",
      auth: "source",
      handle: ({ res }) => (json(res, 200, { license: { status: "active", type: "basic" } }, ES_HEADERS), undefined),
    },
    ...["/api/v1/ingest/elasticsearch/_bulk", "/api/v1/ingest/elasticsearch/:index/_bulk"].map((path): Route => ({
      method: "POST",
      path,
      auth: "source",
      bodyLimit: INGEST_LIMIT,
      handle: async ({ res, raw, source }) => {
        const started = Date.now();
        const { entries, actions } = parseBulk((await raw()).toString("utf8"));
        await take(source, "elasticsearch", entries);
        json(
          res,
          200,
          {
            took: Date.now() - started,
            errors: false,
            items: actions.map((a) => ({ [a]: { status: a === "create" || a === "index" ? 201 : 200, result: "created" } })),
          },
          ES_HEADERS,
        );
        return undefined;
      },
    })),

    // logs-agent instances (ADR 0018, 0031): added here, enrolled with a one-time token.
    { method: "GET", path: "/api/v1/agents", auth: "viewer", handle: () => ({ agents: logs.listAgents() }) },
    { method: "POST", path: "/api/v1/agents", auth: "admin", handle: async ({ res, body }) => created(res, logs.createAgent(await body())) },
    { method: "GET", path: "/api/v1/agents/:id", auth: "viewer", handle: ({ params }) => logs.agent(params[0]!) },
    { method: "DELETE", path: "/api/v1/agents/:id", auth: "admin", handle: ({ res, params }) => (logs.deleteAgent(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/agents/:id/enroll-token", auth: "admin", handle: ({ params }) => logs.reEnroll(params[0]!) },
    { method: "GET", path: "/api/v1/agents/:id/setup", auth: "viewer", handle: ({ params }) => logs.agentSetup(params[0]!) },

    // What logs-agent calls. It asks; Logs never connects to it.
    { method: "POST", path: "/api/v1/agent/enroll", auth: "none", handle: async ({ body }) => logs.enroll(await body()) },
    { method: "POST", path: "/api/v1/agent/work", auth: "agent", handle: async ({ agent, body }) => logs.work(agent, await body()) },
    {
      method: "POST",
      path: "/api/v1/agent/results",
      auth: "agent",
      bodyLimit: INGEST_LIMIT,
      handle: async ({ res, agent, body }) => {
        const b = await body();
        if (Array.isArray(b.entries)) countIngest("ssh", b.entries.length);
        return accepted(res, await logs.result(agent, b));
      },
    },

    // Hosts read over SSH.
    { method: "GET", path: "/api/v1/hosts", auth: "viewer", handle: () => ({ hosts: logs.listHosts() }) },
    { method: "GET", path: "/api/v1/hosts/:id", auth: "viewer", handle: ({ params }) => logs.host(params[0]!) },
    { method: "DELETE", path: "/api/v1/hosts/:id", auth: "admin", handle: ({ res, params }) => (logs.deleteHost(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/hosts/:id/read", auth: "editor", handle: ({ res, params }) => (logs.requestRead(params[0]!), accepted(res)) },
    { method: "POST", path: "/api/v1/hosts/:id/host-key", auth: "admin", handle: ({ params }) => logs.requestHostKey(params[0]!) },
    {
      method: "POST",
      path: "/api/v1/hosts/:id/host-key/accept",
      auth: "admin",
      handle: async ({ params, body }) => logs.acceptHostKey(params[0]!, (await body()).fingerprint),
    },

    // Retention.
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => logs.settings() },
    {
      method: "PATCH",
      path: "/api/v1/settings",
      auth: "admin",
      handle: async ({ body }) => {
        const before = logs.settings();
        const after = logs.updateSettings(await body());
        if (before.retentionDays !== after.retentionDays || before.maxDiskGb !== after.maxDiskGb) await onSettings?.(after);
        return after;
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Elasticsearch clients add a trailing slash to the base address.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      const problems: string[] = [];
      try {
        db.prepare("SELECT 1").get();
      } catch {
        problems.push("database unavailable");
      }
      if (!(await vlogs.healthy())) problems.push("VictoriaLogs is not answering");
      json(res, problems.length ? 503 : 200, { status: problems.length ? problems.join("; ") : "ready" });
      return "/readyz";
    }
    if (path === "/metrics") {
      if (!serveMetrics) problem(res, 404, "not-found");
      else send(res, 200, renderMetrics(version, await gauges()), "text/plain; version=0.0.4");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (url.pathname === "/api/docs" || url.pathname.startsWith("/api/docs/"))) {
      if (url.pathname === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, url.pathname.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD"))) continue;
      try {
        const agent = r.auth === "agent" ? logs.agentBySecret(req.headers.authorization) : (undefined as never);
        const source = r.auth === "source" ? logs.sourceByToken(req.headers.authorization) : (undefined as never);
        const principal = r.auth !== "none" && r.auth !== "agent" && r.auth !== "source" ? auth.authorize(req, r.auth) : (undefined as never);
        const params = m.slice(1).map(decodeURIComponent);
        const limit = r.bodyLimit ?? 64 * 1024;
        const result = await r.handle({
          req,
          res,
          url,
          params,
          agent,
          source,
          principal,
          actor: principal && actorOf(principal),
          body: () => readJson(req, limit),
          raw: () => readRaw(req, limit),
        });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (res.headersSent) {
          res.end();
        } else if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof LogsError) problem(res, err.status, err.code, err.message);
        else if (err instanceof IngestError) problem(res, 400, "invalid-body", err.message);
        else throw err;
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");
    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }
    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: (req.url ?? "/").split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
      else res.end();
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Ingest and agent calls arrive many times a second; they are counted in /metrics, not logged one by one.
    if (routeName !== "/healthz" && routeName !== "/metrics" && !routeName.startsWith("/api/v1/ingest/") && !routeName.startsWith("/api/v1/agent/")) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** Serves only /metrics, for a port that is not exposed with the rest (LOGS_METRICS_PORT). */
export function createMetricsHandler(gauges: () => Promise<Gauges>, version: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, renderMetrics(version, await gauges()), "text/plain; version=0.0.4");
  };
}
