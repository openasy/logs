import { describe, expect, it } from "vitest";
import { inNetwork, parseNetwork, parseSyslog, splitFrames } from "./syslog.ts";

const NOW = new Date("2026-10-21T10:00:00Z");

describe("parseSyslog", () => {
  it("reads RFC 5424 with structured data", () => {
    const e = parseSyslog('<165>1 2026-10-21T09:59:58.123Z web-1 nginx 4242 ID47 [exampleSDID@32473 iut="3" eventSource="Application"] ﻿request timed out', NOW);
    expect(e).toEqual({
      time: "2026-10-21T09:59:58.123Z",
      msg: "request timed out",
      fields: { level: "info", "syslog.facility": "local4", host: "web-1", service: "nginx", "syslog.procid": "4242", "syslog.msgid": "ID47", "exampleSDID.iut": "3", "exampleSDID.eventSource": "Application" },
    });
  });

  it("reads RFC 5424 without structured data, and nil values", () => {
    const e = parseSyslog("<11>1 - db-1 - - - - disk almost full", NOW);
    expect(e).toEqual({ time: NOW.toISOString(), msg: "disk almost full", fields: { level: "error", "syslog.facility": "user", host: "db-1" } });
  });

  it("reads RFC 3164, with the year closest to now", () => {
    expect(parseSyslog("<38>Oct 21 09:59:01 bastion sshd[812]: Failed password for root from 203.0.113.7 port 51234 ssh2", NOW)).toEqual({
      time: "2026-10-21T09:59:01.000Z",
      msg: "Failed password for root from 203.0.113.7 port 51234 ssh2",
      fields: { level: "info", "syslog.facility": "auth", host: "bastion", service: "sshd", "syslog.procid": "812" },
    });
    // A message from the last days of December, received early in January, is from the year before.
    expect(parseSyslog("<13>Dec 31 23:59:59 h app: x", new Date("2027-01-01T00:00:10Z")).time).toBe("2026-12-31T23:59:59.000Z");
  });

  it("reads RFC 3164 without a host name", () => {
    expect(parseSyslog("<13>Oct 21 09:59:01 cron[77]: job done", NOW).fields).toEqual({ level: "info", "syslog.facility": "user", service: "cron", "syslog.procid": "77" });
  });

  it("keeps whatever is not syslog as the message", () => {
    expect(parseSyslog("just text", NOW)).toEqual({ time: NOW.toISOString(), msg: "just text", fields: {} });
    expect(parseSyslog("<999>1 bad", NOW).msg).toBe("<999>1 bad");
  });
});

describe("splitFrames", () => {
  it("splits octet-counted and newline frames, keeping what is incomplete", () => {
    const a = splitFrames(Buffer.from("11 <13>1 - - -5 <13>"));
    expect(a.messages).toEqual(["<13>1 - - -"]);
    expect(a.rest.toString()).toBe("5 <13>");
    const b = splitFrames(Buffer.from("<13>one\r\n<13>two\n<13>thr"));
    expect(b.messages).toEqual(["<13>one", "<13>two"]);
    expect(b.rest.toString()).toBe("<13>thr");
  });

  it("refuses frames larger than allowed", () => {
    expect(() => splitFrames(Buffer.from("99999 x"), 1024)).toThrow(/larger than/);
    expect(() => splitFrames(Buffer.alloc(2048, 0x61), 1024)).toThrow(/longer than/);
  });
});

describe("networks", () => {
  it("match IPv4, IPv6 and IPv4 seen through an IPv6 socket", () => {
    const lan = parseNetwork("10.0.0.0/8");
    expect(inNetwork("10.20.30.40", lan)).toBe(true);
    expect(inNetwork("::ffff:10.20.30.40", lan)).toBe(true);
    expect(inNetwork("11.0.0.1", lan)).toBe(false);
    const v6 = parseNetwork("2001:db8::/32");
    expect(inNetwork("2001:db8:1::5", v6)).toBe(true);
    expect(inNetwork("2001:db9::5", v6)).toBe(false);
    expect(inNetwork("10.0.0.1", v6)).toBe(false);
    expect(inNetwork("192.0.2.7", parseNetwork("192.0.2.7"))).toBe(true);
    expect(inNetwork("192.0.2.8", parseNetwork("192.0.2.7"))).toBe(false);
    expect(inNetwork("203.0.113.1", parseNetwork("0.0.0.0/0"))).toBe(true);
  });

  it("refuse what is not a network", () => {
    expect(() => parseNetwork("10.0.0.0/33")).toThrow(/0 to 32/);
    expect(() => parseNetwork("example.com")).toThrow(/not an address/);
    expect(() => parseNetwork("10.0.0.0/x")).toThrow();
  });
});
