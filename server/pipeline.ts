// One log line on its way to storage, and the processors that turn raw lines into fields (ADR 0035). Pipelines run
// before storage, so what is stored is what was meant to be kept: masked values never reach the disk.

/** level, host, service and source are fields like any other, but the screens facet on them. */
export interface Entry {
  /** ISO 8601. */
  time: string;
  msg: string;
  fields: Record<string, string>;
}

export const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type Level = (typeof LEVELS)[number];

export type Processor =
  | { type: "parse-json" }
  | { type: "parse-regex"; pattern: string }
  | { type: "map-level"; field?: string }
  | { type: "mask"; pattern: string; replacement?: string }
  | { type: "mask-secrets" }
  | { type: "drop"; field: string; pattern: string }
  | { type: "sample"; field: string; pattern: string; percent: number }
  | { type: "set"; field: string; value: string };

export const PROCESSOR_TYPES = ["parse-json", "parse-regex", "map-level", "mask", "mask-secrets", "drop", "sample", "set"] as const;

/** Field names VictoriaLogs and LogsQL take without quoting. `_` names are VictoriaLogs' own. */
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MAX_FIELDS = 64;
const MAX_VALUE = 8 * 1024;
export const MAX_MSG = 64 * 1024;
const MAX_PATTERN = 512;

export class PipelineError extends Error {}

/** Checks a regular expression and returns it as written. */
function regex(pattern: unknown, what: string): string {
  if (typeof pattern !== "string" || !pattern || pattern.length > MAX_PATTERN)
    throw new PipelineError(`${what}: pattern is a regular expression of up to ${MAX_PATTERN} characters.`);
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new PipelineError(`${what}: ${(err as Error).message}`);
  }
  return pattern;
}

function field(name: unknown, what: string): string {
  if (typeof name !== "string" || !FIELD.test(name))
    throw new PipelineError(`${what}: field is a name such as service or http.status, starting with a letter.`);
  return name;
}

/** Checks processors sent by an admin. Throws PipelineError with what is wrong. */
export function checkProcessors(raw: unknown): Processor[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new PipelineError("processors is a list of up to 32 steps.");
  return raw.map((p: unknown, i): Processor => {
    const what = `step ${i + 1}`;
    const o = p as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new PipelineError(`${what}: expected an object with a type.`);
    switch (o.type) {
      case "parse-json":
      case "mask-secrets":
        return { type: o.type };
      case "parse-regex": {
        const pattern = regex(o.pattern, what);
        if (!/\(\?<[A-Za-z]/.test(pattern)) throw new PipelineError(`${what}: name the parts to keep, such as (?<status>\\d{3}).`);
        return { type: "parse-regex", pattern };
      }
      case "map-level":
        return { type: "map-level", ...(o.field !== undefined && { field: field(o.field, what) }) };
      case "mask": {
        const pattern = regex(o.pattern, what);
        if (o.replacement !== undefined && (typeof o.replacement !== "string" || o.replacement.length > 64))
          throw new PipelineError(`${what}: replacement is up to 64 characters.`);
        return { type: "mask", pattern, ...(o.replacement !== undefined && { replacement: o.replacement as string }) };
      }
      case "drop":
        return { type: "drop", field: field(o.field, what), pattern: regex(o.pattern, what) };
      case "sample": {
        if (typeof o.percent !== "number" || !Number.isInteger(o.percent) || o.percent < 1 || o.percent > 99)
          throw new PipelineError(`${what}: percent is 1 to 99, the share of matching lines to keep.`);
        return { type: "sample", field: field(o.field, what), pattern: regex(o.pattern, what), percent: o.percent };
      }
      case "set":
        if (typeof o.value !== "string" || o.value.length > 256) throw new PipelineError(`${what}: value is up to 256 characters.`);
        return { type: "set", field: field(o.field, what), value: o.value };
      default:
        throw new PipelineError(`${what}: type is one of ${PROCESSOR_TYPES.join(", ")}.`);
    }
  });
}

/** Syslog severities 0 to 7, and the words programs use. */
const LEVEL_WORDS: Record<string, Level> = {
  emerg: "fatal",
  emergency: "fatal",
  panic: "fatal",
  alert: "fatal",
  crit: "fatal",
  critical: "fatal",
  fatal: "fatal",
  err: "error",
  error: "error",
  eror: "error",
  e: "error",
  warn: "warn",
  warning: "warn",
  w: "warn",
  notice: "info",
  info: "info",
  information: "info",
  informational: "info",
  i: "info",
  debug: "debug",
  dbug: "debug",
  d: "debug",
  trace: "trace",
  trce: "trace",
  t: "trace",
  verbose: "trace",
};
const SYSLOG_LEVELS: Level[] = ["fatal", "fatal", "fatal", "error", "warn", "info", "info", "debug"];

/** A level from a word, a syslog severity (0 to 7) or an OpenTelemetry severity number (1 to 24). */
export function toLevel(v: string): Level | undefined {
  const s = v.trim().toLowerCase();
  if (LEVEL_WORDS[s]) return LEVEL_WORDS[s];
  if (/^[0-7]$/.test(s)) return SYSLOG_LEVELS[Number(s)];
  return undefined;
}

export function otelLevel(n: number): Level | undefined {
  if (n >= 21) return "fatal";
  if (n >= 17) return "error";
  if (n >= 13) return "warn";
  if (n >= 9) return "info";
  if (n >= 5) return "debug";
  if (n >= 1) return "trace";
  return undefined;
}

/**
 * Values that look like passwords, tokens or keys, masked wherever they appear. The same patterns run in logs-agent
 * before lines leave the host's network (ADR 0031); here they cover what is sent.
 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key masked]"],
  [/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token|apikey)?\s*[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2$3 ***"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]{3,}/gi, "$1$2***"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1****************"],
  [/\b(gh[pousr]_)[A-Za-z0-9]{30,}\b/g, "$1***"],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, "$1***"],
  [/\b(sk_live_|rk_live_)[A-Za-z0-9]{10,}/g, "$1***"],
  [/(:\/\/[^:/\s@]+:)[^@/\s]{1,}@/g, "$1***@"],
];

export function maskSecrets(s: string): string {
  let out = s;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Nested objects become dotted names: {"http": {"status": 500}} is http.status=500. */
export function flatten(obj: Record<string, unknown>, into: Record<string, string> = {}, prefix = ""): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, into, name);
    else into[name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return into;
}

const MSG_KEYS = ["_msg", "msg", "message", "log", "MESSAGE"];
const TIME_KEYS = ["_time", "@timestamp", "timestamp", "time", "ts"];
const LEVEL_KEYS = ["level", "severity", "lvl", "log.level", "loglevel", "PRIORITY"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 21/Oct/2026:09:58:00 +0000, as nginx and Apache write it. */
const CLF = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** A time from ISO 8601, the access log format, Unix seconds, milliseconds or nanoseconds; undefined otherwise. */
export function toTime(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e17 ? v / 1e6 : v > 1e14 ? v / 1e3 : v > 1e11 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string" && v) {
    if (/^\d+(\.\d+)?$/.test(v)) return toTime(Number(v));
    const clf = CLF.exec(v);
    if (clf && MONTHS.includes(clf[2]!)) {
      const [, d, mon, y, hh, mm, ss, sign, oh, om] = clf;
      const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
      return new Date(Date.UTC(Number(y), MONTHS.indexOf(mon!), Number(d), Number(hh), Number(mm), Number(ss)) - offset).toISOString();
    }
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

/**
 * An entry from a JSON object as shippers send it: the message, time and level under their usual names, the rest as
 * fields. Used by every receiver and by parse-json.
 */
export function fromObject(obj: Record<string, unknown>, fallbackTime: string): Entry {
  const rest: Record<string, unknown> = { ...obj };
  const take = (keys: string[]) => {
    for (const k of keys) {
      if (rest[k] !== undefined && rest[k] !== null && (typeof rest[k] !== "object" || Array.isArray(rest[k]))) {
        const v = rest[k];
        delete rest[k];
        return v;
      }
    }
    return undefined;
  };
  const msg = take(MSG_KEYS);
  const time = toTime(take(TIME_KEYS)) ?? fallbackTime;
  const level = take(LEVEL_KEYS);
  const fields = flatten(rest);
  if (level !== undefined) fields.level = String(level);
  return { time, msg: msg === undefined ? "" : typeof msg === "string" ? msg : JSON.stringify(msg), fields };
}

/** What a pipeline did with a batch. */
export interface Outcome {
  kept: Entry[];
  dropped: number;
}

function valueOf(e: Entry, name: string): string | undefined {
  return name === "_msg" || name === "msg" ? e.msg : e.fields[name];
}

/** A pipeline compiled once per batch: regular expressions are built once, not per line. */
export function compile(processors: Processor[], random: () => number = Math.random) {
  const steps = processors.map((p) => {
    switch (p.type) {
      case "parse-json":
        return (e: Entry): Entry | null => {
          const s = e.msg.trimStart();
          if (!s.startsWith("{")) return e;
          try {
            const parsed = JSON.parse(s) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return e;
            const inner = fromObject(parsed as Record<string, unknown>, e.time);
            return { time: inner.time, msg: inner.msg || e.msg, fields: { ...e.fields, ...inner.fields } };
          } catch {
            return e;
          }
        };
      case "parse-regex": {
        const re = new RegExp(p.pattern);
        return (e: Entry): Entry | null => {
          const m = re.exec(e.msg);
          if (!m?.groups) return e;
          const fields = { ...e.fields };
          let msg = e.msg;
          let time = e.time;
          for (const [k, v] of Object.entries(m.groups)) {
            if (v === undefined || v === "") continue;
            if (k === "msg") msg = v;
            else if (k === "time") time = toTime(v) ?? time;
            else fields[k] = v;
          }
          return { time, msg, fields };
        };
      }
      case "map-level": {
        const name = p.field ?? "level";
        return (e: Entry): Entry | null => {
          const raw = e.fields[name];
          if (raw === undefined) return e;
          const level = toLevel(raw);
          return level ? { ...e, fields: { ...e.fields, level } } : e;
        };
      }
      case "mask": {
        const re = new RegExp(p.pattern, "g");
        const replacement = p.replacement ?? "***";
        return (e: Entry): Entry | null => ({
          ...e,
          msg: e.msg.replace(re, replacement),
          fields: Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v.replace(re, replacement)])),
        });
      }
      case "mask-secrets":
        return (e: Entry): Entry | null => ({
          ...e,
          msg: maskSecrets(e.msg),
          fields: Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, maskSecrets(v)])),
        });
      case "drop": {
        const re = new RegExp(p.pattern);
        return (e: Entry): Entry | null => {
          const v = valueOf(e, p.field);
          return v !== undefined && re.test(v) ? null : e;
        };
      }
      case "sample": {
        const re = new RegExp(p.pattern);
        return (e: Entry): Entry | null => {
          const v = valueOf(e, p.field);
          return v !== undefined && re.test(v) && random() * 100 >= p.percent ? null : e;
        };
      }
      case "set":
        return (e: Entry): Entry | null => ({ ...e, fields: { ...e.fields, [p.field]: p.value } });
    }
  });

  return (batch: Entry[]): Outcome => {
    const kept: Entry[] = [];
    let dropped = 0;
    for (const original of batch) {
      let e: Entry | null = original;
      for (const step of steps) {
        e = step(e);
        if (!e) break;
      }
      if (e) kept.push(normalize(e));
      else dropped++;
    }
    return { kept, dropped };
  };
}

/** Within what VictoriaLogs and the screens handle: names it accepts, a cap on fields and lengths, a known level. */
export function normalize(e: Entry): Entry {
  const fields: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(e.fields)) {
    const name = k.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z]+/, "");
    if (!name || name.length > 128 || n >= MAX_FIELDS) continue;
    fields[name] = v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…` : v;
    n++;
  }
  if (fields.level !== undefined) {
    const level = toLevel(fields.level);
    if (level) fields.level = level;
  }
  return { time: e.time, msg: e.msg.length > MAX_MSG ? `${e.msg.slice(0, MAX_MSG)}…` : e.msg, fields };
}

/** What a new source starts with: JSON in the message becomes fields, levels are named alike, secrets are masked. */
export const DEFAULT_PROCESSORS: Processor[] = [{ type: "parse-json" }, { type: "map-level" }, { type: "mask-secrets" }];
