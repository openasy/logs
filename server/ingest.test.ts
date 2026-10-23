import { describe, expect, it } from "vitest";
import { IngestError, parseBulk, parseJsonLines, parseOtlpJson, parseOtlpProtobuf } from "./ingest.ts";

const NOW = "2026-10-21T10:00:00.000Z";

/** Enough of a protobuf writer to build what the OpenTelemetry Collector sends. */
const pb = {
  varint(n: number | bigint): Buffer {
    const out: number[] = [];
    let v = BigInt(n);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return Buffer.from(out);
  },
  field(n: number, wire: number, payload: Buffer): Buffer {
    return Buffer.concat([pb.varint((n << 3) | wire), payload]);
  },
  bytes: (n: number, b: Buffer) => pb.field(n, 2, Buffer.concat([pb.varint(b.length), b])),
  str: (n: number, s: string) => pb.bytes(n, Buffer.from(s)),
  fixed64(n: number, v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return pb.field(n, 1, b);
  },
  kv: (k: string, v: Buffer) => Buffer.concat([pb.str(1, k), pb.bytes(2, v)]),
};
const sv = (s: string) => pb.str(1, s);

describe("JSON lines", () => {
  it("reads one object per line, and arrays of them", () => {
    const e = parseJsonLines('{"message":"a","level":"error","kubernetes":{"pod":"api-7"}}\n\n[{"msg":"b"},{"msg":"c"}]\nnot json\n', NOW);
    expect(e).toEqual([
      { time: NOW, msg: "a", fields: { level: "error", "kubernetes.pod": "api-7" } },
      { time: NOW, msg: "b", fields: {} },
      { time: NOW, msg: "c", fields: {} },
      { time: NOW, msg: "not json", fields: {} },
    ]);
  });
});

describe("Elasticsearch bulk", () => {
  it("reads documents after index and create actions", () => {
    const body = [
      '{"index":{"_index":"winlogbeat"}}',
      '{"@timestamp":"2026-10-21T09:00:00Z","message":"logon","event":{"code":4624}}',
      '{"create":{}}',
      '{"message":"x"}',
      '{"delete":{"_id":"1"}}',
      "",
    ].join("\n");
    const { entries, actions } = parseBulk(body, NOW);
    expect(actions).toEqual(["index", "create", "delete"]);
    expect(entries).toEqual([
      { time: "2026-10-21T09:00:00.000Z", msg: "logon", fields: { "event.code": "4624" } },
      { time: NOW, msg: "x", fields: {} },
    ]);
  });

  it("says which line is wrong", () => {
    expect(() => parseBulk('{"index":{}}\n{nope', NOW)).toThrow(/line 2/);
    expect(() => parseBulk('{"index":{}}', NOW)).toThrow(IngestError);
  });
});

describe("OpenTelemetry", () => {
  const json = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "checkout" } },
            { key: "host.name", value: { stringValue: "web-2" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "app" },
            logRecords: [
              {
                timeUnixNano: "1792576800000000000",
                severityNumber: 17,
                severityText: "ERROR",
                body: { stringValue: "payment failed" },
                attributes: [
                  { key: "order.id", value: { intValue: "42" } },
                  { key: "retry", value: { boolValue: true } },
                ],
                traceId: "5b8efff798038103d269b633813fc60c",
                spanId: "eee19b7ec3c1b174",
              },
            ],
          },
        ],
      },
    ],
  };
  const expected = {
    time: "2026-10-21T10:00:00.000Z",
    msg: "payment failed",
    fields: {
      "service.name": "checkout",
      "host.name": "web-2",
      service: "checkout",
      host: "web-2",
      "otel.scope": "app",
      "order.id": "42",
      retry: "true",
      level: "error",
      trace_id: "5b8efff798038103d269b633813fc60c",
      span_id: "eee19b7ec3c1b174",
    },
  };

  it("reads OTLP JSON", () => {
    expect(parseOtlpJson(json, NOW)).toEqual([expected]);
    expect(() => parseOtlpJson({}, NOW)).toThrow(/resourceLogs/);
  });

  it("reads OTLP protobuf the same way", () => {
    const record = Buffer.concat([
      pb.fixed64(1, 1792576800000000000n),
      pb.field(2, 0, pb.varint(17)),
      pb.str(3, "ERROR"),
      pb.bytes(5, sv("payment failed")),
      pb.bytes(6, pb.kv("order.id", pb.field(3, 0, pb.varint(42)))),
      pb.bytes(6, pb.kv("retry", pb.field(2, 0, pb.varint(1)))),
      pb.bytes(9, Buffer.from("5b8efff798038103d269b633813fc60c", "hex")),
      pb.bytes(10, Buffer.from("eee19b7ec3c1b174", "hex")),
      // A field this reader does not know is skipped.
      pb.field(8, 5, Buffer.alloc(4)),
    ]);
    const scope = Buffer.concat([pb.bytes(1, pb.str(1, "app")), pb.bytes(2, record)]);
    const resource = Buffer.concat([pb.bytes(1, pb.kv("service.name", sv("checkout"))), pb.bytes(1, pb.kv("host.name", sv("web-2")))]);
    const request = pb.bytes(1, Buffer.concat([pb.bytes(1, resource), pb.bytes(2, scope)]));
    expect(parseOtlpProtobuf(request, NOW)).toEqual([expected]);
  });

  it("refuses truncated protobuf", () => {
    expect(() => parseOtlpProtobuf(Buffer.from([0x0a, 0x10, 0x01]), NOW)).toThrow(/truncated/);
  });
});
