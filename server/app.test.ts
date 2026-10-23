import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { fingerprint } from "./logs.ts";
import { CA_KEY, HOST_KEY, OTHER_KEY, REPORT, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response matches openapi.json and every operation is called. The scenario is
// also the behaviour test, against a real VictoriaLogs: sources and pipelines, every way of sending, search, views
// and thresholds, agents and hosts.

type Spec = typeof OPENAPI & {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
};
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");
const covered = new Set<string>();
const PRODUCTS = [{ id: "infrastructure", url: "https://infra.example.com" }];

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version, openapi: spec, products: PRODUCTS });
}, 30_000);
afterAll(() => app.close(), 30_000);

type Role = "admin" | "editor" | "viewer" | "none";
type Auth = Role | { secret: string } | { header: string };
async function call(
  role: Auth,
  method: string,
  path: string,
  opts: { concrete?: string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string> } = {},
) {
  const url = app.base + (opts.concrete ?? path);
  const init: RequestInit = { method, ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }), ...(opts.raw !== undefined && { body: opts.raw }) };
  const headers = { "content-type": "application/json", ...opts.headers };
  const res =
    typeof role === "object"
      ? await fetch(url, { ...init, headers: { authorization: "secret" in role ? `Bearer ${role.secret}` : role.header, ...headers } })
      : role === "none"
        ? await fetch(url, { ...init, headers })
        : await app[role](opts.concrete ?? path, { ...init, headers });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(
    declared,
    `${method} ${opts.concrete ?? path} answered ${res.status}, which openapi.json does not list: ${res.status >= 400 ? await res.clone().text() : ""}`,
  ).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? (spec.components.responses as Record<string, { content: Record<string, unknown> }>)[shared]! : declared!;
  if (!response.content) return { status: res.status, body: undefined as never, headers: res.headers };
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(Object.keys(response.content), `${method} ${path} answered ${type}`).toContain(type);
  // Each test reads the fields it checks; the schema above has already checked their shape.
  const data: any = type.endsWith("json") ? await res.json() : type === "application/x-protobuf" ? Buffer.from(await res.arrayBuffer()) : await res.text();
  if (type.endsWith("json")) {
    const at = shared
      ? `openapi#/components/responses/${shared}`
      : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;
    const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
    expect(validate(data), `${method} ${opts.concrete ?? path}: ${JSON.stringify(validate.errors)}`).toBe(true);
  }
  return { status: res.status, body: data, headers: res.headers };
}

const hour = () => ({ start: new Date(Date.now() - 3_600_000).toISOString(), end: new Date(Date.now() + 60_000).toISOString() });
const qs = (p: Record<string, string>) => `?${new URLSearchParams(p)}`;
let http: { id: string; token: string };

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(JSON.parse(JSON.stringify(OPENAPI))).toEqual(spec);
    expect(spec.info.version).toBe(version);
  });

  it("is served with sign-in merged in", async () => {
    const served = (await (await fetch(`${app.base}/api/openapi.json`)).json()) as Spec;
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });
});

describe("the product", () => {
  it("answers health, readiness and version", async () => {
    expect((await call("none", "GET", "/healthz")).status).toBe(200);
    expect((await call("none", "GET", "/readyz")).body).toEqual({ status: "ready" });
    expect((await call("none", "GET", "/api/v1/version")).body).toEqual({ product: "logs", version });
  });

  it("lists the install's other products to anyone signed in", async () => {
    expect((await call("viewer", "GET", "/api/v1/products")).body).toEqual({ products: PRODUCTS });
    expect((await call("none", "GET", "/api/v1/products")).status).toBe(401);
  });

  it("keeps retention and starts VictoriaLogs again when it changes", async () => {
    expect((await call("viewer", "GET", "/api/v1/settings")).body).toEqual({ retentionDays: 30, maxDiskGb: 0 });
    expect((await call("editor", "PATCH", "/api/v1/settings", { body: { retentionDays: 90 } })).status).toBe(403);
    expect((await call("admin", "PATCH", "/api/v1/settings", { body: { retentionDays: 0 } })).status).toBe(422);
    expect((await call("admin", "PATCH", "/api/v1/settings", { body: { retentionDays: 90, maxDiskGb: 50 } })).body).toEqual({
      retentionDays: 90,
      maxDiskGb: 50,
    });
    expect(app.settingsChanged).toEqual([{ retentionDays: 90, maxDiskGb: 50 }]);
    // The same values again change nothing.
    await call("admin", "PATCH", "/api/v1/settings", { body: { retentionDays: 90 } });
    expect(app.settingsChanged).toHaveLength(1);
  });
});

describe("sources", () => {
  it("are added by admins; http sources get a token once", async () => {
    expect((await call("editor", "POST", "/api/v1/sources", { body: { name: "apps", kind: "http" } })).status).toBe(403);
    const r = await call("admin", "POST", "/api/v1/sources", { body: { name: "apps", kind: "http" } });
    expect(r.status).toBe(201);
    http = { id: r.body.source.id, token: r.body.token };
    expect(http.token).toMatch(/^olg_/);
    expect(r.body.source.processors).toEqual([{ type: "parse-json" }, { type: "map-level" }, { type: "mask-secrets" }]);
    expect((await call("admin", "POST", "/api/v1/sources", { body: { name: "apps", kind: "http" } })).status).toBe(409);
    expect((await call("admin", "POST", "/api/v1/sources", { body: { name: "x", kind: "kafka" } })).status).toBe(422);
  });

  it("syslog sources need the networks they take", async () => {
    expect((await call("admin", "POST", "/api/v1/sources", { body: { name: "net", kind: "syslog" } })).status).toBe(422);
    expect((await call("admin", "POST", "/api/v1/sources", { body: { name: "net", kind: "syslog", networks: ["10.0.0.0/33"] } })).status).toBe(422);
    const r = await call("admin", "POST", "/api/v1/sources", { body: { name: "net", kind: "syslog", networks: ["10.0.0.0/8", "2001:db8::/32"], plain: true } });
    expect(r.status).toBe(201);
    expect(r.body.token).toBeUndefined();
    expect((await call("admin", "POST", "/api/v1/sources/{id}/token", { concrete: `/api/v1/sources/${r.body.source.id}/token` })).status).toBe(409);
    expect((await call("admin", "PATCH", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${r.body.source.id}`, body: { networks: [] } })).status).toBe(
      422,
    );
    expect((await call("admin", "DELETE", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${r.body.source.id}` })).status).toBe(204);
    expect((await call("viewer", "GET", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${r.body.source.id}` })).status).toBe(404);
  });

  it("change their pipeline, and processors can be tried first", async () => {
    const processors = [
      { type: "parse-json" },
      { type: "map-level" },
      { type: "mask-secrets" },
      { type: "drop", field: "path", pattern: "^/healthz$" },
      { type: "set", field: "env", value: "prod" },
    ];
    const tried = await call("editor", "POST", "/api/v1/pipelines/preview", {
      body: { processors, lines: ['{"msg":"hi","level":"ERR"}', '{"path":"/healthz"}'] },
    });
    expect(tried.body.results).toEqual([
      { kept: true, msg: "hi", fields: { level: "error", env: "prod" } },
      { kept: false, msg: null, fields: {} },
    ]);
    expect(
      (await call("editor", "POST", "/api/v1/pipelines/preview", { body: { processors: [{ type: "parse-regex", pattern: "(" }], lines: [] } })).status,
    ).toBe(422);
    const r = await call("admin", "PATCH", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${http.id}`, body: { processors } });
    expect(r.body.processors).toEqual(processors);
    expect((await call("viewer", "GET", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${http.id}` })).body.processors).toEqual(processors);
  });

  it("say where syslog goes only when the listeners run", async () => {
    expect((await call("viewer", "GET", "/api/v1/syslog")).status).toBe(409);
  });
});

describe("ingest", () => {
  it("takes JSON lines with the source's token, through its pipeline", async () => {
    const body = [
      JSON.stringify({ msg: "payment failed for order 42", level: "ERR", service: "checkout", host: "web-1", password: "hunter22" }),
      JSON.stringify({ msg: "GET /healthz", path: "/healthz", service: "checkout" }),
      JSON.stringify({ message: "connected to db with password=s3cret", level: "info", service: "checkout" }),
    ].join("\n");
    expect((await call({ secret: "olg_wrong" }, "POST", "/api/v1/ingest/jsonline", { raw: body })).status).toBe(401);
    const r = await call({ secret: http.token }, "POST", "/api/v1/ingest/jsonline", {
      raw: gzipSync(body),
      headers: { "content-type": "application/x-ndjson", "content-encoding": "gzip" },
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: 2, dropped: 1 });
    const lines = await app.until("source:apps", 2);
    const failed = lines.find((l) => l.msg.startsWith("payment"))!;
    expect(failed).toMatchObject({ level: "error", service: "checkout", host: "web-1", source: "apps", fields: { env: "prod", password: "hunter22" } });
    // mask-secrets masks key=value text, not a field merely named password; mask that with a drop or mask step.
    expect(lines.find((l) => l.msg.startsWith("connected"))!.msg).toBe("connected to db with password=***");
  });

  it("takes Elasticsearch bulk with the token as password, and answers its version checks", async () => {
    const basic = { header: `Basic ${Buffer.from(`elastic:${http.token}`).toString("base64")}` };
    const info = await call(basic, "GET", "/api/v1/ingest/elasticsearch");
    expect(info.headers.get("x-elastic-product")).toBe("Elasticsearch");
    expect((await call({ header: `ApiKey ${http.token}` }, "GET", "/api/v1/ingest/elasticsearch/_license")).status).toBe(200);
    const doc = (msg: string) => [
      JSON.stringify({ create: { _index: "winlogbeat" } }),
      JSON.stringify({ "@timestamp": new Date().toISOString(), message: msg, event: { code: 4625 }, winlog: { channel: "Security" } }),
    ];
    const r = await call(basic, "POST", "/api/v1/ingest/elasticsearch/_bulk", {
      raw: [...doc("An account failed to log on"), ""].join("\n"),
      headers: { "content-type": "application/x-ndjson" },
    });
    expect(r.body).toMatchObject({ errors: false, items: [{ create: { status: 201 } }] });
    expect(
      (
        await call(basic, "POST", "/api/v1/ingest/elasticsearch/{index}/_bulk", {
          concrete: "/api/v1/ingest/elasticsearch/logs-2026/_bulk",
          raw: doc("again").join("\n") + "\n",
        })
      ).status,
    ).toBe(200);
    expect((await call(basic, "POST", "/api/v1/ingest/elasticsearch/_bulk", { raw: '{"index":{}}\n{broken\n' })).status).toBe(400);
    const lines = await app.until('source:apps "event.code":4625', 2);
    expect(lines[0]!.fields["winlog.channel"]).toBe("Security");
  });

  it("takes OpenTelemetry logs as JSON and protobuf", async () => {
    const otlp = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "cart" } }] },
          scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), severityNumber: 13, body: { stringValue: "cart is slow" } }] }],
        },
      ],
    };
    const r = await call({ secret: http.token }, "POST", "/api/v1/ingest/otlp/v1/logs", { body: otlp });
    expect(r.body).toEqual({});
    const pb = await call({ secret: http.token }, "POST", "/api/v1/ingest/otlp/v1/logs", {
      raw: Buffer.alloc(0),
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(pb.status).toBe(200);
    expect((await call({ secret: http.token }, "POST", "/api/v1/ingest/otlp/v1/logs", { raw: "x", headers: { "content-type": "text/plain" } })).status).toBe(
      415,
    );
    expect((await app.until("service:cart", 1))[0]).toMatchObject({ level: "warn", msg: "cart is slow" });
  });

  it("refuses a switched-off source, and starts again with a new token", async () => {
    await call("admin", "PATCH", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${http.id}`, body: { enabled: false } });
    expect((await call({ secret: http.token }, "POST", "/api/v1/ingest/jsonline", { raw: '{"msg":"x"}' })).status).toBe(409);
    await call("admin", "PATCH", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${http.id}`, body: { enabled: true } });
    const rotated = await call("admin", "POST", "/api/v1/sources/{id}/token", { concrete: `/api/v1/sources/${http.id}/token` });
    expect((await call({ secret: http.token }, "POST", "/api/v1/ingest/jsonline", { raw: '{"msg":"x"}' })).status).toBe(401);
    http.token = rotated.body.token;
    const src = (await call("viewer", "GET", "/api/v1/sources")).body.sources.find((s: { id: string }) => s.id === http.id);
    // 2 JSON lines (one dropped), 2 bulk documents, 1 OpenTelemetry record; the switched-off source took none.
    expect(src).toMatchObject({ linesIn: 5, linesDropped: 1 });
  });
});

describe("search", () => {
  it("finds lines with LogsQL, newest first, and records who asked", async () => {
    const r = await call("viewer", "GET", "/api/v1/search", { concrete: `/api/v1/search${qs({ query: "service:checkout", ...hour() })}` });
    expect(r.body.lines.map((l: { msg: string }) => l.msg).sort()).toEqual(["connected to db with password=***", "payment failed for order 42"]);
    expect(r.body.truncated).toBe(false);
    expect(
      (await call("viewer", "GET", "/api/v1/search", { concrete: `/api/v1/search${qs({ query: "service:checkout", limit: "1", ...hour() })}` })).body,
    ).toMatchObject({ truncated: true });
    expect((await call("viewer", "GET", "/api/v1/search", { concrete: `/api/v1/search${qs({ query: "bad((" })}` })).status).toBe(422);
    expect((await call("viewer", "GET", "/api/v1/search", { concrete: `/api/v1/search${qs({ limit: "0" })}` })).status).toBe(422);
    expect(
      (await call("viewer", "GET", "/api/v1/search", { concrete: `/api/v1/search${qs({ start: "2026-10-21T10:00:00Z", end: "2026-10-21T09:00:00Z" })}` }))
        .status,
    ).toBe(422);
    expect((await call("viewer", "GET", "/api/v1/searches")).status).toBe(403);
    const audit = await call("admin", "GET", "/api/v1/searches", { concrete: "/api/v1/searches?limit=2" });
    expect(audit.body.searches[0]).toMatchObject({ kind: "search", actor: expect.stringContaining("API token viewer") });
    expect(audit.body.nextCursor).toBeDefined();
    expect(
      (await call("admin", "GET", "/api/v1/searches", { concrete: `/api/v1/searches?cursor=${audit.body.nextCursor}` })).body.searches.length,
    ).toBeGreaterThan(0);
  });

  it("counts lines over time by level, and the frequent values of each field", async () => {
    const v = await call("viewer", "GET", "/api/v1/volume", { concrete: `/api/v1/volume${qs({ query: "source:apps", ...hour() })}` });
    expect(v.body.step).toBe("1m");
    expect(v.body.series.find((s: { level: string }) => s.level === "error").total).toBe(1);
    const f = await call("viewer", "GET", "/api/v1/facets", { concrete: `/api/v1/facets${qs({ query: "source:apps", ...hour() })}` });
    expect(f.body.fields[0].field).toBe("level");
    expect(f.body.fields.find((x: { field: string }) => x.field === "service").values).toEqual(expect.arrayContaining([{ value: "checkout", hits: 2 }]));
  });

  it("tails new lines as server-sent events", { timeout: 20_000 }, async () => {
    expect((await call("viewer", "GET", "/api/v1/tail", { concrete: `/api/v1/tail${qs({ query: "bad((" })}` })).status).toBe(422);
    const abort = new AbortController();
    const res = await app.viewer(`/api/v1/tail${qs({ query: "service:tailed" })}`, { signal: abort.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    await call({ secret: http.token }, "POST", "/api/v1/ingest/jsonline", { raw: '{"msg":"live line","service":"tailed"}' });
    let text = "";
    const deadline = Date.now() + 10_000;
    while (!text.includes("live line") && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    const data = text.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(data.slice(6))).toMatchObject({ msg: "live line", service: "tailed", source: "apps" });
  });
});

describe("views", () => {
  let viewId: string;
  let secret: string;

  it("are saved by editors, with a threshold that calls a signed webhook", async () => {
    expect((await call("viewer", "POST", "/api/v1/views", { body: { name: "Errors", query: "level:error" } })).status).toBe(403);
    expect(
      (
        await call("editor", "POST", "/api/v1/views", {
          body: { name: "x", query: "*", alert: { threshold: 1, windowMinutes: 5, webhookUrl: "http://127.0.0.1:9428/insert" } },
        })
      ).status,
    ).toBe(422);
    const r = await call("editor", "POST", "/api/v1/views", {
      body: {
        name: "Checkout errors",
        query: "service:checkout level:error",
        alert: { threshold: 0, windowMinutes: 60, webhookUrl: "https://hooks.example.com/logs" },
      },
    });
    expect(r.status).toBe(201);
    viewId = r.body.view.id;
    secret = r.body.webhookSecret;
    expect(r.body.view).toMatchObject({ shared: true, owner: { name: "API token editor" }, alert: { state: "ok", lastCount: null } });

    await app.logs.checkAlerts();
    expect(app.webhooks).toHaveLength(1);
    const hook = app.webhooks[0]!;
    const signed = `${hook.headers["webhook-id"]}.${hook.headers["webhook-timestamp"]}.${hook.body}`;
    expect(hook.headers["webhook-signature"]).toBe(
      `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(signed)
        .digest("base64")}`,
    );
    expect(JSON.parse(hook.body)).toMatchObject({ type: "logs.view.fired", count: 1, threshold: 0, url: `https://logs.example.com/explorer?view=${viewId}` });
    // Still over: no second call.
    await app.logs.checkAlerts();
    expect(app.webhooks).toHaveLength(1);
    expect((await call("viewer", "GET", "/api/v1/views/{id}", { concrete: `/api/v1/views/${viewId}` })).body.alert).toMatchObject({
      state: "firing",
      lastCount: 1,
    });
    expect((await call("viewer", "GET", "/api/v1/summary")).body.alertsFiring).toBe(1);
  });

  it("keep the state when the webhook fails, and try again", async () => {
    await call("editor", "PATCH", "/api/v1/views/{id}", {
      concrete: `/api/v1/views/${viewId}`,
      body: { alert: { threshold: 100, windowMinutes: 60, webhookUrl: "https://hooks.example.com/logs" } },
    });
    app.hookStatus.code = 500;
    await app.logs.checkAlerts();
    expect((await call("viewer", "GET", "/api/v1/views/{id}", { concrete: `/api/v1/views/${viewId}` })).body.alert).toMatchObject({
      state: "firing",
      lastError: expect.stringContaining("500"),
    });
    app.hookStatus.code = 204;
    await app.logs.checkAlerts();
    expect(JSON.parse(app.webhooks.at(-1)!.body).type).toBe("logs.view.resolved");
    expect((await call("viewer", "GET", "/api/v1/views/{id}", { concrete: `/api/v1/views/${viewId}` })).body.alert).toMatchObject({
      state: "ok",
      lastError: null,
    });
  });

  it("are changed by their owner or an admin; private ones are seen only by their owner", async () => {
    const mine = await call("admin", "POST", "/api/v1/views", { body: { name: "Mine", query: "*", shared: false } });
    expect((await call("viewer", "GET", "/api/v1/views")).body.views.map((v: { name: string }) => v.name)).toEqual(["Checkout errors"]);
    expect((await call("viewer", "GET", "/api/v1/views/{id}", { concrete: `/api/v1/views/${mine.body.view.id}` })).status).toBe(404);
    // A view without a threshold gets one: its secret is shown then.
    const withAlert = await call("admin", "PATCH", "/api/v1/views/{id}", {
      concrete: `/api/v1/views/${mine.body.view.id}`,
      body: { alert: { threshold: 5, windowMinutes: 5, webhookUrl: "https://hooks.example.com/x" } },
    });
    expect(withAlert.body.webhookSecret).toMatch(/^whsec_/);
    expect(
      (await call("admin", "PATCH", "/api/v1/views/{id}", { concrete: `/api/v1/views/${mine.body.view.id}`, body: { alert: null } })).body.view.alert,
    ).toBeNull();
    expect((await call("editor", "DELETE", "/api/v1/views/{id}", { concrete: `/api/v1/views/${mine.body.view.id}` })).status).toBe(404);
    const other = await call("admin", "POST", "/api/v1/views", { body: { name: "Shared by admin", query: "*" } });
    expect((await call("editor", "PATCH", "/api/v1/views/{id}", { concrete: `/api/v1/views/${other.body.view.id}`, body: { name: "Mine now" } })).status).toBe(
      409,
    );
    expect(
      (await call("admin", "PATCH", "/api/v1/views/{id}", { concrete: `/api/v1/views/${viewId}`, body: { name: "Checkout errors (all)" } })).body.view.name,
    ).toBe("Checkout errors (all)");
    expect((await call("admin", "DELETE", "/api/v1/views/{id}", { concrete: `/api/v1/views/${other.body.view.id}` })).status).toBe(204);
  });
});

describe("agents and hosts", () => {
  let agent: Awaited<ReturnType<typeof app.enroll>>;
  let hostId: string;

  it("agents are added by admins and enrol once with their token", async () => {
    const created = await call("admin", "POST", "/api/v1/agents", { body: { name: "dc-1" } });
    expect(created.status).toBe(201);
    const { agent: a, enrollToken } = created.body;
    expect((await call("viewer", "GET", "/api/v1/agents/{id}/setup", { concrete: `/api/v1/agents/${a.id}/setup` })).status).toBe(409);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: "ole_wrong", ...REPORT(version) } })).status).toBe(401);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version), caPublicKey: "nope" } })).status).toBe(422);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(200);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(401);
    const setup = await call("viewer", "GET", "/api/v1/agents/{id}/setup", { concrete: `/api/v1/agents/${a.id}/setup` });
    expect(setup.body).toMatchObject({ caPublicKey: CA_KEY, caFingerprint: fingerprint(CA_KEY), hostSetup: expect.stringContaining("systemd-journal") });
    // Re-enrolment: the old secret stops working.
    const again = await call("admin", "POST", "/api/v1/agents/{id}/enroll-token", { concrete: `/api/v1/agents/${a.id}/enroll-token` });
    expect(again.body.agent.status).toBe("waiting-to-enrol");
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${a.id}` })).status).toBe(204);
    expect((await call("viewer", "GET", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${a.id}` })).status).toBe(404);

    agent = await app.enroll("dc-2");
    expect((await call("viewer", "GET", "/api/v1/agents")).body.agents[0]).toMatchObject({ name: "dc-2", status: "online", version });
    expect((await call({ secret: "ola_wrong" }, "POST", "/api/v1/agent/work", { body: REPORT(version) })).status).toBe(401);
    expect(
      (await call({ secret: agent.secret }, "POST", "/api/v1/agent/results", { body: { jobId: "j", hostId: "nope", ok: true, entries: [] } })).status,
    ).toBe(404);
  });

  it("hosts go through an ssh source made for them, after their key is accepted", async () => {
    agent.hosts.set("10.0.0.5", { key: HOST_KEY, lines: [], cursor: "s=abc;i=1f;b=00;m=12;t=34;x=56" });
    const created = await call("admin", "POST", "/api/v1/hosts", { body: { name: "web-1", address: "10.0.0.5" } });
    expect(created.status).toBe(201);
    hostId = created.body.id;
    expect(created.body).toMatchObject({ status: "new", source: { name: "hosts" }, agent: { name: "dc-2" }, intervalSeconds: 60 });
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "web-1", address: "10.0.0.6" } })).status).toBe(409);
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "bad", address: "-oProxyCommand=x" } })).status).toBe(422);
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/read", { concrete: `/api/v1/hosts/${hostId}/read` })).status).toBe(409);

    await agent.round();
    const pending = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: `/api/v1/hosts/${hostId}` })).body;
    expect(pending).toMatchObject({ status: "host-key-pending", pendingHostKeys: [{ fingerprint: fingerprint(HOST_KEY) }] });
    expect(
      (
        await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", {
          concrete: `/api/v1/hosts/${hostId}/host-key/accept`,
          body: { fingerprint: "SHA256:nope" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", {
          concrete: `/api/v1/hosts/${hostId}/host-key/accept`,
          body: { fingerprint: fingerprint(HOST_KEY) },
        })
      ).body.status,
    ).toBe("pending");
  });

  it("reads store lines under the host's name, then move the cursor", async () => {
    const h = agent.hosts.get("10.0.0.5")!;
    h.lines = [
      {
        time: new Date().toISOString(),
        msg: "Failed password for root from 203.0.113.7",
        fields: { service: "sshd", level: "info", host: "what-the-host-says" },
      },
      { msg: "Started Daily apt upgrade.", fields: { service: "systemd" } },
    ];
    const { jobs } = await agent.round();
    expect(jobs).toEqual([expect.objectContaining({ action: "read", cursor: { journal: null, docker: null } })]);
    const lines = await app.until("host:web-1", 2);
    expect(lines.find((l) => l.service === "sshd")).toMatchObject({ host: "web-1", source: "hosts" });
    const after = (await call("viewer", "GET", "/api/v1/hosts")).body.hosts[0];
    expect(after).toMatchObject({ status: "ok", linesIn: 2 });
    // The next read starts where this one stopped.
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/read", { concrete: `/api/v1/hosts/${hostId}/read` })).status).toBe(202);
    expect((await agent.round()).jobs[0]!.cursor).toEqual({ journal: "s=abc;i=1f;b=00;m=12;t=34;x=56", docker: null });
  });

  it("a host that presents another key stops until an admin accepts it", async () => {
    agent.hosts.get("10.0.0.5")!.key = OTHER_KEY;
    await call("editor", "POST", "/api/v1/hosts/{id}/read", { concrete: `/api/v1/hosts/${hostId}/read` });
    await agent.round();
    const h = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: `/api/v1/hosts/${hostId}` })).body;
    expect(h).toMatchObject({ status: "host-key-changed", pendingHostKeys: [{ fingerprint: fingerprint(OTHER_KEY) }] });
    expect((await agent.round()).jobs).toEqual([]);
    expect((await call("admin", "POST", "/api/v1/hosts/{id}/host-key", { concrete: `/api/v1/hosts/${hostId}/host-key` })).status).toBe(200);
  });

  it("failures and other versions are reported, and hosts move and go", async () => {
    const moved = await call("admin", "PATCH", "/api/v1/hosts/{id}", {
      concrete: `/api/v1/hosts/${hostId}`,
      body: { address: "10.0.0.9", intervalSeconds: 30, containers: true },
    });
    expect(moved.body).toMatchObject({ status: "new", hostKeys: [], intervalSeconds: 30, containers: true });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: `/api/v1/hosts/${hostId}` })).body.statusDetail).toContain("Connection refused");
    expect((await call({ secret: agent.secret }, "POST", "/api/v1/agent/work", { body: REPORT("0.0.1") })).status).toBe(409);
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${agent.id}` })).status).toBe(409);
    expect((await call("admin", "DELETE", "/api/v1/sources/{id}", { concrete: `/api/v1/sources/${moved.body.source.id}` })).status).toBe(409);
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: `/api/v1/hosts/${hostId}` })).status).toBe(204);
  });
});

describe("overview", () => {
  it("counts sources, agents and hosts, lines and disk", async () => {
    const s = (await call("viewer", "GET", "/api/v1/summary")).body;
    // The agent last called with another version (above), so it shows as such until it is updated.
    expect(s).toMatchObject({ sources: { http: 1, ssh: 1 }, agents: { "version-mismatch": 1 }, retentionDays: 90, maxDiskGb: 50 });
    expect(s.linesLastHour).toBeGreaterThanOrEqual(8);
  });

  it("serves Prometheus metrics", async () => {
    const r = await call("none", "GET", "/metrics");
    expect(r.body).toContain('openasy_build_info{product="logs"');
    expect(r.body).toContain('openasy_logs_ingested_lines_total{via="jsonline"}');
    expect(r.body).toContain("openasy_logs_victorialogs_up 1");
  });
});

describe("coverage", () => {
  it("calls every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(all.filter((o) => !covered.has(o))).toEqual([]);
  });
});
