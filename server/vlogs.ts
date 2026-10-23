// VictoriaLogs inside the product's container (ADR 0035): started as a child process on 127.0.0.1, restarted when
// it stops, and reached only through this client. Nobody else talks to it; every read and write goes through Logs.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { log } from "./log.ts";
import type { Entry } from "./pipeline.ts";

export interface VlogsOptions {
  binary: string;
  dataPath: string;
  port: number;
  retentionDays: number;
  /** Oldest days are deleted first above this, so a full disk never stops the product. 0 leaves it to the percent. */
  maxDiskBytes: number;
}

/** Lines as the screens show them. */
export interface Line {
  time: string;
  msg: string;
  level: string | null;
  host: string | null;
  service: string | null;
  source: string | null;
  fields: Record<string, string>;
}

export class VlogsError extends Error {
  /** 400 when VictoriaLogs refused the query itself, with its reason; 503 when it could not be reached. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The fields every source stream is keyed by: lines of one source, host and service are stored together. */
export const STREAM_FIELDS = ["source", "host", "service"];
const RESERVED = new Set(["_msg", "_time", "_stream", "_stream_id", "level", "host", "service", "source"]);

export function toLine(raw: Record<string, string>): Line {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k)) fields[k] = v;
  return {
    time: raw._time ?? "",
    msg: raw._msg ?? "",
    level: raw.level ?? null,
    host: raw.host ?? null,
    service: raw.service ?? null,
    source: raw.source ?? null,
    fields,
  };
}

export function createVlogsClient(base: string, opts: { timeoutMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? 30_000;

  async function call(
    path: string,
    params: Record<string, string | number | undefined>,
    init: { body?: string | Buffer; type?: string; signal?: AbortSignal } = {},
  ) {
    const url = new URL(path, base);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form.set(k, String(v));
    let res: Response;
    try {
      if (init.body !== undefined) {
        for (const [k, v] of form) url.searchParams.set(k, v);
        // Without this type VictoriaLogs reads the body as a form and stores nothing, while still answering 200.
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": init.type ?? "application/stream+json" },
          body: init.body,
          signal: init.signal ?? AbortSignal.timeout(timeout),
        });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form,
          signal: init.signal ?? AbortSignal.timeout(timeout),
        });
      }
    } catch (err) {
      throw new VlogsError(503, `VictoriaLogs is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text()).trim();
      throw new VlogsError(
        res.status >= 500 ? 503 : 400,
        text.replace(/^cannot parse `query` arg \[.*?\]: /, "").slice(0, 2000) || `VictoriaLogs answered ${res.status}`,
      );
    }
    return res;
  }

  const jsonLines = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);

  return {
    async healthy(): Promise<boolean> {
      try {
        const r = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },

    /** Stores entries. The fields named in STREAM_FIELDS group them into streams. */
    async insert(entries: Entry[]): Promise<void> {
      if (!entries.length) return;
      const body = entries.map((e) => JSON.stringify({ ...e.fields, _time: e.time, _msg: e.msg || "-" })).join("\n") + "\n";
      await call("/insert/jsonline", { _stream_fields: STREAM_FIELDS.join(","), _msg_field: "_msg", _time_field: "_time" }, { body });
    },

    /** The newest `limit` lines that match, newest first. */
    async query(q: string, range: { start?: string; end?: string }, limit: number): Promise<Line[]> {
      const res = await call("/select/logsql/query", { query: q, start: range.start, end: range.end, limit });
      return jsonLines(await res.text())
        .map(toLine)
        .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    },

    /** Rows of a stats query, such as `* | stats by (level) count() n`. */
    async stats(q: string, range: { start?: string; end?: string }): Promise<Array<Record<string, string>>> {
      const res = await call("/select/logsql/query", { query: q, start: range.start, end: range.end });
      return jsonLines(await res.text());
    },

    /** Counts per step, split by a field: the volume chart. */
    async hits(q: string, range: { start: string; end: string }, step: string, field?: string) {
      const res = await call("/select/logsql/hits", { query: q, start: range.start, end: range.end, step, field });
      return (await res.json()) as { hits: Array<{ fields: Record<string, string>; timestamps: string[]; values: number[]; total: number }> };
    },

    /** The most frequent values of each field among matching lines. */
    async facets(q: string, range: { start?: string; end?: string }, limit: number) {
      const res = await call("/select/logsql/facets", { query: q, start: range.start, end: range.end, limit });
      return (await res.json()) as { facets: Array<{ field_name: string; values: Array<{ field_value: string; hits: number }> }> };
    },

    /** New lines as they arrive, until the signal aborts. */
    async *tail(q: string, signal: AbortSignal): AsyncGenerator<Line> {
      const res = await call("/select/logsql/tail", { query: q, start_offset: "5s" }, { signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          rest += decoder.decode(value, { stream: true });
          const lines = rest.split("\n");
          rest = lines.pop()!;
          for (const l of lines) if (l.trim()) yield toLine(JSON.parse(l) as Record<string, string>);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },

    /** Disk use and lines stored, from VictoriaLogs' own metrics. */
    async usage(): Promise<{ bytes: number; rows: number }> {
      const r = await fetch(new URL("/metrics", base), { signal: AbortSignal.timeout(5000) });
      const text = await r.text();
      const sum = (re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
      return { bytes: sum(/^vl_data_size_bytes\{[^}]*\} (\S+)$/gm), rows: sum(/^vl_storage_rows\{[^}]*\} (\S+)$/gm) };
    },
  };
}

export type VlogsClient = ReturnType<typeof createVlogsClient>;

/**
 * Starts VictoriaLogs and keeps it running: it is restarted a second after it stops, then after longer waits if it
 * keeps stopping. `restart` applies new retention settings.
 */
export function startVictoriaLogs(o: VlogsOptions) {
  mkdirSync(o.dataPath, { recursive: true });
  let child: ChildProcess | undefined;
  let stopping = false;
  let failures = 0;
  let current = o;
  let timer: NodeJS.Timeout | undefined;
  const state = { running: false, restarts: 0, lastExit: null as string | null };

  const args = (v: VlogsOptions) => [
    `-storageDataPath=${v.dataPath}`,
    `-httpListenAddr=127.0.0.1:${v.port}`,
    `-retentionPeriod=${v.retentionDays}d`,
    ...(v.maxDiskBytes > 0 ? [`-retention.maxDiskSpaceUsageBytes=${v.maxDiskBytes}`] : ["-retention.maxDiskUsagePercent=90"]),
    "-loggerFormat=json",
    "-loggerLevel=WARN",
    "-search.maxQueryDuration=30s",
    "-search.maxConcurrentRequests=8",
    "-http.disableResponseCompression",
  ];

  function run() {
    const c = spawn(current.binary, args(current), { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    state.running = true;
    // Its own JSON logs go out with ours, marked as VictoriaLogs' (ADR 0017).
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        let msg = line;
        let level = "warn";
        try {
          const j = JSON.parse(line) as { msg?: string; level?: string };
          msg = j.msg ?? line;
          level = j.level === "error" || j.level === "fatal" || j.level === "panic" ? "error" : j.level === "info" ? "info" : "warn";
        } catch {
          // Not JSON: passed on as it is.
        }
        log(level as "info" | "warn" | "error", "victorialogs", { detail: msg });
      }
    };
    c.stdout!.on("data", relay);
    c.stderr!.on("data", relay);
    c.on("error", (err) => log("error", "victorialogs could not start", { error: String(err), binary: current.binary }));
    c.on("exit", (code, signal) => {
      state.running = false;
      if (child !== c) return;
      child = undefined;
      if (stopping) return;
      failures++;
      state.restarts++;
      state.lastExit = `${new Date().toISOString()}: ${signal ?? `exit ${code}`}`;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      log("error", "victorialogs stopped; starting it again", { code, signal, inMs: wait });
      timer = setTimeout(run, wait);
    });
    // Running for a minute counts as healthy again.
    setTimeout(() => child === c && (failures = 0), 60_000).unref();
  }
  run();

  function stop(): Promise<void> {
    stopping = true;
    clearTimeout(timer);
    const c = child;
    if (!c || c.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => c.kill("SIGKILL"), 10_000);
      c.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      c.kill("SIGTERM");
    });
  }

  return {
    url: `http://127.0.0.1:${o.port}`,
    state,
    stop,
    /** Stops VictoriaLogs and starts it with new settings. */
    async restart(next: Partial<VlogsOptions>) {
      await stop();
      stopping = false;
      current = { ...current, ...next };
      run();
    },
  };
}

export type VictoriaLogs = ReturnType<typeof startVictoriaLogs>;

/** Waits until VictoriaLogs answers /health, up to `ms`. */
export async function waitHealthy(client: VlogsClient, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await client.healthy()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
