// What shippers send, as entries (ADR 0035): JSON lines (Vector, Fluent Bit), Elasticsearch bulk (Winlogbeat,
// Fluent Bit, Vector) and OpenTelemetry logs over HTTP, in JSON or protobuf. Each parser takes the whole body and
// throws IngestError with what is wrong; the source's pipeline runs afterwards.
import { fromObject, otelLevel, type Entry } from "./pipeline.ts";

export class IngestError extends Error {}

/** One JSON object per line. Blank lines are skipped; a line that is not an object is kept as its text. */
export function parseJsonLines(body: string, now = new Date().toISOString()): Entry[] {
  const out: Entry[] = [];
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      out.push({ time: now, msg: s, fields: {} });
      continue;
    }
    if (Array.isArray(v))
      for (const item of v)
        out.push(item && typeof item === "object" ? fromObject(item as Record<string, unknown>, now) : { time: now, msg: String(item), fields: {} });
    else if (v && typeof v === "object") out.push(fromObject(v as Record<string, unknown>, now));
    else out.push({ time: now, msg: String(v), fields: {} });
  }
  return out;
}

/** The Elasticsearch _bulk body: an action line, then a document for index and create. Others are ignored. */
export function parseBulk(body: string, now = new Date().toISOString()): { entries: Entry[]; actions: string[] } {
  const lines = body.split("\n").filter((l) => l.trim());
  const entries: Entry[] = [];
  const actions: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let action: Record<string, unknown>;
    try {
      action = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      throw new IngestError(`line ${i + 1} is not JSON`);
    }
    const kind = Object.keys(action)[0];
    if (kind === "index" || kind === "create") {
      const doc = lines[++i];
      if (doc === undefined) throw new IngestError(`the ${kind} action on line ${i} has no document`);
      try {
        const d = JSON.parse(doc) as unknown;
        if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error();
        entries.push(fromObject(d as Record<string, unknown>, now));
      } catch {
        throw new IngestError(`line ${i + 1} is not a JSON document`);
      }
      actions.push(kind);
    } else if (kind === "update") {
      i++;
      actions.push(kind);
    } else actions.push(kind ?? "unknown");
  }
  return { entries, actions };
}

// ---- OpenTelemetry --------------------------------------------------------------------------------------------------

type AnyValue = string | number | boolean | null | AnyValue[] | { [k: string]: AnyValue };
interface KV {
  key: string;
  value: AnyValue;
}
interface LogRecord {
  timeUnixNano?: bigint;
  observedTimeUnixNano?: bigint;
  severityNumber?: number;
  severityText?: string;
  body?: AnyValue;
  attributes: KV[];
  traceId?: string;
  spanId?: string;
}
interface ResourceLogs {
  resource: KV[];
  scopes: Array<{ name?: string; records: LogRecord[] }>;
}

const nanosToIso = (n: bigint | undefined) => (n && n > 0n ? new Date(Number(n / 1_000_000n)).toISOString() : undefined);
const text = (v: AnyValue | undefined): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

function toEntries(resources: ResourceLogs[], now: string): Entry[] {
  const out: Entry[] = [];
  for (const r of resources) {
    const res: Record<string, string> = {};
    for (const a of r.resource) res[a.key] = text(a.value);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(res)) base[k] = v;
    if (res["service.name"]) base.service = res["service.name"];
    if (res["host.name"]) base.host = res["host.name"];
    for (const s of r.scopes) {
      for (const rec of s.records) {
        const fields: Record<string, string> = { ...base };
        if (s.name) fields["otel.scope"] = s.name;
        for (const a of rec.attributes) fields[a.key] = text(a.value);
        const level = (rec.severityNumber && otelLevel(rec.severityNumber)) || rec.severityText;
        if (level) fields.level = level;
        if (rec.traceId) fields.trace_id = rec.traceId;
        if (rec.spanId) fields.span_id = rec.spanId;
        out.push({ time: nanosToIso(rec.timeUnixNano) ?? nanosToIso(rec.observedTimeUnixNano) ?? now, msg: text(rec.body), fields });
      }
    }
  }
  return out;
}

/** OTLP/HTTP JSON (ExportLogsServiceRequest with camelCase or snake_case names, as the spec allows). */
export function parseOtlpJson(body: unknown, now = new Date().toISOString()): Entry[] {
  const o = body as Record<string, unknown> | null;
  const pick = (x: Record<string, unknown> | undefined, a: string, b: string) => (x ? (x[a] ?? x[b]) : undefined);
  const list = pick(o ?? undefined, "resourceLogs", "resource_logs");
  if (!Array.isArray(list)) throw new IngestError("expected resourceLogs, as in an OTLP ExportLogsServiceRequest");
  const anyValue = (v: unknown): AnyValue => {
    const x = v as Record<string, unknown> | null;
    if (!x || typeof x !== "object") return null;
    if ("stringValue" in x || "string_value" in x) return String(pick(x, "stringValue", "string_value"));
    if ("boolValue" in x || "bool_value" in x) return Boolean(pick(x, "boolValue", "bool_value"));
    if ("intValue" in x || "int_value" in x) return Number(pick(x, "intValue", "int_value"));
    if ("doubleValue" in x || "double_value" in x) return Number(pick(x, "doubleValue", "double_value"));
    if ("bytesValue" in x || "bytes_value" in x) return String(pick(x, "bytesValue", "bytes_value"));
    const arr = pick(x, "arrayValue", "array_value") as { values?: unknown[] } | undefined;
    if (arr) return (arr.values ?? []).map(anyValue);
    const kv = pick(x, "kvlistValue", "kvlist_value") as { values?: unknown[] } | undefined;
    if (kv) return Object.fromEntries(kvs(kv.values).map((p) => [p.key, p.value]));
    return null;
  };
  const kvs = (v: unknown): KV[] => (Array.isArray(v) ? v.map((a) => ({ key: String((a as KV).key), value: anyValue((a as { value: unknown }).value) })) : []);
  const big = (v: unknown) => (typeof v === "string" || typeof v === "number" ? BigInt(v) : undefined);
  const resources: ResourceLogs[] = list.map((rl: Record<string, unknown>) => ({
    resource: kvs((rl.resource as { attributes?: unknown } | undefined)?.attributes),
    scopes: ((pick(rl, "scopeLogs", "scope_logs") as unknown[] | undefined) ?? []).map((sl) => {
      const s = sl as Record<string, unknown>;
      return {
        name: (s.scope as { name?: string } | undefined)?.name,
        records: ((pick(s, "logRecords", "log_records") as unknown[] | undefined) ?? []).map((lr) => {
          const r = lr as Record<string, unknown>;
          const sev = pick(r, "severityNumber", "severity_number");
          return {
            timeUnixNano: big(pick(r, "timeUnixNano", "time_unix_nano")),
            observedTimeUnixNano: big(pick(r, "observedTimeUnixNano", "observed_time_unix_nano")),
            severityNumber: typeof sev === "number" ? sev : undefined,
            severityText: pick(r, "severityText", "severity_text") as string | undefined,
            body: anyValue(r.body),
            attributes: kvs(r.attributes),
            traceId: (pick(r, "traceId", "trace_id") as string | undefined) || undefined,
            spanId: (pick(r, "spanId", "span_id") as string | undefined) || undefined,
          };
        }),
      };
    }),
  }));
  return toEntries(resources, now);
}

/** A minimal protobuf reader: the wire format is simple, and OTLP logs use a handful of message types. */
class Reader {
  private pos = 0;
  private readonly buf: Buffer;
  private readonly end: number;
  constructor(buf: Buffer, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  done() {
    return this.pos >= this.end;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new IngestError("protobuf: truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new IngestError("protobuf: varint too long");
    }
  }
  tag(): { field: number; wire: number } {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 7 };
  }
  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new IngestError("protobuf: truncated fixed64");
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  double(): number {
    if (this.pos + 8 > this.end) throw new IngestError("protobuf: truncated double");
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(): Reader {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new IngestError("protobuf: truncated field");
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }
  raw(): Buffer {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new IngestError("protobuf: truncated field");
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  string(): string {
    return this.raw().toString("utf8");
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += Number(this.varint());
    else if (wire === 5) this.pos += 4;
    else throw new IngestError(`protobuf: wire type ${wire} is not supported`);
  }
}

/** Decodes `read` over every field of a message; fields it does not take are skipped. */
function each(r: Reader, read: (field: number, wire: number) => boolean) {
  while (!r.done()) {
    const { field, wire } = r.tag();
    if (!read(field, wire)) r.skip(wire);
  }
}

function pbAnyValue(r: Reader): AnyValue {
  let v: AnyValue = null;
  each(r, (f, w) => {
    if (f === 1 && w === 2) v = r.string();
    else if (f === 2 && w === 0) v = r.varint() !== 0n;
    else if (f === 3 && w === 0) v = Number(BigInt.asIntN(64, r.varint()));
    else if (f === 4 && w === 1) v = r.double();
    else if (f === 5 && w === 2) {
      const arr: AnyValue[] = [];
      const sub = r.bytes();
      each(sub, (ff, ww) => (ff === 1 && ww === 2 ? (arr.push(pbAnyValue(sub.bytes())), true) : false));
      v = arr;
    } else if (f === 6 && w === 2) {
      const obj: Record<string, AnyValue> = {};
      const sub = r.bytes();
      each(sub, (ff, ww) => {
        if (ff !== 1 || ww !== 2) return false;
        const kv = pbKeyValue(sub.bytes());
        obj[kv.key] = kv.value;
        return true;
      });
      v = obj;
    } else if (f === 7 && w === 2) v = r.raw().toString("base64");
    else return false;
    return true;
  });
  return v;
}

function pbKeyValue(r: Reader): KV {
  let key = "";
  let value: AnyValue = null;
  each(r, (f, w) => {
    if (f === 1 && w === 2) key = r.string();
    else if (f === 2 && w === 2) value = pbAnyValue(r.bytes());
    else return false;
    return true;
  });
  return { key, value };
}

function pbAttributes(r: Reader, into: KV[]) {
  // Resource { repeated KeyValue attributes = 1; }
  each(r, (f, w) => (f === 1 && w === 2 ? (into.push(pbKeyValue(r.bytes())), true) : false));
}

function pbLogRecord(r: Reader): LogRecord {
  const rec: LogRecord = { attributes: [] };
  each(r, (f, w) => {
    if (f === 1 && w === 1) rec.timeUnixNano = r.fixed64();
    else if (f === 11 && w === 1) rec.observedTimeUnixNano = r.fixed64();
    else if (f === 2 && w === 0) rec.severityNumber = Number(r.varint());
    else if (f === 3 && w === 2) rec.severityText = r.string();
    else if (f === 5 && w === 2) rec.body = pbAnyValue(r.bytes());
    else if (f === 6 && w === 2) rec.attributes.push(pbKeyValue(r.bytes()));
    else if (f === 9 && w === 2) rec.traceId = r.raw().toString("hex") || undefined;
    else if (f === 10 && w === 2) rec.spanId = r.raw().toString("hex") || undefined;
    else return false;
    return true;
  });
  return rec;
}

/** OTLP/HTTP protobuf: opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest. */
export function parseOtlpProtobuf(buf: Buffer, now = new Date().toISOString()): Entry[] {
  const resources: ResourceLogs[] = [];
  const top = new Reader(buf);
  each(top, (f, w) => {
    if (f !== 1 || w !== 2) return false;
    const rl: ResourceLogs = { resource: [], scopes: [] };
    const r = top.bytes();
    each(r, (ff, ww) => {
      if (ff === 1 && ww === 2) pbAttributes(r.bytes(), rl.resource);
      else if (ff === 2 && ww === 2) {
        const scope: { name?: string; records: LogRecord[] } = { records: [] };
        const s = r.bytes();
        each(s, (f3, w3) => {
          if (f3 === 1 && w3 === 2) {
            const sc = s.bytes();
            each(sc, (f4, w4) => (f4 === 1 && w4 === 2 ? ((scope.name = sc.string()), true) : false));
          } else if (f3 === 2 && w3 === 2) scope.records.push(pbLogRecord(s.bytes()));
          else return false;
          return true;
        });
        rl.scopes.push(scope);
      } else return false;
      return true;
    });
    resources.push(rl);
    return true;
  });
  return toEntries(resources, now);
}
