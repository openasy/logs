// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = (s: S = str) => ({ type: "object", additionalProperties: s });

const HOST_STATUS = {
  type: "string",
  enum: ["new", "host-key-pending", "host-key-changed", "pending", "ok", "unreachable", "auth-failed", "timeout", "error"],
  description: "Of the last read. new and host-key-pending wait for an admin to accept the host key.",
};
const PROCESSOR = {
  oneOf: [
    { ...obj({ type: { const: "parse-json" } }), description: "JSON in the message becomes fields; its message, time and level take their places." },
    {
      ...obj({ type: { const: "parse-regex" }, pattern: str }),
      description: "Named groups become fields. A group named msg replaces the message, one named time the time.",
    },
    {
      ...obj({ type: { const: "map-level" }, field: str }, ["type"]),
      description: "Names the level alike (error, warn, info...) from words, syslog severities or numbers. field defaults to level.",
    },
    {
      ...obj({ type: { const: "mask" }, pattern: str, replacement: str }, ["type", "pattern"]),
      description: "Replaces what matches, in the message and every field. replacement defaults to ***.",
    },
    { ...obj({ type: { const: "mask-secrets" } }), description: "Masks values that look like passwords, tokens, keys and credentials in URLs." },
    { ...obj({ type: { const: "drop" }, field: str, pattern: str }), description: "Drops lines whose field matches. field msg is the message." },
    {
      ...obj({ type: { const: "sample" }, field: str, pattern: str, percent: { type: "integer", minimum: 1, maximum: 99 } }),
      description: "Keeps percent of the lines whose field matches, and every other line.",
    },
    { ...obj({ type: { const: "set" }, field: str, value: str }), description: "Sets a field, such as service for a source that does not send it." },
  ],
};

const schemas: Record<string, S> = {
  Problem: {
    type: "object",
    required: ["type", "title", "status", "code"],
    properties: {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-json",
          "invalid-body",
          "invalid-query",
          "not-found",
          "conflict",
          "not-configured",
          "unavailable",
          "version-mismatch",
          "internal-error",
          "unauthenticated",
          "invalid-token",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
  },
  ProductLink: obj({
    id: { ...str, description: "The product, as OpenAsy names it.", examples: ["infrastructure"] },
    url: { ...str, format: "uri", description: "The address people open it at.", examples: ["https://infra.example.com"] },
  }),
  Processor: PROCESSOR,
  Source: obj({
    id: str,
    name: str,
    kind: {
      type: "string",
      enum: ["http", "syslog", "ssh"],
      description: "http: shippers send with the source's token. syslog: senders in its networks. ssh: hosts logs-agent reads.",
    },
    networks: { ...arr(str), description: "For syslog: the senders it takes, as addresses or networks." },
    plain: { ...bool, description: "For syslog: also take plain TCP and UDP from these networks, not only TLS." },
    processors: arr(ref("Processor")),
    enabled: bool,
    linesIn: int,
    linesDropped: { ...int, description: "Dropped or sampled away by the pipeline." },
    lastSeenAt: nul(dt),
    lastError: nul(str),
    hosts: nul(int),
    createdAt: dt,
  }),
  SourceInput: {
    type: "object",
    required: ["name", "kind"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$" },
      kind: { type: "string", enum: ["http", "syslog", "ssh"] },
      networks: arr(str),
      plain: bool,
      processors: { ...arr(ref("Processor")), description: "Defaults to parse-json, map-level and mask-secrets." },
      enabled: bool,
    },
  },
  NewSource: obj({ source: ref("Source"), token: { ...str, description: "For http sources: the ingest token, shown once (olg_...)." } }, ["source"]),
  Line: obj({ time: dt, msg: str, level: nul(str), host: nul(str), service: nul(str), source: nul(str), fields: map() }),
  Search: obj({
    lines: arr(ref("Line")),
    start: dt,
    end: dt,
    truncated: { ...bool, description: "More lines matched than the limit; narrow the query or the range." },
  }),
  Volume: obj({ step: str, times: arr(dt), series: arr(obj({ level: str, values: arr(int), total: int })) }),
  Facets: obj({ fields: arr(obj({ field: str, values: arr(obj({ value: str, hits: int })) })) }),
  Alert: nul(
    obj({
      threshold: int,
      windowMinutes: int,
      webhookUrl: str,
      state: { type: "string", enum: ["ok", "firing", "error"] },
      lastCount: nul(int),
      lastCheckedAt: nul(dt),
      lastFiredAt: nul(dt),
      lastError: nul(str),
    }),
  ),
  View: obj({ id: str, name: str, query: str, owner: obj({ id: str, name: str }), shared: bool, alert: ref("Alert"), createdAt: dt, updatedAt: dt }),
  ViewInput: {
    type: "object",
    required: ["name", "query"],
    properties: {
      name: { type: "string", maxLength: 80 },
      query: { ...str, description: "LogsQL." },
      shared: { ...bool, default: true, description: "Seen by everyone; private views only by their owner." },
      alert: nul({
        ...obj({ threshold: { ...int, minimum: 0 }, windowMinutes: { type: "integer", minimum: 1, maximum: 1440 }, webhookUrl: str }),
        description: "Checked every minute: when more lines than threshold matched in the window, the webhook is called, and again when it is back under.",
      }),
    },
  },
  NewView: obj(
    {
      view: ref("View"),
      webhookSecret: { ...str, description: "Shown once when a threshold is added: verify the webhook-signature header with it (Standard Webhooks)." },
    },
    ["view"],
  ),
  Settings: obj({
    retentionDays: { type: "integer", minimum: 1, maximum: 3650 },
    maxDiskGb: { type: "integer", minimum: 0, description: "0: the oldest days go when the volume is 90% full." },
  }),
  Syslog: obj({
    tlsPort: int,
    plainPort: int,
    fingerprint: { ...str, description: "SHA-256 of the certificate senders should pin." },
    certificate: str,
    origin: { type: "string", enum: ["file", "generated"] },
    stats: nul(obj({ received: int, unmatched: int, connections: int, errors: int })),
  }),
  Searches: obj({ searches: arr(obj({ id: int, at: dt, actor: str, kind: { type: "string", enum: ["search", "tail"] }, query: str })), nextCursor: str }, [
    "searches",
  ]),
  Preview: obj({ results: arr(obj({ kept: bool, msg: nul(str), fields: map() })) }),
  Ingested: obj({ accepted: int, dropped: int }),
  HostKey: obj({ type: str, fingerprint: { type: "string", pattern: "^SHA256:" } }),
  Host: obj({
    id: str,
    name: str,
    agent: obj({ id: str, name: str }),
    source: obj({ id: str, name: str }),
    origin: {
      type: "string",
      enum: ["ui", "file"],
      description: "file: from the hosts file (OPENASY_HOSTS, ADR 0052); changed there, so PATCH and DELETE answer 409. Fetching its key still works.",
    },
    fileHostKey: {
      ...nul(str),
      description:
        "The fingerprint hostKey gives in the hosts file: a host that presents that key is trusted without an admin, and no other key can be accepted here.",
    },
    address: str,
    port: int,
    user: str,
    auth: { type: "string", enum: ["certificate", "key"] },
    containers: { ...bool, description: "Also read container logs through the host's Docker. Access to the socket is equivalent to root (ADR 0031)." },
    intervalSeconds: int,
    hostKeys: arr(ref("HostKey")),
    pendingHostKeys: arr(ref("HostKey")),
    status: HOST_STATUS,
    statusDetail: nul(str),
    unreadable: { ...arr(str), description: "What the account may not read, such as the system journal without the systemd-journal group." },
    linesIn: int,
    lastAttemptAt: nul(dt),
    lastSuccessAt: nul(dt),
    createdAt: dt,
  }),
  HostInput: {
    type: "object",
    required: ["name", "address"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$", description: "Stored as the host field of its lines." },
      agentId: { type: "string", description: "The agent that reads this host. Optional when there is only one." },
      sourceId: { type: "string", description: "The ssh source whose pipeline its lines go through. Optional when there is one or none." },
      address: str,
      port: { type: "integer", default: 22 },
      user: { type: "string", default: "openasy" },
      auth: { type: "string", enum: ["certificate", "key"], default: "certificate" },
      containers: { type: "boolean", default: false },
      intervalSeconds: { type: "integer", minimum: 15, maximum: 3600, default: 60 },
    },
  },
  Agent: obj({
    id: str,
    name: str,
    status: { type: "string", enum: ["waiting-to-enrol", "online", "offline", "version-mismatch"] },
    version: nul(str),
    caFingerprint: nul(str),
    lastSeenAt: nul(dt),
    lastError: nul(str),
    hosts: int,
    createdAt: dt,
  }),
  NewAgent: obj({ agent: ref("Agent"), enrollToken: { ...str, description: "One-time, valid 7 days (ole_...). Shown once." }, enrollExpiresAt: dt }),
  AgentSetup: obj({ agent: ref("Agent"), caPublicKey: str, caFingerprint: str, keyPublicKey: nul(str), sshdConfig: str, hostSetup: str, authorizedKey: str }),
  AgentReport: {
    type: "object",
    required: ["version", "caPublicKey", "keyPublicKey", "setup"],
    description: "What logs-agent says about itself on every call: its version (it must equal logs', ADR 0019), its public keys and the host setup.",
    properties: { version: str, caPublicKey: str, keyPublicKey: str, setup: obj({ sshdConfig: str, hostSetup: str, authorizedKey: str }), running: int },
  },
  Job: obj({
    id: str,
    hostId: str,
    action: { type: "string", enum: ["read", "host-key"] },
    target: obj({ address: str, port: int, user: str, hostKeys: arr(str), auth: { type: "string", enum: ["certificate", "key"] }, containers: bool }),
    cursor: obj({ journal: nul(str), docker: nul(str) }),
  }),
  Result: {
    type: "object",
    required: ["jobId", "hostId", "ok"],
    description: "One of: entries (a read, with where it stopped), hostKeys (the keys a host presents), or error.",
    properties: {
      jobId: str,
      hostId: str,
      ok: bool,
      entries: arr(obj({ time: str, msg: str, fields: map() }, ["msg"])),
      cursor: obj({ journal: nul(str), docker: nul(str) }, []),
      more: { ...bool, description: "The read stopped at its limit; the host is read again at once." },
      unreadable: arr(str),
      hostKeys: arr(str),
      error: obj({ kind: str, message: str }),
    },
  },
  Summary: obj({
    sources: map(int),
    agents: map(int),
    hosts: map(int),
    linesLastHour: nul(int),
    storedBytes: nul(int),
    retentionDays: int,
    maxDiskGb: int,
    alertsFiring: int,
    hostsFile: { ...nul(ref("HostsFile")), description: "null when OPENASY_HOSTS is not set." },
  }),
  HostsFile: {
    ...obj({
      path: str,
      appliedAt: { ...nul(dt), description: "When it was last read and applied; null if it never was." },
      entries: int,
      error: { ...nul(str), description: "Why the file on disk is not applied." },
      warnings: { ...arr(str), description: "What to fix that did not stop the file from being applied, such as a host whose agent is not enrolled yet." },
    }),
    description:
      "The hosts file (ADR 0052), shared with Infrastructure. It is read again within a minute of a change; a file that cannot be applied leaves the hosts from its last good version.",
  },
};

const P = (...codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), { $ref: "#/components/responses/Problem" }]));
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const id = { name: "id", in: "path", required: true, schema: str };
const range = [
  { name: "query", in: "query", schema: { type: "string", default: "*" }, description: 'LogsQL, such as `service:api level:error "timeout"`.' },
  { name: "start", in: "query", schema: dt, description: "Defaults to 15 minutes before end." },
  { name: "end", in: "query", schema: dt, description: "Defaults to now." },
];
const SEC = [{ session: [] }, { apiToken: [] }];
const AGENT_SEC = [{ agentSecret: [] }];
const INGEST_SEC = [{ ingestToken: [] }, { ingestBasic: [] }];
const op = (o: {
  id: string;
  tag: string;
  summary: string;
  description?: string;
  role?: string;
  security?: unknown[];
  params?: unknown[];
  body?: S;
  requestBody?: S;
  responses: Record<string, unknown>;
}) => ({
  operationId: o.id,
  tags: [o.tag],
  summary: o.summary,
  ...(o.description || o.role ? { description: [o.description, o.role && `Needs the ${o.role} role.`].filter(Boolean).join("\n\n") } : {}),
  ...(o.role && { security: SEC, "x-openasy-role": o.role }),
  ...(o.security && { security: o.security }),
  ...(o.params && { parameters: o.params }),
  ...(o.body && { requestBody: body(o.body) }),
  ...(o.requestBody && { requestBody: o.requestBody }),
  responses: o.responses,
});
const R = (role: string) => P(...(role ? [401, 403] : []));
const bulk = (path: string, params: unknown[] = []) =>
  op({
    id: path.includes("{index}") ? "ingestBulkIndex" : "ingestBulk",
    tag: "Ingest",
    summary: "Elasticsearch bulk",
    description:
      "For Winlogbeat, Filebeat, Fluent Bit and Vector with their Elasticsearch outputs: point them at /api/v1/ingest/elasticsearch with the token as password or API key. Documents become lines; actions other than index and create are ignored. Beats need `setup.template.enabled: false` and `setup.ilm.enabled: false`.",
    security: INGEST_SEC,
    params,
    requestBody: { required: true, content: { "application/x-ndjson": { schema: str } } },
    responses: { "200": ok(obj({ took: int, errors: bool, items: arr({ type: "object" }) })), ...P(400, 401, 409, 413, 503) },
  });

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Logs API",
    version: "0.4.0",
    summary: "Search what happened on every host and service.",
    description:
      "Every screen of Logs uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only (ADR 0024). Errors use Problem Details (RFC 9457).\n\nLogs are stored in VictoriaLogs inside the product and searched with [LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/) as it is (ADR 0035). They are sent with a source's ingest token, by syslog, or read over SSH by logs-agent. Each operation names the role it needs (`x-openasy-role`). Sign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Logs" }],
  tags: [
    { name: "Search", description: "LogsQL over every line kept. Searches are recorded with who asked (ADR 0015)." },
    { name: "Views", description: "Saved queries, and thresholds that call a signed webhook." },
    { name: "Sources", description: "Where logs come from, and the pipeline each goes through." },
    { name: "Ingest", description: "What shippers call, with a source's ingest token." },
    { name: "Agents", description: "logs-agent: installed once, it reads journald and Docker over SSH. Nothing is installed on hosts (ADR 0031)." },
    { name: "Hosts", description: "Servers an agent reads." },
    { name: "Product", description: "Version, health, overview and retention." },
  ],
  paths: {
    "/api/v1/version": { get: op({ id: "version", tag: "Product", summary: "Version", responses: { "200": ok(obj({ product: str, version: str })) } }) },
    "/api/v1/products": {
      get: op({
        id: "listProducts",
        tag: "Product",
        summary: "Other OpenAsy products",
        description: "The OpenAsy products of this install and their addresses, from `OPENASY_PRODUCTS`, for the product switcher. Empty when it is not set.",
        role: "viewer",
        responses: { "200": ok(obj({ products: arr(ref("ProductLink")) }), "The products, in the order they are configured."), ...R("v") },
      }),
    },
    "/api/v1/summary": { get: op({ id: "summary", tag: "Product", summary: "Overview", role: "viewer", responses: { "200": ok(ref("Summary")), ...R("v") } }) },
    "/api/v1/settings": {
      get: op({ id: "getSettings", tag: "Product", summary: "Retention", role: "viewer", responses: { "200": ok(ref("Settings")), ...R("v") } }),
      patch: op({
        id: "updateSettings",
        tag: "Product",
        summary: "Change retention",
        description: "VictoriaLogs is started again with the new retention; lines older than it are removed.",
        role: "admin",
        body: { type: "object", properties: (schemas.Settings as { properties: S }).properties },
        responses: { "200": ok(ref("Settings")), ...R("a"), ...P(400, 422) },
      }),
    },
    "/api/v1/search": {
      get: op({
        id: "search",
        tag: "Search",
        summary: "Search",
        description: "The newest lines that match, newest first.",
        role: "viewer",
        params: [...range, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000, default: 200 } }],
        responses: { "200": ok(ref("Search")), ...R("v"), ...P(422, 503) },
      }),
    },
    "/api/v1/volume": {
      get: op({
        id: "volume",
        tag: "Search",
        summary: "Lines over time, by level",
        role: "viewer",
        params: range,
        responses: { "200": ok(ref("Volume")), ...R("v"), ...P(422, 503) },
      }),
    },
    "/api/v1/facets": {
      get: op({
        id: "facets",
        tag: "Search",
        summary: "The most frequent values of each field",
        role: "viewer",
        params: range,
        responses: { "200": ok(ref("Facets")), ...R("v"), ...P(422, 503) },
      }),
    },
    "/api/v1/tail": {
      get: op({
        id: "tail",
        tag: "Search",
        summary: "Live tail",
        description: "Server-sent events: each `data:` is a Line as it arrives. Lines read over SSH arrive at each host's interval.",
        role: "viewer",
        params: [range[0]],
        responses: { "200": { description: "A stream of lines", content: { "text/event-stream": { schema: str } } }, ...R("v"), ...P(422, 503) },
      }),
    },
    "/api/v1/searches": {
      get: op({
        id: "listSearches",
        tag: "Search",
        summary: "Who searched for what",
        description: "Kept 400 days.",
        role: "admin",
        params: [
          { name: "cursor", in: "query", schema: str },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { "200": ok(ref("Searches")), ...R("a"), ...P(422) },
      }),
    },
    "/api/v1/views": {
      get: op({
        id: "listViews",
        tag: "Views",
        summary: "Saved views",
        description: "Shared views and your own.",
        role: "viewer",
        responses: { "200": ok(obj({ views: arr(ref("View")) })), ...R("v") },
      }),
      post: op({
        id: "createView",
        tag: "Views",
        summary: "Save a view",
        role: "editor",
        body: ref("ViewInput"),
        responses: { "201": ok(ref("NewView"), "Saved"), ...R("e"), ...P(400, 422) },
      }),
    },
    "/api/v1/views/{id}": {
      get: op({
        id: "getView",
        tag: "Views",
        summary: "Get a view",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("View")), ...R("v"), ...P(404) },
      }),
      patch: op({
        id: "updateView",
        tag: "Views",
        summary: "Change a view",
        description: "Its owner, or an admin.",
        role: "editor",
        params: [id],
        body: { type: "object", properties: (schemas.ViewInput as { properties: S }).properties },
        responses: { "200": ok(ref("NewView")), ...R("e"), ...P(400, 404, 409, 422) },
      }),
      delete: op({
        id: "deleteView",
        tag: "Views",
        summary: "Remove a view",
        description: "Its owner, or an admin.",
        role: "editor",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("e"), ...P(404, 409) },
      }),
    },
    "/api/v1/sources": {
      get: op({
        id: "listSources",
        tag: "Sources",
        summary: "List sources",
        role: "viewer",
        responses: { "200": ok(obj({ sources: arr(ref("Source")) })), ...R("v") },
      }),
      post: op({
        id: "createSource",
        tag: "Sources",
        summary: "Add a source",
        description: "An http source gets its ingest token, shown once. A syslog source needs the networks it takes.",
        role: "admin",
        body: ref("SourceInput"),
        responses: { "201": ok(ref("NewSource"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/sources/{id}": {
      get: op({
        id: "getSource",
        tag: "Sources",
        summary: "Get a source",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Source")), ...R("v"), ...P(404) },
      }),
      patch: op({
        id: "updateSource",
        tag: "Sources",
        summary: "Change a source or its pipeline",
        role: "admin",
        params: [id],
        body: { type: "object", properties: (schemas.SourceInput as { properties: S }).properties },
        responses: { "200": ok(ref("Source")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
      delete: op({
        id: "deleteSource",
        tag: "Sources",
        summary: "Remove a source",
        description: "Lines it sent stay until retention removes them.",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/sources/{id}/token": {
      post: op({
        id: "rotateSourceToken",
        tag: "Sources",
        summary: "A new ingest token",
        description: "The old one stops working at once.",
        role: "admin",
        params: [id],
        responses: { "200": ok(ref("NewSource")), ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/pipelines/preview": {
      post: op({
        id: "previewPipeline",
        tag: "Sources",
        summary: "Try processors on sample lines",
        description: "Nothing is stored.",
        role: "editor",
        body: obj({ processors: arr(ref("Processor")), lines: arr(str) }),
        responses: { "200": ok(ref("Preview")), ...R("e"), ...P(400, 422) },
      }),
    },
    "/api/v1/syslog": {
      get: op({
        id: "syslog",
        tag: "Sources",
        summary: "Where syslog goes, and the certificate to pin",
        role: "viewer",
        responses: { "200": ok(ref("Syslog")), ...R("v"), ...P(409) },
      }),
    },
    "/api/v1/ingest/jsonline": {
      post: op({
        id: "ingestJsonLines",
        tag: "Ingest",
        summary: "JSON lines",
        description:
          "One JSON object per line, as Vector's http sink (ndjson) and Fluent Bit's http output (json_lines) send. The message, time and level are read from their usual names (message, msg, log; @timestamp, time, ts; level, severity); the rest become fields. Gzip is welcome.",
        security: INGEST_SEC,
        requestBody: { required: true, content: { "application/x-ndjson": { schema: str } } },
        responses: { "202": ok(ref("Ingested"), "Stored"), ...P(400, 401, 409, 413, 503) },
      }),
    },
    "/api/v1/ingest/otlp/v1/logs": {
      post: op({
        id: "ingestOtlp",
        tag: "Ingest",
        summary: "OpenTelemetry logs",
        description:
          "OTLP/HTTP, protobuf or JSON: set the OpenTelemetry Collector's otlphttp exporter logs_endpoint here, with the token as a Bearer header. service.name and host.name become service and host.",
        security: INGEST_SEC,
        requestBody: { required: true, content: { "application/x-protobuf": { schema: str }, "application/json": { schema: { type: "object" } } } },
        responses: {
          "200": { description: "Stored", content: { "application/x-protobuf": { schema: str }, "application/json": { schema: { type: "object" } } } },
          ...P(400, 401, 409, 413, 415, 503),
        },
      }),
    },
    "/api/v1/ingest/elasticsearch": {
      get: op({
        id: "ingestElasticsearchInfo",
        tag: "Ingest",
        summary: "Elasticsearch version check",
        description: "What Elasticsearch clients ask before they send.",
        security: INGEST_SEC,
        responses: { "200": ok({ type: "object" }), ...P(401, 409) },
      }),
    },
    "/api/v1/ingest/elasticsearch/_license": {
      get: op({
        id: "ingestElasticsearchLicense",
        tag: "Ingest",
        summary: "Elasticsearch licence check",
        description: "What Beats ask before they send.",
        security: INGEST_SEC,
        responses: { "200": ok({ type: "object" }), ...P(401, 409) },
      }),
    },
    "/api/v1/ingest/elasticsearch/_bulk": { post: bulk("/api/v1/ingest/elasticsearch/_bulk") },
    "/api/v1/ingest/elasticsearch/{index}/_bulk": {
      post: bulk("/api/v1/ingest/elasticsearch/{index}/_bulk", [
        { name: "index", in: "path", required: true, schema: str, description: "Ignored: every document goes to the source." },
      ]),
    },
    "/api/v1/agents": {
      get: op({
        id: "listAgents",
        tag: "Agents",
        summary: "List agents",
        role: "viewer",
        responses: { "200": ok(obj({ agents: arr(ref("Agent")) })), ...R("v") },
      }),
      post: op({
        id: "createAgent",
        tag: "Agents",
        summary: "Add an agent",
        description: "Returns a one-time enrolment token, valid for 7 days. Start logs-agent with it; the agent then has its own secret (ADR 0023).",
        role: "admin",
        body: obj({ name: str }),
        responses: { "201": ok(ref("NewAgent"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/agents/{id}": {
      get: op({
        id: "getAgent",
        tag: "Agents",
        summary: "Get an agent",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Agent")), ...R("v"), ...P(404) },
      }),
      delete: op({
        id: "deleteAgent",
        tag: "Agents",
        summary: "Remove an agent",
        description: "Only an agent that reads no hosts. Its secret stops working.",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/agents/{id}/enroll-token": {
      post: op({
        id: "reEnrollAgent",
        tag: "Agents",
        summary: "Enrol an agent again",
        description: "A new one-time token, for an agent that lost its volume. Its old secret stops working; its hosts must trust the new CA.",
        role: "admin",
        params: [id],
        responses: { "200": ok(ref("NewAgent")), ...R("a"), ...P(404) },
      }),
    },
    "/api/v1/agents/{id}/setup": {
      get: op({
        id: "agentSetup",
        tag: "Agents",
        summary: "What to put on the hosts this agent reads",
        description:
          "Its CA public key, the sshd drop-in, the commands to prepare a host (with the systemd-journal group, which reading the system journal needs) and the fixed key.",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("AgentSetup")), ...R("v"), ...P(404, 409) },
      }),
    },
    "/api/v1/agent/enroll": {
      post: op({
        id: "agentEnroll",
        tag: "Agents",
        summary: "logs-agent: enrol with a one-time token",
        description: "Called by logs-agent, not by people.",
        body: { allOf: [ref("AgentReport"), obj({ token: str })] },
        responses: { "200": ok(obj({ agentId: str, secret: str })), ...P(400, 401, 422) },
      }),
    },
    "/api/v1/agent/work": {
      post: op({
        id: "agentWork",
        tag: "Agents",
        summary: "logs-agent: ask for jobs",
        description: "Each job is leased for 2 minutes. Answers 409 when the agent's version differs from logs' (ADR 0019).",
        body: ref("AgentReport"),
        security: AGENT_SEC,
        responses: { "200": ok(obj({ jobs: arr(ref("Job")) })), ...P(400, 401, 409, 422) },
      }),
    },
    "/api/v1/agent/results": {
      post: op({
        id: "agentResult",
        tag: "Agents",
        summary: "logs-agent: send what a read found",
        description: "Lines are masked by the agent and go through the host's source pipeline. The cursor moves only once they are stored. Gzip the body.",
        body: ref("Result"),
        security: AGENT_SEC,
        responses: { "202": ok(obj({ status: str }), "Accepted"), ...P(400, 401, 404, 409, 422, 503) },
      }),
    },
    "/api/v1/hosts": {
      get: op({ id: "listHosts", tag: "Hosts", summary: "List hosts", role: "viewer", responses: { "200": ok(obj({ hosts: arr(ref("Host")) })), ...R("v") } }),
      post: op({
        id: "createHost",
        tag: "Hosts",
        summary: "Add a host",
        description: "Logs asks the host for its key right away. Check the fingerprint on the host and accept it before the first read.",
        role: "admin",
        body: ref("HostInput"),
        responses: { "201": ok(ref("Host"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/hosts/{id}": {
      get: op({
        id: "getHost",
        tag: "Hosts",
        summary: "Get a host",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Host")), ...R("v"), ...P(404) },
      }),
      patch: op({
        id: "updateHost",
        tag: "Hosts",
        summary: "Change a host",
        description: "A new address or port unpins the host key.",
        role: "admin",
        params: [id],
        body: { type: "object", properties: (schemas.HostInput as { properties: S }).properties },
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
      delete: op({
        id: "deleteHost",
        tag: "Hosts",
        summary: "Stop reading a host",
        description: "Its lines stay until retention removes them.",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/hosts/{id}/read": {
      post: op({
        id: "readHost",
        tag: "Hosts",
        summary: "Read now",
        role: "editor",
        params: [id],
        responses: { "202": ok(obj({ status: str }), "Requested"), ...R("e"), ...P(404, 409) },
      }),
    },
    "/api/v1/hosts/{id}/host-key": {
      post: op({
        id: "fetchHostKey",
        tag: "Hosts",
        summary: "Ask the host for its key again",
        role: "admin",
        params: [id],
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(404) },
      }),
    },
    "/api/v1/hosts/{id}/host-key/accept": {
      post: op({
        id: "acceptHostKey",
        tag: "Hosts",
        summary: "Accept a host key",
        description: "After checking on the host that `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints this fingerprint.",
        role: "admin",
        params: [id],
        body: obj({ fingerprint: str }),
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
    },
    "/healthz": { get: { operationId: "healthz", tags: ["Product"], summary: "Liveness", responses: { "200": ok(obj({ status: str })) } } },
    "/readyz": {
      get: {
        operationId: "readyz",
        tags: ["Product"],
        summary: "Readiness: the database and VictoriaLogs",
        responses: { "200": ok(obj({ status: str })), "503": ok(obj({ status: str }), "Not ready") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        responses: { "200": { description: "Prometheus text format", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description: "The browser session after signing in (`openasy-session` on plain http://localhost).",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description: "An API token from Settings → API tokens (`oa_logs_...`): one role, always an expiry (ADR 0003).",
      },
      agentSecret: { type: "http", scheme: "bearer", description: "logs-agent's own secret (`ola_...`), from enrolment (ADR 0023)." },
      ingestToken: { type: "http", scheme: "bearer", description: "A source's ingest token (`olg_...`). `Authorization: ApiKey <token>` works too." },
      ingestBasic: { type: "http", scheme: "basic", description: "For Elasticsearch outputs: any user name, the ingest token as password." },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
