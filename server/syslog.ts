// Syslog receivers (ADR 0035): RFC 5424 and RFC 3164 messages, over TLS on 6514 and, only where a source allows it,
// plain TCP and UDP. Syslog carries no token, so a message belongs to the source whose networks hold its sender.
import { isIPv4, isIPv6 } from "node:net";
import { toTime, type Entry, type Level } from "./pipeline.ts";

const SEVERITY: Level[] = ["fatal", "fatal", "fatal", "error", "warn", "info", "info", "debug"];
const FACILITY = ["kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp", "ntp", "security", "console", "solaris-cron", "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const nil = (v: string | undefined) => (v === undefined || v === "-" ? undefined : v);

/** Structured data, [id key="value" ...]..., as fields named id.key. */
function structuredData(s: string, fields: Record<string, string>): string {
  let i = 0;
  while (s[i] === "[") {
    const end = (() => {
      let inQuote = false;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === '"') inQuote = !inQuote;
        else if (s[j] === "]" && !inQuote) return j;
      }
      return -1;
    })();
    if (end < 0) break;
    const element = s.slice(i + 1, end);
    const id = element.split(" ", 1)[0]!.replace(/@.*$/, "");
    for (const m of element.matchAll(/([^\s=\]"]+)="((?:[^"\\]|\\.)*)"/g)) fields[`${id}.${m[1]}`] = m[2]!.replace(/\\(["\\\]])/g, "$1");
    i = end + 1;
  }
  return s.slice(i);
}

/**
 * One syslog message, in either format. Anything that is not syslog is kept as the message, so nothing a device
 * sends is lost.
 */
export function parseSyslog(raw: string, now: Date = new Date()): Entry {
  const line = raw.replace(/[\r\n]+$/, "");
  const received = now.toISOString();
  const pri = /^<(\d{1,3})>/.exec(line);
  if (!pri || Number(pri[1]) > 191) return { time: received, msg: line, fields: {} };
  const p = Number(pri[1]);
  const fields: Record<string, string> = { level: SEVERITY[p % 8]!, "syslog.facility": FACILITY[p >> 3] ?? String(p >> 3) };
  const rest = line.slice(pri[0].length);

  // RFC 5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
  const v1 = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) /.exec(rest);
  if (v1) {
    const [, ts, host, app, proc, msgid] = v1;
    if (nil(host)) fields.host = host!;
    if (nil(app)) fields.service = app!;
    if (nil(proc)) fields["syslog.procid"] = proc!;
    if (nil(msgid)) fields["syslog.msgid"] = msgid!;
    let after = rest.slice(v1[0].length);
    after = after.startsWith("-") ? after.slice(1) : structuredData(after, fields);
    // A UTF-8 byte order mark may start the message.
    const msg = after.replace(/^ /, "").replace(/^﻿/, "");
    return { time: (nil(ts) && toTime(ts)) || received, msg, fields };
  }

  // RFC 3164: Mmm dd hh:mm:ss HOSTNAME TAG[PID]: MSG. The year is not sent: the one that puts it closest to now.
  const bsd = /^([A-Z][a-z]{2}) ([ \d]\d) (\d\d):(\d\d):(\d\d) (?:(\S+) )?/.exec(rest);
  let time = received;
  let body = rest;
  if (bsd && MONTHS.includes(bsd[1]!)) {
    const [, mon, day, hh, mm, ss, host] = bsd;
    const at = (year: number) => Date.UTC(year, MONTHS.indexOf(mon!), Number(day), Number(hh), Number(mm), Number(ss));
    const y = now.getUTCFullYear();
    const best = [y - 1, y, y + 1].map(at).reduce((a, b) => (Math.abs(b - now.getTime()) < Math.abs(a - now.getTime()) ? b : a));
    time = new Date(best).toISOString();
    body = rest.slice(bsd[0].length);
    // Without a host name, what follows the time is the tag.
    if (host && !/[:[]/.test(host)) fields.host = host;
    else body = `${host ?? ""} ${body}`.trimStart();
  }
  const tag = /^([^\s:[\]]{1,48})(?:\[([^\]]{1,32})\])?: ?/.exec(body);
  if (tag) {
    fields.service = tag[1]!;
    if (tag[2]) fields["syslog.procid"] = tag[2];
    body = body.slice(tag[0].length);
  }
  return { time, msg: body, fields };
}

/**
 * Splits a TCP stream into messages: octet counting (RFC 6587, "LEN SP MSG") when a frame starts with digits and a
 * space, otherwise one message per line. Returns the messages and what is left for the next chunk.
 */
export function splitFrames(buffer: Buffer, maxFrame = 64 * 1024): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let i = 0;
  while (i < buffer.length) {
    const sp = buffer.indexOf(0x20, i);
    const head = sp > i && sp - i <= 6 ? buffer.subarray(i, sp).toString("latin1") : "";
    if (/^[1-9]\d*$/.test(head)) {
      const len = Number(head);
      if (len > maxFrame) throw new Error(`a frame of ${len} bytes is larger than ${maxFrame}`);
      if (buffer.length < sp + 1 + len) break;
      messages.push(buffer.subarray(sp + 1, sp + 1 + len).toString("utf8"));
      i = sp + 1 + len;
      continue;
    }
    const nl = buffer.indexOf(0x0a, i);
    if (nl < 0) {
      if (buffer.length - i > maxFrame) throw new Error(`a line longer than ${maxFrame} bytes`);
      break;
    }
    const line = buffer.subarray(i, nl).toString("utf8").replace(/\r$/, "");
    if (line) messages.push(line);
    i = nl + 1;
  }
  return { messages, rest: buffer.subarray(i) };
}

// ---- Networks -------------------------------------------------------------------------------------------------------

/** An address as a 128-bit number; IPv4 and IPv4-mapped IPv6 share the ::ffff:0:0/96 range. */
function toBigInt(addr: string): bigint | undefined {
  const a = addr.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIPv4(a)) return a.split(".").reduce((n, o) => (n << 8n) | BigInt(Number(o)), 0n) | 0xffff00000000n;
  if (!isIPv6(a)) return undefined;
  const [head, tail = ""] = a.split("::");
  const parse = (s: string) => (s ? s.split(":") : []);
  let h = parse(head!);
  let t = parse(tail);
  // An embedded IPv4 address at the end counts as two groups.
  const v4 = (t.length ? t : h).at(-1);
  if (v4 && isIPv4(v4)) {
    const n = v4.split(".").map(Number);
    const groups = [((n[0]! << 8) | n[1]!).toString(16), ((n[2]! << 8) | n[3]!).toString(16)];
    if (t.length) t = [...t.slice(0, -1), ...groups];
    else h = [...h.slice(0, -1), ...groups];
  }
  const groups = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return undefined;
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

/** 10.0.0.0/8, 2001:db8::/32 or one address. Throws when it is not one. */
export function parseNetwork(cidr: string): { base: bigint; bits: number } {
  const [addr, len] = cidr.split("/");
  const n = toBigInt(addr ?? "");
  if (n === undefined) throw new Error(`${cidr} is not an address or network`);
  const v4 = isIPv4(addr!);
  const max = v4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (len !== undefined && !/^\d+$/.test(len))) throw new Error(`${cidr}: the prefix length is 0 to ${max}`);
  const total = v4 ? bits + 96 : bits;
  const mask = total === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - total)) - 1n);
  return { base: n & mask, bits: total };
}

export function inNetwork(addr: string, net: { base: bigint; bits: number }): boolean {
  const n = toBigInt(addr);
  if (n === undefined) return false;
  const mask = net.bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - net.bits)) - 1n);
  return (n & mask) === net.base;
}
