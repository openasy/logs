// Sources, agents and hosts, saved views and their thresholds, search and what it is allowed to see. Everything the
// API offers goes through here. Logs holds no SSH key and sends no commands: logs-agent asks for jobs ("read this
// host from this cursor"), runs the script built into it and sends back the lines (ADR 0031, 0035).
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HostEntry } from "./hosts.ts";
import type { Keyring } from "./kek.ts";
import { log } from "./log.ts";
import { checkProcessors, compile, DEFAULT_PROCESSORS, MAX_MSG, PipelineError, toTime, type Entry, type Processor } from "./pipeline.ts";
import { inNetwork, parseNetwork } from "./syslog.ts";
import { VlogsError, type Line, type VlogsClient } from "./vlogs.ts";

export type ProblemCode =
  | "invalid-body"
  | "invalid-query"
  | "not-found"
  | "conflict"
  | "not-configured"
  | "invalid-json"
  | "invalid-token"
  | "version-mismatch"
  | "unavailable"
  | "internal-error";

export class LogsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

/** Who asks: a person signed in, or an API token. Views belong to them, and searches are recorded under them. */
export interface Actor {
  id: string;
  name: string;
}

type SourceKind = "http" | "syslog" | "ssh";

interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  token_hash: string | null;
  networks: string;
  plain: number;
  processors: string;
  enabled: number;
  lines_in: number;
  lines_dropped: number;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  enroll_token_hash: string | null;
  enroll_expires_at: string | null;
  secret_hash: string | null;
  version: string | null;
  ca_public_key: string | null;
  key_public_key: string | null;
  setup: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface HostRow {
  id: string;
  name: string;
  agent_id: string;
  source_id: string;
  address: string;
  port: number;
  ssh_user: string;
  auth: "certificate" | "key";
  containers: number;
  interval_seconds: number;
  host_keys: string;
  pending_host_keys: string;
  status: string;
  status_detail: string | null;
  unreadable: string;
  journal_cursor: string | null;
  docker_since: string | null;
  lines_in: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  read_requested: number;
  key_requested: number;
  lease_until: string | null;
  created_at: string;
  origin: "ui" | "file";
  file_host_key: string | null;
}

interface ViewRow {
  id: string;
  name: string;
  query: string;
  owner_id: string;
  owner_name: string;
  shared: number;
  alert_threshold: number | null;
  alert_window_minutes: number | null;
  alert_webhook_url: string | null;
  alert_secret_sealed: string | null;
  alert_state: "ok" | "firing" | "error";
  alert_last_count: number | null;
  alert_last_checked_at: string | null;
  alert_last_fired_at: string | null;
  alert_last_error: string | null;
  created_at: string;
  updated_at: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const VIEW_NAME = /^\S.{0,79}$/;
// Never starts with "-": a value that ssh could read as an option. The agent checks it again.
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$|^\[[0-9a-fA-F:]+\]$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
/** journalctl cursors: s=...;i=...;b=...;m=...;t=...;x=... */
const CURSOR = /^[a-z]=[0-9a-f]+(;[a-z]=[0-9a-f]+){0,7}$/;
const JOB_LEASE_MS = 2 * 60_000;
const ENROLL_TTL_MS = 7 * 86_400_000;
const AGENT_OFFLINE_MS = 2 * 60_000;
const MAX_QUERY = 4000;
/** Searches are recorded for this long, like sign-ins (ADR 0013). */
const AUDIT_DAYS = 400;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** SHA256:... as OpenSSH prints it. */
export function fingerprint(keyLine: string): string {
  const blob = keyLine.trim().split(/\s+/)[1] ?? "";
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Where a webhook may point. Loopback, link-local and unspecified addresses are refused, so a view cannot make Logs
 * call VictoriaLogs or a metadata service on its own host.
 */
export function checkWebhookUrl(v: unknown): string {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    throw new LogsError(422, "invalid-body", "alert.webhookUrl is an http:// or https:// address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new LogsError(422, "invalid-body", "alert.webhookUrl is an http:// or https:// address.");
  if (u.username || u.password) throw new LogsError(422, "invalid-body", "alert.webhookUrl must not hold a user or password; the webhook is signed instead.");
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^(127\.|0\.|169\.254\.)/.test(h) ||
    h === "::1" ||
    h === "::" ||
    h.startsWith("fe80:") ||
    /^::ffff:(127\.|169\.254\.)/.test(h)
  ) {
    throw new LogsError(422, "invalid-body", "alert.webhookUrl cannot point at this host or a link-local address.");
  }
  return u.toString();
}

/** A step for the volume chart that gives about 60 bars over the range. */
export function stepFor(ms: number): string {
  const steps: Array<[number, string]> = [
    [10_000, "10s"],
    [30_000, "30s"],
    [60_000, "1m"],
    [300_000, "5m"],
    [900_000, "15m"],
    [1_800_000, "30m"],
    [3_600_000, "1h"],
    [10_800_000, "3h"],
    [21_600_000, "6h"],
    [43_200_000, "12h"],
    [86_400_000, "1d"],
  ];
  return steps.find(([s]) => ms / s <= 90)?.[1] ?? "7d";
}

export function createLogs(
  db: DatabaseSync,
  keyring: Keyring,
  vlogs: VlogsClient,
  opts: { version: string; publicUrl?: string; now?: () => number; fetch?: typeof fetch },
) {
  const now = opts.now ?? Date.now;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const post = opts.fetch ?? fetch;
  const bad = (m: string) => new LogsError(422, "invalid-body", m);

  const unavailable = (err: unknown): never => {
    if (err instanceof VlogsError) throw err.status === 400 ? new LogsError(422, "invalid-query", err.message) : new LogsError(503, "unavailable", err.message);
    throw err;
  };

  // ---- Settings ---------------------------------------------------------------------------------------------------

  const DEFAULTS = { retentionDays: 30, maxDiskGb: 0 };
  function settings(): typeof DEFAULTS {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('retentionDays', 'maxDiskGb')").all() as Array<{ key: string; value: string }>;
    const out = { ...DEFAULTS };
    for (const r of rows) out[r.key as keyof typeof DEFAULTS] = Number(r.value);
    return out;
  }
  function updateSettings(b: Record<string, unknown>) {
    const cur = settings();
    if (b.retentionDays !== undefined) {
      if (typeof b.retentionDays !== "number" || !Number.isInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > 3650)
        throw bad("retentionDays is 1 to 3650.");
      cur.retentionDays = b.retentionDays;
    }
    if (b.maxDiskGb !== undefined) {
      if (typeof b.maxDiskGb !== "number" || !Number.isInteger(b.maxDiskGb) || b.maxDiskGb < 0 || b.maxDiskGb > 1_000_000)
        throw bad("maxDiskGb is 0 (90% of the volume) or a number of gigabytes.");
      cur.maxDiskGb = b.maxDiskGb;
    }
    const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    up.run("retentionDays", String(cur.retentionDays));
    up.run("maxDiskGb", String(cur.maxDiskGb));
    return cur;
  }

  // ---- Sources ----------------------------------------------------------------------------------------------------

  const sourceRow = (id: string) => db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
  const requireSource = (id: string) => {
    const s = sourceRow(id);
    if (!s) throw new LogsError(404, "not-found", "No such source.");
    return s;
  };

  function toSource(s: SourceRow) {
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      networks: JSON.parse(s.networks) as string[],
      plain: s.plain === 1,
      processors: JSON.parse(s.processors) as Processor[],
      enabled: s.enabled === 1,
      linesIn: s.lines_in,
      linesDropped: s.lines_dropped,
      lastSeenAt: s.last_seen_at,
      lastError: s.last_error,
      hosts: s.kind === "ssh" ? (db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE source_id = ?").get(s.id) as { n: number }).n : null,
      createdAt: s.created_at,
    };
  }

  function sourceInput(b: Record<string, unknown>, kind: SourceKind, partial: boolean) {
    const out: Partial<{ name: string; networks: string[]; plain: boolean; processors: Processor[]; enabled: boolean }> = {};
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== "string" || !NAME.test(b.name)) throw bad("name is letters, digits, dots, dashes and underscores, up to 63.");
      out.name = b.name;
    }
    if (b.networks !== undefined) {
      if (kind !== "syslog") throw bad("networks are for syslog sources.");
      if (!Array.isArray(b.networks) || b.networks.length > 64) throw bad("networks is a list of up to 64 addresses or networks, such as 10.0.0.0/8.");
      for (const n of b.networks) {
        try {
          parseNetwork(String(n));
        } catch (err) {
          throw bad(`networks: ${(err as Error).message}.`);
        }
      }
      out.networks = b.networks.map(String);
    }
    if (b.plain !== undefined) {
      if (kind !== "syslog" || typeof b.plain !== "boolean") throw bad("plain is true or false, for syslog sources.");
      out.plain = b.plain;
    }
    if (b.processors !== undefined) {
      try {
        out.processors = checkProcessors(b.processors);
      } catch (err) {
        if (err instanceof PipelineError) throw bad(`processors: ${err.message}`);
        throw err;
      }
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") throw bad("enabled is true or false.");
      out.enabled = b.enabled;
    }
    return out;
  }

  const newToken = () => `olg_${randomBytes(32).toString("base64url")}`;

  /** A new source. An http source gets its ingest token, shown once. */
  function createSource(b: Record<string, unknown>) {
    if (b.kind !== "http" && b.kind !== "syslog" && b.kind !== "ssh") throw bad("kind is http, syslog or ssh.");
    const v = sourceInput(b, b.kind, false);
    if (db.prepare("SELECT 1 FROM sources WHERE name = ?").get(v.name!)) throw new LogsError(409, "conflict", `A source named ${v.name} exists.`);
    if (b.kind === "syslog" && !v.networks?.length)
      throw bad("networks: say which senders this syslog source takes, such as 10.0.0.0/8. Syslog carries no token.");
    const id = randomUUID();
    const token = b.kind === "http" ? newToken() : undefined;
    db.prepare("INSERT INTO sources (id, name, kind, token_hash, networks, plain, processors, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      v.name!,
      b.kind,
      token ? sha256(token) : null,
      JSON.stringify(v.networks ?? []),
      v.plain ? 1 : 0,
      JSON.stringify(v.processors ?? DEFAULT_PROCESSORS),
      v.enabled === false ? 0 : 1,
      iso(),
    );
    return { source: toSource(requireSource(id)), ...(token && { token }) };
  }

  function updateSource(id: string, b: Record<string, unknown>) {
    const s = requireSource(id);
    const v = sourceInput(b, s.kind, true);
    if (v.name && v.name !== s.name && db.prepare("SELECT 1 FROM sources WHERE name = ?").get(v.name))
      throw new LogsError(409, "conflict", `A source named ${v.name} exists.`);
    if (s.kind === "syslog" && v.networks && !v.networks.length) throw bad("networks: a syslog source needs at least one.");
    db.prepare("UPDATE sources SET name = ?, networks = ?, plain = ?, processors = ?, enabled = ? WHERE id = ?").run(
      v.name ?? s.name,
      JSON.stringify(v.networks ?? JSON.parse(s.networks)),
      v.plain === undefined ? s.plain : v.plain ? 1 : 0,
      JSON.stringify(v.processors ?? JSON.parse(s.processors)),
      v.enabled === undefined ? s.enabled : v.enabled ? 1 : 0,
      id,
    );
    return toSource(requireSource(id));
  }

  function rotateToken(id: string) {
    const s = requireSource(id);
    if (s.kind !== "http") throw new LogsError(409, "conflict", "Only http sources have a token.");
    const token = newToken();
    db.prepare("UPDATE sources SET token_hash = ? WHERE id = ?").run(sha256(token), id);
    return { source: toSource(requireSource(id)), token };
  }

  function deleteSource(id: string) {
    requireSource(id);
    if (db.prepare("SELECT 1 FROM hosts WHERE source_id = ?").get(id))
      throw new LogsError(409, "conflict", "Hosts send their logs through this source. Move or remove them first.");
    db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  }

  /**
   * The http source behind a token, from `Authorization: Bearer`, `Authorization: ApiKey` or basic auth with the
   * token as password, which is what Elasticsearch outputs send.
   */
  function sourceByToken(header: string | undefined): SourceRow {
    let token = "";
    if (header?.startsWith("Bearer ")) token = header.slice(7).trim();
    else if (header?.startsWith("ApiKey ")) token = header.slice(7).trim();
    else if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      token = decoded.slice(decoded.indexOf(":") + 1);
    }
    const s = token ? (db.prepare("SELECT * FROM sources WHERE token_hash = ? AND kind = 'http'").get(sha256(token)) as SourceRow | undefined) : undefined;
    if (!s) throw new LogsError(401, "invalid-token", "Unknown ingest token. Create a source under Sources and use its token.");
    if (!s.enabled) throw new LogsError(409, "conflict", `The source ${s.name} is switched off.`);
    return s;
  }

  /** Syslog sources, with their networks parsed once; the receivers ask this for every connection. */
  function syslogSources() {
    const rows = db.prepare("SELECT * FROM sources WHERE kind = 'syslog' AND enabled = 1 ORDER BY created_at").all() as unknown as SourceRow[];
    return rows.map((s) => ({ row: s, plain: s.plain === 1, networks: (JSON.parse(s.networks) as string[]).map(parseNetwork) }));
  }

  /** The syslog source that takes messages from this address over TLS (or plain, when `plain`). */
  function syslogSourceFor(addr: string, plain: boolean): SourceRow | undefined {
    return syslogSources().find((s) => (!plain || s.plain) && s.networks.some((n) => inNetwork(addr, n)))?.row;
  }

  const pipelines = new Map<string, { processors: string; run: ReturnType<typeof compile> }>();
  function pipelineOf(s: SourceRow) {
    const cached = pipelines.get(s.id);
    if (cached && cached.processors === s.processors) return cached.run;
    const run = compile(JSON.parse(s.processors) as Processor[]);
    pipelines.set(s.id, { processors: s.processors, run });
    return run;
  }

  /**
   * Runs a batch through the source's pipeline and stores it. `fields` are set after the pipeline and cannot be
   * changed by it: the source's name, and for hosts read over SSH the host's.
   */
  async function ingest(s: SourceRow, entries: Entry[], fields: Record<string, string> = {}) {
    const { kept, dropped } = pipelineOf(s)(entries);
    const stored = kept.map((e) => ({ ...e, fields: { ...e.fields, ...fields, source: s.name } }));
    try {
      await vlogs.insert(stored);
    } catch (err) {
      db.prepare("UPDATE sources SET last_error = ? WHERE id = ?").run((err as Error).message.slice(0, 500), s.id);
      return unavailable(err);
    }
    db.prepare("UPDATE sources SET lines_in = lines_in + ?, lines_dropped = lines_dropped + ?, last_seen_at = ?, last_error = NULL WHERE id = ?").run(
      stored.length,
      dropped,
      iso(),
      s.id,
    );
    return { accepted: stored.length, dropped };
  }

  /** What a pipeline makes of sample lines, without storing anything: for trying processors out. */
  function preview(b: Record<string, unknown>) {
    let processors: Processor[];
    try {
      processors = checkProcessors(b.processors);
    } catch (err) {
      if (err instanceof PipelineError) throw bad(`processors: ${err.message}`);
      throw err;
    }
    if (!Array.isArray(b.lines) || b.lines.length > 50 || b.lines.some((l) => typeof l !== "string" || l.length > MAX_MSG))
      throw bad("lines is a list of up to 50 sample lines.");
    const t = iso();
    const results = (b.lines as string[]).map((l) => {
      const { kept } = compile(processors)([{ time: t, msg: l, fields: {} }]);
      return kept[0] ? { kept: true, msg: kept[0].msg, fields: kept[0].fields } : { kept: false, msg: null, fields: {} };
    });
    return { results };
  }

  // ---- Agents -----------------------------------------------------------------------------------------------------

  const agentRow = (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  const requireAgent = (id: string) => {
    const a = agentRow(id);
    if (!a) throw new LogsError(404, "not-found", "No such agent.");
    return a;
  };

  function toAgent(a: AgentRow) {
    const online = !!a.last_seen_at && Date.parse(a.last_seen_at) + AGENT_OFFLINE_MS > now();
    return {
      id: a.id,
      name: a.name,
      status: !a.secret_hash ? "waiting-to-enrol" : online ? (a.version === opts.version ? "online" : "version-mismatch") : "offline",
      version: a.version,
      caFingerprint: a.ca_public_key ? fingerprint(a.ca_public_key) : null,
      lastSeenAt: a.last_seen_at,
      lastError: a.last_error,
      hosts: (db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE agent_id = ?").get(a.id) as { n: number }).n,
      createdAt: a.created_at,
    };
  }

  function newEnrollToken(id: string) {
    const token = `ole_${randomBytes(24).toString("base64url")}`;
    db.prepare("UPDATE agents SET enroll_token_hash = ?, enroll_expires_at = ? WHERE id = ?").run(sha256(token), iso(now() + ENROLL_TTL_MS), id);
    return { enrollToken: token, enrollExpiresAt: iso(now() + ENROLL_TTL_MS) };
  }

  function createAgent(b: Record<string, unknown>) {
    if (typeof b.name !== "string" || !NAME.test(b.name)) throw bad("name is letters, digits, dots, dashes and underscores, up to 63.");
    if (db.prepare("SELECT 1 FROM agents WHERE name = ?").get(b.name)) throw new LogsError(409, "conflict", `An agent named ${b.name} exists.`);
    const id = randomUUID();
    db.prepare("INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)").run(id, b.name, iso());
    return { agent: toAgent(requireAgent(id)), ...newEnrollToken(id) };
  }

  function reEnroll(id: string) {
    requireAgent(id);
    db.prepare("UPDATE agents SET secret_hash = NULL, ca_public_key = NULL WHERE id = ?").run(id);
    return { agent: toAgent(requireAgent(id)), ...newEnrollToken(id) };
  }

  function deleteAgent(id: string) {
    requireAgent(id);
    if (db.prepare("SELECT 1 FROM hosts WHERE agent_id = ?").get(id))
      throw new LogsError(409, "conflict", "Hosts are read by this agent. Move or remove them first.");
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  function agentSetup(id: string) {
    const a = requireAgent(id);
    if (!a.setup || !a.ca_public_key) throw new LogsError(409, "conflict", "The agent has not enrolled yet. Start it with its enrolment token.");
    return {
      agent: toAgent(a),
      caPublicKey: a.ca_public_key,
      caFingerprint: fingerprint(a.ca_public_key),
      keyPublicKey: a.key_public_key,
      ...(JSON.parse(a.setup) as Record<string, string>),
    };
  }

  function checkReport(b: Record<string, unknown>) {
    const isKey = (v: unknown) => typeof v === "string" && HOST_KEY.test(v.trim().split(/\s+/).slice(0, 2).join(" "));
    if (typeof b.version !== "string" || b.version.length > 32) throw bad("version is required.");
    if (!isKey(b.caPublicKey)) throw bad("caPublicKey is an OpenSSH public key.");
    if (!isKey(b.keyPublicKey)) throw bad("keyPublicKey is an OpenSSH public key.");
    const s = b.setup as Record<string, unknown> | undefined;
    if (!s || ["sshdConfig", "hostSetup", "authorizedKey"].some((k) => typeof s[k] !== "string" || (s[k] as string).length > 64_000))
      throw bad("setup holds sshdConfig, hostSetup and authorizedKey.");
    return {
      version: b.version,
      caPublicKey: (b.caPublicKey as string).trim(),
      keyPublicKey: (b.keyPublicKey as string).trim(),
      setup: JSON.stringify({ sshdConfig: s.sshdConfig, hostSetup: s.hostSetup, authorizedKey: s.authorizedKey }),
    };
  }

  function enroll(b: Record<string, unknown>) {
    const token = typeof b.token === "string" ? b.token : "";
    const a = db.prepare("SELECT * FROM agents WHERE enroll_token_hash = ?").get(sha256(token)) as AgentRow | undefined;
    if (!a || !a.enroll_expires_at || a.enroll_expires_at <= iso())
      throw new LogsError(401, "invalid-token", "The enrolment token is unknown, used or expired. Create a new one under Agents.");
    const r = checkReport(b);
    const secret = `ola_${randomBytes(32).toString("base64url")}`;
    db.prepare(
      "UPDATE agents SET enroll_token_hash = NULL, enroll_expires_at = NULL, secret_hash = ?, version = ?, ca_public_key = ?, key_public_key = ?, setup = ?, last_seen_at = ?, last_error = NULL WHERE id = ?",
    ).run(sha256(secret), r.version, r.caPublicKey, r.keyPublicKey, r.setup, iso(), a.id);
    log("info", "agent enrolled", { agent: a.name, version: r.version, ca: fingerprint(r.caPublicKey) });
    return { agentId: a.id, secret };
  }

  function agentBySecret(header: string | undefined): AgentRow {
    const secret = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const a = secret ? (db.prepare("SELECT * FROM agents WHERE secret_hash = ?").get(sha256(secret)) as AgentRow | undefined) : undefined;
    if (!a) throw new LogsError(401, "invalid-token", "Unknown agent secret. Enrol the agent again under Agents.");
    return a;
  }

  // ---- Hosts ------------------------------------------------------------------------------------------------------

  const hostRow = (id: string) => db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
  const requireHost = (id: string) => {
    const h = hostRow(id);
    if (!h) throw new LogsError(404, "not-found", "No such host.");
    return h;
  };
  const keyPinned = (h: HostRow) => JSON.parse(h.host_keys).length > 0 && h.status !== "host-key-changed" && h.status !== "host-key-pending";

  function work(a: AgentRow, b: Record<string, unknown>) {
    const r = checkReport(b);
    // ADR 0019: an agent always has the same version as its product.
    if (r.version !== opts.version) {
      db.prepare("UPDATE agents SET version = ?, last_seen_at = ?, last_error = ? WHERE id = ?").run(
        r.version,
        iso(),
        `logs-agent ${r.version} does not match logs ${opts.version}`,
        a.id,
      );
      throw new LogsError(409, "version-mismatch", `logs-agent ${r.version} does not match logs ${opts.version}; install logs-agent ${opts.version}`);
    }
    if (a.ca_public_key && a.ca_public_key !== r.caPublicKey)
      throw new LogsError(409, "conflict", "This agent's CA changed since it enrolled. Enrol it again under Agents.");
    db.prepare("UPDATE agents SET version = ?, key_public_key = ?, setup = ?, last_seen_at = ?, last_error = NULL WHERE id = ?").run(
      r.version,
      r.keyPublicKey,
      r.setup,
      iso(),
      a.id,
    );

    const t = now();
    const free = (h: HostRow) => !h.lease_until || Date.parse(h.lease_until) <= t;
    const hosts = (db.prepare("SELECT * FROM hosts WHERE agent_id = ?").all(a.id) as unknown as HostRow[]).filter(free);
    const keyJobs = hosts.filter((h) => h.key_requested === 1);
    const due = hosts.filter(
      (h) =>
        h.key_requested === 0 &&
        keyPinned(h) &&
        (h.read_requested === 1 || !h.last_attempt_at || Date.parse(h.last_attempt_at) + h.interval_seconds * 1000 <= t),
    );
    const jobs = [...keyJobs.map((h) => ({ h, action: "host-key" as const })), ...due.map((h) => ({ h, action: "read" as const }))].slice(0, 64);
    const leaseKey = db.prepare("UPDATE hosts SET lease_until = ? WHERE id = ?");
    const leaseRead = db.prepare("UPDATE hosts SET lease_until = ?, last_attempt_at = ?, read_requested = 0 WHERE id = ?");
    return {
      jobs: jobs.map(({ h, action }) => {
        if (action === "read") leaseRead.run(iso(t + JOB_LEASE_MS), iso(t), h.id);
        else leaseKey.run(iso(t + JOB_LEASE_MS), h.id);
        return {
          id: randomUUID(),
          hostId: h.id,
          action,
          target: {
            address: h.address,
            port: h.port,
            user: h.ssh_user,
            hostKeys: JSON.parse(h.host_keys) as string[],
            auth: h.auth,
            containers: h.containers === 1,
          },
          cursor: { journal: h.journal_cursor, docker: h.docker_since },
        };
      }),
    };
  }

  const FAILURES = new Set(["unreachable", "auth-failed", "host-key-changed", "host-key-unknown", "timeout", "error", "invalid-job"]);
  const MAX_LINES = 50_000;

  async function result(a: AgentRow, b: Record<string, unknown>) {
    const h = typeof b.hostId === "string" ? hostRow(b.hostId) : undefined;
    if (!h || h.agent_id !== a.id) throw new LogsError(404, "not-found", "No such host for this agent.");
    db.prepare("UPDATE hosts SET lease_until = NULL WHERE id = ?").run(h.id);
    const keys = b.hostKeys;
    const keyList =
      Array.isArray(keys) && keys.length > 0 && keys.length <= 8 && keys.every((k) => typeof k === "string" && HOST_KEY.test(k))
        ? (keys as string[])
        : undefined;
    if (b.ok === true && keyList && b.entries === undefined) {
      // The hosts file vouches for a key with its fingerprint (ADR 0052): that key is pinned without an admin.
      const vouched = h.file_host_key ? keyList.find((k) => fingerprint(k) === h.file_host_key) : undefined;
      if (vouched) {
        db.prepare(
          "UPDATE hosts SET key_requested = 0, host_keys = ?, pending_host_keys = '[]', status = 'pending', status_detail = NULL, read_requested = 1 WHERE id = ?",
        ).run(JSON.stringify([vouched]), h.id);
        log("info", "host key trusted from the hosts file", { host: h.name, fingerprint: h.file_host_key });
        return { status: "accepted" };
      }
      const pinned = JSON.parse(h.host_keys) as string[];
      const same = pinned.length > 0 && keyList.every((k) => pinned.includes(k));
      db.prepare("UPDATE hosts SET key_requested = 0, pending_host_keys = ?, status = ?, status_detail = ? WHERE id = ?").run(
        JSON.stringify(same ? [] : keyList),
        same ? (h.status === "host-key-changed" ? "pending" : h.status) : pinned.length ? "host-key-changed" : "host-key-pending",
        same
          ? h.status_detail
          : h.file_host_key
            ? `The host presents a key that is not ${h.file_host_key} from the hosts file. Check the host, then fix hostKey in the file.`
            : pinned.length
              ? "The host presents a different key. Check it on the host, then accept it."
              : "Check the fingerprint on the host, then accept it.",
        h.id,
      );
      return { status: "accepted" };
    }
    if (b.ok === true && b.entries !== undefined) {
      if (!keyPinned(h)) throw new LogsError(409, "conflict", "The host key is not accepted; lines are not stored.");
      const raw = b.entries;
      if (!Array.isArray(raw) || raw.length > MAX_LINES) throw bad(`entries is a list of up to ${MAX_LINES} lines.`);
      const t = iso();
      const entries: Entry[] = raw.map((e: { time?: unknown; msg?: unknown; fields?: unknown }) => {
        const fields: Record<string, string> = {};
        if (e.fields && typeof e.fields === "object")
          for (const [k, v] of Object.entries(e.fields as Record<string, unknown>)) if (typeof v === "string") fields[k] = v;
        return { time: toTime(e.time) ?? t, msg: typeof e.msg === "string" ? e.msg : "", fields };
      });
      const cursor = (b.cursor ?? {}) as { journal?: unknown; docker?: unknown };
      const journal = typeof cursor.journal === "string" && CURSOR.test(cursor.journal) ? cursor.journal : h.journal_cursor;
      const docker = typeof cursor.docker === "string" && toTime(cursor.docker) ? cursor.docker : h.docker_since;
      const unreadable = Array.isArray(b.unreadable) ? b.unreadable.filter((u): u is string => typeof u === "string").slice(0, 16) : [];
      const s = requireSource(h.source_id);
      // The host's name, not what the host calls itself: it is what the screens and Infrastructure link by.
      await ingest(s, entries, { host: h.name });
      db.prepare(
        "UPDATE hosts SET status = 'ok', status_detail = NULL, unreadable = ?, journal_cursor = ?, docker_since = ?, lines_in = lines_in + ?, last_success_at = ?, read_requested = ? WHERE id = ?",
      ).run(JSON.stringify(unreadable), journal, docker, entries.length, t, b.more === true ? 1 : 0, h.id);
      return { status: "accepted" };
    }
    const e = b.error as { kind?: unknown; message?: unknown } | undefined;
    if (b.ok !== false || !e || typeof e.kind !== "string" || !FAILURES.has(e.kind) || typeof e.message !== "string")
      throw bad("Expected entries, hostKeys, or an error with kind and message.");
    const message = e.message.slice(0, 1000);
    if (e.kind === "host-key-changed") {
      db.prepare("UPDATE hosts SET status = 'host-key-changed', status_detail = ?, pending_host_keys = ? WHERE id = ?").run(
        "The host key changed. Check the host, then accept the new key.",
        JSON.stringify(keyList ?? []),
        h.id,
      );
    } else {
      db.prepare("UPDATE hosts SET status = ?, status_detail = ? WHERE id = ?").run(e.kind === "host-key-unknown" ? "unreachable" : e.kind, message, h.id);
    }
    log("warn", "host read failed", { host: h.name, kind: e.kind, error: message });
    return { status: "accepted" };
  }

  function toHost(h: HostRow) {
    const agent = agentRow(h.agent_id)!;
    const source = sourceRow(h.source_id)!;
    return {
      id: h.id,
      name: h.name,
      agent: { id: agent.id, name: agent.name },
      source: { id: source.id, name: source.name },
      origin: h.origin,
      fileHostKey: h.file_host_key,
      address: h.address,
      port: h.port,
      user: h.ssh_user,
      auth: h.auth,
      containers: h.containers === 1,
      intervalSeconds: h.interval_seconds,
      hostKeys: (JSON.parse(h.host_keys) as string[]).map((k) => ({ type: k.split(" ")[0]!, fingerprint: fingerprint(k) })),
      pendingHostKeys: (JSON.parse(h.pending_host_keys) as string[]).map((k) => ({ type: k.split(" ")[0]!, fingerprint: fingerprint(k) })),
      status: h.status,
      statusDetail: h.status_detail,
      unreadable: JSON.parse(h.unreadable) as string[],
      linesIn: h.lines_in,
      lastAttemptAt: h.last_attempt_at,
      lastSuccessAt: h.last_success_at,
      createdAt: h.created_at,
    };
  }

  function hostInput(b: Record<string, unknown>, partial: boolean) {
    const out: Partial<{
      name: string;
      agentId: string;
      sourceId: string;
      address: string;
      port: number;
      user: string;
      auth: HostRow["auth"];
      containers: boolean;
      intervalSeconds: number;
    }> = {};
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== "string" || !NAME.test(b.name)) throw bad("name is letters, digits, dots, dashes and underscores, up to 63.");
      out.name = b.name;
    }
    if (b.agentId !== undefined) {
      if (typeof b.agentId !== "string" || !agentRow(b.agentId)) throw bad("agentId is the id of an agent.");
      out.agentId = b.agentId;
    }
    if (b.sourceId !== undefined) {
      const s = typeof b.sourceId === "string" ? sourceRow(b.sourceId) : undefined;
      if (!s || s.kind !== "ssh") throw bad("sourceId is the id of an ssh source.");
      out.sourceId = s.id;
    }
    if (b.address !== undefined || !partial) {
      if (typeof b.address !== "string" || !ADDRESS.test(b.address)) throw bad("address is a host name or IP address.");
      out.address = b.address;
    }
    if (b.port !== undefined) {
      if (typeof b.port !== "number" || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) throw bad("port is 1 to 65535.");
      out.port = b.port;
    }
    if (b.user !== undefined) {
      if (typeof b.user !== "string" || !USER.test(b.user)) throw bad("user is a Unix account name.");
      out.user = b.user;
    }
    if (b.auth !== undefined) {
      if (b.auth !== "certificate" && b.auth !== "key") throw bad("auth is certificate or key.");
      out.auth = b.auth;
    }
    if (b.containers !== undefined) {
      if (typeof b.containers !== "boolean") throw bad("containers is true or false.");
      out.containers = b.containers;
    }
    if (b.intervalSeconds !== undefined) {
      if (typeof b.intervalSeconds !== "number" || !Number.isInteger(b.intervalSeconds) || b.intervalSeconds < 15 || b.intervalSeconds > 3600)
        throw bad("intervalSeconds is 15 to 3600.");
      out.intervalSeconds = b.intervalSeconds;
    }
    return out;
  }

  /** The ssh source new hosts go through when none is named: the only one, or one made for them. */
  function defaultSshSource(): string {
    const rows = db.prepare("SELECT id FROM sources WHERE kind = 'ssh'").all() as Array<{ id: string }>;
    if (rows.length === 1) return rows[0]!.id;
    if (rows.length > 1) throw bad("sourceId: choose the ssh source this host's logs go through.");
    return createSource({ kind: "ssh", name: "hosts" }).source.id;
  }

  function createHost(b: Record<string, unknown>) {
    const v = hostInput(b, false);
    let agentId = v.agentId;
    if (!agentId) {
      const agents = db.prepare("SELECT id FROM agents").all() as Array<{ id: string }>;
      if (agents.length !== 1) throw bad(agents.length ? "agentId: choose the agent that reads this host." : "Add an agent first, under Agents.");
      agentId = agents[0]!.id;
    }
    if (db.prepare("SELECT 1 FROM hosts WHERE name = ?").get(v.name!)) throw new LogsError(409, "conflict", `A host named ${v.name} exists.`);
    const sourceId = v.sourceId ?? defaultSshSource();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO hosts (id, name, agent_id, source_id, address, port, ssh_user, auth, containers, interval_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      v.name!,
      agentId,
      sourceId,
      v.address!,
      v.port ?? 22,
      v.user ?? "openasy",
      v.auth ?? "certificate",
      v.containers ? 1 : 0,
      v.intervalSeconds ?? 60,
      iso(),
    );
    return toHost(requireHost(id));
  }

  function updateHost(id: string, b: Record<string, unknown>) {
    const h = fromFile(requireHost(id), "Change it there.");
    const v = hostInput(b, true);
    if (v.name && v.name !== h.name && db.prepare("SELECT 1 FROM hosts WHERE name = ?").get(v.name))
      throw new LogsError(409, "conflict", `A host named ${v.name} exists.`);
    const agentId = v.agentId ?? h.agent_id;
    const moved = (v.address !== undefined && v.address !== h.address) || (v.port !== undefined && v.port !== h.port) || agentId !== h.agent_id;
    db.prepare(
      "UPDATE hosts SET name = ?, agent_id = ?, source_id = ?, address = ?, port = ?, ssh_user = ?, auth = ?, containers = ?, interval_seconds = ? WHERE id = ?",
    ).run(
      v.name ?? h.name,
      agentId,
      v.sourceId ?? h.source_id,
      v.address ?? h.address,
      v.port ?? h.port,
      v.user ?? h.ssh_user,
      v.auth ?? h.auth,
      v.containers === undefined ? h.containers : v.containers ? 1 : 0,
      v.intervalSeconds ?? h.interval_seconds,
      id,
    );
    // A new address, or another agent, is a new trust decision: the key must be checked again.
    if (moved)
      db.prepare(
        "UPDATE hosts SET host_keys = '[]', pending_host_keys = '[]', status = 'new', status_detail = NULL, key_requested = 1, lease_until = NULL WHERE id = ?",
      ).run(id);
    return toHost(requireHost(id));
  }

  function requestHostKey(id: string) {
    requireHost(id);
    db.prepare("UPDATE hosts SET key_requested = 1, lease_until = NULL WHERE id = ?").run(id);
    return toHost(requireHost(id));
  }

  function acceptHostKey(id: string, fp: unknown) {
    const h = requireHost(id);
    if (h.file_host_key) fromFile(h, "Its key is the one hostKey names there; change hostKey to trust another.");
    const key = (JSON.parse(h.pending_host_keys) as string[]).find((k) => fingerprint(k) === fp);
    if (typeof fp !== "string" || !key) throw bad("fingerprint must be one of the pending host keys, as SHA256:...");
    db.prepare(
      "UPDATE hosts SET host_keys = ?, pending_host_keys = '[]', status = 'pending', status_detail = NULL, read_requested = 1, lease_until = NULL WHERE id = ?",
    ).run(JSON.stringify([key]), id);
    return toHost(requireHost(id));
  }

  function requestRead(id: string) {
    const h = requireHost(id);
    if (!keyPinned(h)) throw new LogsError(409, "conflict", "Accept the host key first.");
    db.prepare("UPDATE hosts SET read_requested = 1 WHERE id = ?").run(id);
  }

  const fromFile = (h: HostRow, what: string) => {
    if (h.origin === "file") throw new LogsError(409, "conflict", `This host comes from the hosts file (OPENASY_HOSTS). ${what}`);
    return h;
  };

  /**
   * Makes the hosts from the hosts file match it (ADR 0052): adds, changes and removes them, and leaves hosts added
   * here alone. Logs reaches hosts directly, so one behind a jump host is left out with a warning. An entry that
   * cannot be added yet, such as one whose agent is not enrolled, is a warning, and a host it made before is kept. A
   * new address, port or agent, or another hostKey than the pinned key, is a new trust decision. Returns what to fix.
   */
  function syncFile(entries: HostEntry[]): string[] {
    const warnings: string[] = [];
    const agents = db.prepare("SELECT id, name FROM agents").all() as Array<{ id: string; name: string }>;
    for (const e of entries) {
      if (e.jump) {
        warnings.push(`${e.name}: Logs reaches hosts directly, not through a jump host like ${e.jump}; it is left out.`);
        continue;
      }
      let agentId: string | undefined;
      if (e.agent) {
        agentId = agents.find((x) => x.name === e.agent)?.id;
        if (!agentId) warnings.push(`${e.name}: no agent is named ${e.agent}; it is added once one is.`);
      } else if (agents.length === 1) agentId = agents[0]!.id;
      else
        warnings.push(
          agents.length
            ? `${e.name}: name the agent that reaches it with agent:, as there are ${agents.length}.`
            : `${e.name}: it is added once an agent is, under Agents.`,
        );
      if (!agentId) continue;
      const h = db.prepare("SELECT * FROM hosts WHERE name = ?").get(e.name) as HostRow | undefined;
      if (h?.origin === "ui") {
        warnings.push(`${e.name}: a host with this name was added in Logs; remove it there to let the file manage it.`);
        continue;
      }
      if (!h) {
        db.prepare(
          "INSERT INTO hosts (id, name, agent_id, source_id, address, port, ssh_user, auth, containers, interval_seconds, created_at, origin, file_host_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 60, ?, 'file', ?)",
        ).run(randomUUID(), e.name, agentId, defaultSshSource(), e.address, e.port, e.user, e.auth, e.containers ? 1 : 0, iso(), e.hostKey);
        continue;
      }
      const pinned = JSON.parse(h.host_keys) as string[];
      const moved = e.address !== h.address || e.port !== h.port || agentId !== h.agent_id;
      const vouchesOther = !!e.hostKey && e.hostKey !== h.file_host_key && pinned.length > 0 && !pinned.some((k) => fingerprint(k) === e.hostKey);
      db.prepare("UPDATE hosts SET agent_id = ?, address = ?, port = ?, ssh_user = ?, auth = ?, containers = ?, file_host_key = ? WHERE id = ?").run(
        agentId,
        e.address,
        e.port,
        e.user,
        e.auth,
        e.containers ? 1 : 0,
        e.hostKey,
        h.id,
      );
      if (moved || vouchesOther)
        db.prepare(
          "UPDATE hosts SET host_keys = '[]', pending_host_keys = '[]', status = 'new', status_detail = NULL, key_requested = 1, lease_until = NULL WHERE id = ?",
        ).run(h.id);
      // A hostKey given now for a host whose key is not pinned yet: ask for the key again, to trust it if it matches.
      else if (e.hostKey && e.hostKey !== h.file_host_key && !pinned.length)
        db.prepare("UPDATE hosts SET key_requested = 1, lease_until = NULL WHERE id = ?").run(h.id);
    }
    // Hosts that left the file go; lines already stored stay until retention removes them.
    const named = new Set(entries.filter((e) => !e.jump).map((e) => e.name));
    for (const h of db.prepare("SELECT id, name FROM hosts WHERE origin = 'file'").all() as Array<{ id: string; name: string }>) {
      if (!named.has(h.name)) db.prepare("DELETE FROM hosts WHERE id = ?").run(h.id);
    }
    return warnings;
  }

  function deleteHost(id: string) {
    fromFile(requireHost(id), "Remove it there.");
    // Lines already stored stay until retention removes them, like any other logs.
    db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }

  // ---- Search -----------------------------------------------------------------------------------------------------

  function checkQuery(q: unknown): string {
    const s = typeof q === "string" && q.trim() ? q.trim() : "*";
    if (s.length > MAX_QUERY) throw new LogsError(422, "invalid-query", `A query is up to ${MAX_QUERY} characters.`);
    return s;
  }

  function checkRange(start: string | undefined, end: string | undefined) {
    const e = end ? Date.parse(end) : now();
    const s = start ? Date.parse(start) : e - 15 * 60_000;
    if (Number.isNaN(s) || Number.isNaN(e)) throw bad("start and end are dates and times, such as 2026-10-20T10:00:00Z.");
    if (s >= e) throw bad("start is before end.");
    return { start: iso(s), end: iso(e), ms: e - s };
  }

  const audit = db.prepare("INSERT INTO searches (at, actor, kind, query) VALUES (?, ?, ?, ?)");
  const record = (actor: Actor, kind: string, q: string) => audit.run(iso(), `${actor.name} (${actor.id})`, kind, q);

  async function search(actor: Actor, p: { query?: string; start?: string; end?: string; limit?: number }) {
    const q = checkQuery(p.query);
    const r = checkRange(p.start, p.end);
    record(actor, "search", q);
    const limit = p.limit ?? 200;
    const lines = await vlogs.query(q, r, limit).catch(unavailable);
    return { lines, start: r.start, end: r.end, truncated: lines.length >= limit };
  }

  async function volume(p: { query?: string; start?: string; end?: string }) {
    const q = checkQuery(p.query);
    const r = checkRange(p.start, p.end);
    const step = stepFor(r.ms);
    const res = await vlogs.hits(q, r, step, "level").catch(unavailable);
    const times = [...new Set(res.hits.flatMap((h) => h.timestamps))].sort();
    const series = res.hits.map((h) => {
      const at = new Map(h.timestamps.map((t, i) => [t, h.values[i] ?? 0]));
      return { level: h.fields.level || "none", values: times.map((t) => at.get(t) ?? 0), total: h.total };
    });
    return { step, times, series };
  }

  const FACET_ORDER = ["level", "service", "host", "source"];
  const HIDDEN = new Set(["_msg", "_time", "_stream", "_stream_id"]);
  async function facets(p: { query?: string; start?: string; end?: string }) {
    const q = checkQuery(p.query);
    const r = checkRange(p.start, p.end);
    const res = await vlogs.facets(q, r, 10).catch(unavailable);
    const fields = res.facets
      .filter((f) => !HIDDEN.has(f.field_name))
      .map((f) => ({ field: f.field_name, values: f.values.map((v) => ({ value: v.field_value, hits: v.hits })) }))
      .sort((a, b) => {
        const ia = FACET_ORDER.indexOf(a.field);
        const ib = FACET_ORDER.indexOf(b.field);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.field.localeCompare(b.field);
      });
    return { fields };
  }

  /** New lines as they arrive. A bad query is refused here, before the stream starts. */
  async function tail(actor: Actor, query: unknown, signal: AbortSignal): Promise<AsyncGenerator<Line>> {
    const q = checkQuery(query);
    await vlogs.query(q, { start: iso(now() - 1000), end: iso() }, 1).catch(unavailable);
    record(actor, "tail", q);
    return vlogs.tail(q, signal);
  }

  function searches(p: { limit: number; cursor?: number }) {
    const rows = db
      .prepare(`SELECT * FROM searches ${p.cursor ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`)
      .all(...(p.cursor ? [p.cursor, p.limit + 1] : [p.limit + 1])) as Array<{ id: number; at: string; actor: string; kind: string; query: string }>;
    const page = rows.slice(0, p.limit);
    return { searches: page, ...(rows.length > p.limit && { nextCursor: String(page.at(-1)!.id) }) };
  }

  // ---- Saved views and thresholds ---------------------------------------------------------------------------------

  const viewRow = (id: string) => db.prepare("SELECT * FROM views WHERE id = ?").get(id) as ViewRow | undefined;
  /** Shared views are seen by everyone; private ones only by their owner. */
  const requireView = (id: string, actor: Actor) => {
    const v = viewRow(id);
    if (!v || (!v.shared && v.owner_id !== actor.id)) throw new LogsError(404, "not-found", "No such view.");
    return v;
  };

  function toView(v: ViewRow) {
    return {
      id: v.id,
      name: v.name,
      query: v.query,
      owner: { id: v.owner_id, name: v.owner_name },
      shared: v.shared === 1,
      alert:
        v.alert_threshold === null
          ? null
          : {
              threshold: v.alert_threshold,
              windowMinutes: v.alert_window_minutes!,
              webhookUrl: v.alert_webhook_url!,
              state: v.alert_state,
              lastCount: v.alert_last_count,
              lastCheckedAt: v.alert_last_checked_at,
              lastFiredAt: v.alert_last_fired_at,
              lastError: v.alert_last_error,
            },
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    };
  }

  function viewInput(b: Record<string, unknown>, partial: boolean) {
    const out: Partial<{ name: string; query: string; shared: boolean; alert: { threshold: number; windowMinutes: number; webhookUrl: string } | null }> = {};
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== "string" || !VIEW_NAME.test(b.name)) throw bad("name is up to 80 characters.");
      out.name = b.name;
    }
    if (b.query !== undefined || !partial) {
      if (typeof b.query !== "string" || !b.query.trim()) throw bad("query is a LogsQL query.");
      out.query = checkQuery(b.query);
    }
    if (b.shared !== undefined) {
      if (typeof b.shared !== "boolean") throw bad("shared is true or false.");
      out.shared = b.shared;
    }
    if (b.alert !== undefined) {
      if (b.alert === null) out.alert = null;
      else {
        const a = b.alert as Record<string, unknown>;
        if (!a || typeof a !== "object") throw bad("alert is null or an object with threshold, windowMinutes and webhookUrl.");
        if (typeof a.threshold !== "number" || !Number.isInteger(a.threshold) || a.threshold < 0)
          throw bad("alert.threshold is a whole number: the alert fires when more lines than this match.");
        if (typeof a.windowMinutes !== "number" || !Number.isInteger(a.windowMinutes) || a.windowMinutes < 1 || a.windowMinutes > 1440)
          throw bad("alert.windowMinutes is 1 to 1440.");
        out.alert = { threshold: a.threshold, windowMinutes: a.windowMinutes, webhookUrl: checkWebhookUrl(a.webhookUrl) };
      }
    }
    return out;
  }

  /** A new view. With a threshold, the webhook's signing secret is returned once. */
  function createView(actor: Actor, b: Record<string, unknown>) {
    const v = viewInput(b, false);
    const id = randomUUID();
    const secret = v.alert ? `whsec_${randomBytes(24).toString("base64")}` : undefined;
    db.prepare(
      "INSERT INTO views (id, name, query, owner_id, owner_name, shared, alert_threshold, alert_window_minutes, alert_webhook_url, alert_secret_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      v.name!,
      v.query!,
      actor.id,
      actor.name,
      v.shared === false ? 0 : 1,
      v.alert?.threshold ?? null,
      v.alert?.windowMinutes ?? null,
      v.alert?.webhookUrl ?? null,
      secret ? keyring.seal(secret) : null,
      iso(),
      iso(),
    );
    return { view: toView(viewRow(id)!), ...(secret && { webhookSecret: secret }) };
  }

  /** Only the owner changes a view; admins may change any. */
  function updateView(actor: Actor, isAdmin: boolean, id: string, b: Record<string, unknown>) {
    const cur = requireView(id, actor);
    if (cur.owner_id !== actor.id && !isAdmin) throw new LogsError(409, "conflict", "Only its owner or an admin changes a view.");
    const v = viewInput(b, true);
    let secret: string | undefined;
    if (v.alert && cur.alert_threshold === null) secret = `whsec_${randomBytes(24).toString("base64")}`;
    const alert = v.alert === undefined ? undefined : v.alert;
    db.prepare(
      "UPDATE views SET name = ?, query = ?, shared = ?, alert_threshold = ?, alert_window_minutes = ?, alert_webhook_url = ?, alert_secret_sealed = ?, alert_state = ?, updated_at = ? WHERE id = ?",
    ).run(
      v.name ?? cur.name,
      v.query ?? cur.query,
      v.shared === undefined ? cur.shared : v.shared ? 1 : 0,
      alert === undefined ? cur.alert_threshold : (alert?.threshold ?? null),
      alert === undefined ? cur.alert_window_minutes : (alert?.windowMinutes ?? null),
      alert === undefined ? cur.alert_webhook_url : (alert?.webhookUrl ?? null),
      alert === null ? null : secret ? keyring.seal(secret) : cur.alert_secret_sealed,
      alert === null ? "ok" : cur.alert_state,
      iso(),
      id,
    );
    return { view: toView(viewRow(id)!), ...(secret && { webhookSecret: secret }) };
  }

  function deleteView(actor: Actor, isAdmin: boolean, id: string) {
    const cur = requireView(id, actor);
    if (cur.owner_id !== actor.id && !isAdmin) throw new LogsError(409, "conflict", "Only its owner or an admin removes a view.");
    db.prepare("DELETE FROM views WHERE id = ?").run(id);
  }

  function listViews(actor: Actor) {
    return (db.prepare("SELECT * FROM views WHERE shared = 1 OR owner_id = ? ORDER BY name").all(actor.id) as unknown as ViewRow[]).map(toView);
  }

  /** Signs like Standard Webhooks: HMAC-SHA256 over "id.timestamp.body", with the view's secret. */
  function sign(secret: string, id: string, timestamp: number, body: string) {
    const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
    return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  }

  async function deliver(v: ViewRow, event: "fired" | "resolved", count: number) {
    const id = `msg_${randomUUID()}`;
    const ts = Math.floor(now() / 1000);
    const body = JSON.stringify({
      type: `logs.view.${event}`,
      view: { id: v.id, name: v.name, query: v.query },
      count,
      threshold: v.alert_threshold,
      windowMinutes: v.alert_window_minutes,
      at: iso(),
      ...(opts.publicUrl && { url: `${opts.publicUrl}/explorer?view=${v.id}` }),
    });
    const secret = keyring.open(v.alert_secret_sealed!).toString("utf8");
    const res = await post(v.alert_webhook_url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(secret, id, ts, body),
        "user-agent": `openasy-logs/${opts.version}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
  }

  /** Checks every view with a threshold: one count per view over its window, then a webhook when its state flips. */
  async function checkAlerts() {
    const rows = db.prepare("SELECT * FROM views WHERE alert_threshold IS NOT NULL").all() as unknown as ViewRow[];
    for (const v of rows) {
      const end = now();
      let count: number;
      try {
        const res = await vlogs.stats(`${v.query} | stats count() n`, { start: iso(end - v.alert_window_minutes! * 60_000), end: iso(end) });
        count = Number(res[0]?.n ?? 0);
      } catch (err) {
        db.prepare("UPDATE views SET alert_state = 'error', alert_last_error = ?, alert_last_checked_at = ? WHERE id = ?").run(
          (err as Error).message.slice(0, 500),
          iso(),
          v.id,
        );
        continue;
      }
      const firing = count > v.alert_threshold!;
      const was = v.alert_state === "firing";
      let error: string | null = null;
      if (firing !== was) {
        try {
          await deliver(v, firing ? "fired" : "resolved", count);
          log("info", firing ? "view threshold crossed" : "view back under its threshold", { view: v.name, count, threshold: v.alert_threshold });
        } catch (err) {
          error = `Could not call the webhook: ${(err as Error).message}`;
          log("warn", "webhook failed", { view: v.name, error });
        }
      }
      // A failed delivery is tried again at the next check: the state only moves once the webhook took it.
      const state = error ? v.alert_state : firing ? "firing" : "ok";
      db.prepare(
        "UPDATE views SET alert_state = ?, alert_last_count = ?, alert_last_checked_at = ?, alert_last_error = ?, alert_last_fired_at = ? WHERE id = ?",
      ).run(state === "error" ? "ok" : state, count, iso(), error, firing && !was && !error ? iso() : v.alert_last_fired_at, v.id);
    }
  }

  // ---- Overview ---------------------------------------------------------------------------------------------------

  async function summary() {
    const count = (sql: string) =>
      Object.fromEntries((db.prepare(sql).all() as Array<{ k: string; n: number }>).map((r) => [r.k, r.n])) as Record<string, number>;
    const agents = (db.prepare("SELECT * FROM agents").all() as unknown as AgentRow[]).map(toAgent);
    let lastHour: number | null = null;
    let usage: { bytes: number; rows: number } | null = null;
    try {
      lastHour = Number((await vlogs.stats("* | stats count() n", { start: iso(now() - 3_600_000), end: iso() }))[0]?.n ?? 0);
      usage = await vlogs.usage();
    } catch {
      // VictoriaLogs is down: /readyz says so; the counts from SQLite are still shown.
    }
    return {
      sources: count("SELECT kind AS k, COUNT(*) AS n FROM sources GROUP BY kind"),
      agents: Object.fromEntries([...new Set(agents.map((a) => a.status))].map((s) => [s, agents.filter((a) => a.status === s).length])) as Record<
        string,
        number
      >,
      hosts: count("SELECT status AS k, COUNT(*) AS n FROM hosts GROUP BY status"),
      linesLastHour: lastHour,
      storedBytes: usage?.bytes ?? null,
      ...settings(),
      alertsFiring: (db.prepare("SELECT COUNT(*) AS n FROM views WHERE alert_state = 'firing'").get() as { n: number }).n,
    };
  }

  /** Drops recorded searches older than the audit period. The logs themselves expire in VictoriaLogs. */
  function purge() {
    db.prepare("DELETE FROM searches WHERE at < ?").run(iso(now() - AUDIT_DAYS * 86_400_000));
  }

  return {
    settings,
    updateSettings,
    listSources: () => (db.prepare("SELECT * FROM sources ORDER BY name").all() as unknown as SourceRow[]).map(toSource),
    source: (id: string) => toSource(requireSource(id)),
    createSource,
    updateSource,
    rotateToken,
    deleteSource,
    sourceByToken,
    syslogSources,
    syslogSourceFor,
    ingest,
    preview,
    listAgents: () => (db.prepare("SELECT * FROM agents ORDER BY name").all() as unknown as AgentRow[]).map(toAgent),
    agent: (id: string) => toAgent(requireAgent(id)),
    createAgent,
    reEnroll,
    deleteAgent,
    agentSetup,
    enroll,
    agentBySecret,
    work,
    result,
    listHosts: () => (db.prepare("SELECT * FROM hosts ORDER BY name").all() as unknown as HostRow[]).map(toHost),
    host: (id: string) => toHost(requireHost(id)),
    createHost,
    syncFile,
    updateHost,
    deleteHost,
    requestHostKey,
    acceptHostKey,
    requestRead,
    search,
    volume,
    facets,
    tail,
    searches,
    listViews,
    view: (actor: Actor, id: string) => toView(requireView(id, actor)),
    createView,
    updateView,
    deleteView,
    checkAlerts,
    summary,
    purge,
  };
}

export type Logs = ReturnType<typeof createLogs>;
