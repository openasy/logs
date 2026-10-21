import { describe, expect, it } from "vitest";
import { checkProcessors, compile, DEFAULT_PROCESSORS, fromObject, maskSecrets, normalize, PipelineError, toLevel, toTime, type Entry } from "./pipeline.ts";

const T = "2026-10-21T10:00:00.000Z";
const line = (msg: string, fields: Record<string, string> = {}): Entry => ({ time: T, msg, fields });

describe("checkProcessors", () => {
  it("takes every kind of step", () => {
    const steps = [
      { type: "parse-json" },
      { type: "parse-regex", pattern: "status=(?<status>\\d{3})" },
      { type: "map-level", field: "severity" },
      { type: "mask", pattern: "\\d{16}", replacement: "[card]" },
      { type: "mask-secrets" },
      { type: "drop", field: "path", pattern: "^/healthz$" },
      { type: "sample", field: "status", pattern: "^2", percent: 10 },
      { type: "set", field: "service", value: "nginx" },
    ];
    expect(checkProcessors(steps)).toEqual(steps);
  });

  it("says what is wrong, step by step", () => {
    expect(() => checkProcessors([{ type: "parse-regex", pattern: "(" }])).toThrow(/step 1: Invalid regular expression/);
    expect(() => checkProcessors([{ type: "parse-json" }, { type: "parse-regex", pattern: "\\d+" }])).toThrow(/step 2: name the parts/);
    expect(() => checkProcessors([{ type: "sample", field: "status", pattern: "^2", percent: 100 }])).toThrow(PipelineError);
    expect(() => checkProcessors([{ type: "drop", field: "1bad", pattern: "x" }])).toThrow(/field is a name/);
    expect(() => checkProcessors([{ type: "explode" }])).toThrow(/type is one of/);
    expect(() => checkProcessors({})).toThrow(/list of up to 32/);
  });
});

describe("pipelines", () => {
  it("turn JSON in the message into fields, with its message, time and level", () => {
    const run = compile(DEFAULT_PROCESSORS);
    const { kept } = run([line('{"level":"WARNING","msg":"slow query","ts":"2026-10-21T09:59:00Z","db":{"table":"orders","ms":812}}')]);
    expect(kept).toEqual([{ time: "2026-10-21T09:59:00.000Z", msg: "slow query", fields: { level: "warn", "db.table": "orders", "db.ms": "812" } }]);
  });

  it("leave lines that are not JSON as they are", () => {
    const { kept } = compile([{ type: "parse-json" }])([line("{not json"), line("plain text")]);
    expect(kept.map((e) => e.msg)).toEqual(["{not json", "plain text"]);
  });

  it("take named parts of a regular expression, including msg and time", () => {
    const run = compile(checkProcessors([{ type: "parse-regex", pattern: '^(?<remote_addr>\\S+) \\S+ \\S+ \\[(?<time>[^\\]]+)\\] "(?<msg>[^"]*)" (?<status>\\d{3})' }]));
    const { kept } = run([line('203.0.113.9 - - [21/Oct/2026:09:58:00 +0000] "GET /orders HTTP/1.1" 502 157')]);
    expect(kept[0]!.msg).toBe("GET /orders HTTP/1.1");
    expect(kept[0]!.fields).toEqual({ remote_addr: "203.0.113.9", status: "502" });
    expect(kept[0]!.time).toBe("2026-10-21T09:58:00.000Z");
  });

  it("drop and sample what matches, and count it", () => {
    const run = compile(
      [
        { type: "drop", field: "path", pattern: "^/healthz$" },
        { type: "sample", field: "status", pattern: "^2", percent: 10 },
      ],
      () => 0.5,
    );
    const { kept, dropped } = run([line("a", { path: "/healthz" }), line("b", { status: "200" }), line("c", { status: "500" })]);
    expect(kept.map((e) => e.msg)).toEqual(["c"]);
    expect(dropped).toBe(2);
    // Under the percentage, a matching line is kept.
    expect(compile([{ type: "sample", field: "status", pattern: "^2", percent: 10 }], () => 0.05)([line("b", { status: "200" })]).kept).toHaveLength(1);
  });

  it("mask in the message and in every field", () => {
    const { kept } = compile([{ type: "mask", pattern: "\\b\\d{16}\\b", replacement: "[card]" }])([line("paid with 4111111111111111", { card: "4111111111111111" })]);
    expect(kept[0]).toMatchObject({ msg: "paid with [card]", fields: { card: "[card]" } });
  });

  it("set fields the sender left out", () => {
    expect(compile([{ type: "set", field: "service", value: "nginx" }])([line("x")]).kept[0]!.fields.service).toBe("nginx");
  });
});

describe("maskSecrets", () => {
  it.each([
    ["login password=hunter22 ok", "login password=*** ok"],
    ['{"api_key": "abcd1234efgh"}', '{"api_key": "***"}'],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc", "Authorization: Bearer ***"],
    ["key AKIAIOSFODNN7EXAMPLE used", "key AKIA**************** used"],
    ["postgres://app:s3cret@db:5432/app", "postgres://app:***@db:5432/app"],
    ["token ghp_0123456789abcdefghijklmnopqrstuvwxyz", "token ghp_***"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----", "[private key masked]"],
  ])("%s", (input, out) => expect(maskSecrets(input)).toBe(out));

  it("leaves ordinary lines alone", () => {
    expect(maskSecrets("GET /orders/42 200 in 12ms")).toBe("GET /orders/42 200 in 12ms");
  });
});

describe("levels and times", () => {
  it("names levels alike", () => {
    expect(["ERR", "Warning", "3", "notice", "CRIT", "verbose", "nope"].map(toLevel)).toEqual(["error", "warn", "error", "info", "fatal", "trace", undefined]);
  });

  it("reads seconds, milliseconds, nanoseconds and ISO 8601", () => {
    expect(toTime(1792576800)).toBe("2026-10-21T10:00:00.000Z");
    expect(toTime(1792576800000)).toBe("2026-10-21T10:00:00.000Z");
    expect(toTime("1792576800000000000")).toBe("2026-10-21T10:00:00.000Z");
    expect(toTime("2026-10-21T12:00:00+02:00")).toBe("2026-10-21T10:00:00.000Z");
    expect(toTime("yesterday")).toBeUndefined();
  });

  it("keep fields within what storage takes", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, "x"]));
    const e = normalize({ time: T, msg: "x".repeat(70_000), fields: { ...many, "bad name!": "v", "9lives": "v" } });
    expect(Object.keys(e.fields)).toHaveLength(64);
    expect(e.msg.length).toBe(64 * 1024 + 1);
    expect(normalize(line("x", { "bad name!": "v" })).fields).toEqual({ bad_name_: "v" });
  });

  it("reads shippers' objects", () => {
    expect(fromObject({ "@timestamp": "2026-10-21T10:00:00Z", message: "hi", log: { level: "info" }, host: { name: "web-1" } }, T)).toEqual({ time: T, msg: "hi", fields: { "log.level": "info", "host.name": "web-1" } });
  });
});
