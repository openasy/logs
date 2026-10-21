// Sends made-up lines to a running Logs, so every screen has something to show: an hour of history first, then a few
// lines a second until stopped, over HTTP with a source's token and, when asked, over syslog TLS.
//
//   node scripts/demo.ts <ingest token> [base URL] [--syslog host:port]
//
// The token is that of an http source (Sources, Add source, Sent over HTTP). For --syslog, add a syslog source that
// takes 127.0.0.0/8 and ::1 first.
import { connect } from "node:tls";

const args = process.argv.slice(2);
const token = args.find((a) => a.startsWith("olg_"));
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:8080").replace(/\/$/, "");
const syslogAt = args.includes("--syslog") ? args[args.indexOf("--syslog") + 1] : undefined;
if (!token) {
  console.error("usage: node scripts/demo.ts <ingest token olg_...> [base URL] [--syslog host:port]");
  process.exit(1);
}

const SERVICES = ["checkout", "orders-api", "payments", "nginx", "postgres"];
const HOSTS = ["web-1", "web-2", "api-1", "db-1"];
const MESSAGES: Record<string, string[]> = {
  error: ["upstream timeout after 5000ms calling payments POST /v2/charge", "pq: remaining connection slots are reserved", "payment failed for order 4211: card declined"],
  WARNING: ["slow request GET /v1/orders?status=pending took 2841ms", "connection pool saturated: 50/50 in use, 37 waiting"],
  info: ["POST /v1/orders 201 in 84ms", "GET /v1/orders/ord_9f2a 200 in 31ms", "invoice batch processed: 1,284 invoices", "connected to db with password=hunter22"],
  debug: ["retrying job inv_44102 (attempt 2/5) after 800ms"],
};

let n = 0;
function line(at: number) {
  n++;
  const level = n % 23 === 0 ? "error" : n % 7 === 0 ? "WARNING" : n % 11 === 0 ? "debug" : "info";
  const list = MESSAGES[level]!;
  return JSON.stringify({ time: new Date(at).toISOString(), level, msg: list[n % list.length], service: SERVICES[n % SERVICES.length], host: HOSTS[n % HOSTS.length], trace_id: (0x4bf92f35 + n).toString(16), http: { status: level === "error" ? 502 : 200 } });
}

async function send(lines: string[]) {
  const res = await fetch(`${base}/api/v1/ingest/jsonline`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" }, body: lines.join("\n") });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as { accepted: number; dropped: number };
}

function syslog(msg: string) {
  if (!syslogAt) return;
  const [host = "localhost", port = "6514"] = syslogAt.split(":");
  const m = `<11>1 ${new Date().toISOString()} fw-1 filterlog ${process.pid} - - ${msg}`;
  const s = connect({ host, port: Number(port), rejectUnauthorized: false }, () => s.end(`${Buffer.byteLength(m)} ${m}`));
  s.on("error", (err) => console.error(`syslog: ${err.message}`));
}

const now = Date.now();
const history = Array.from({ length: 720 }, (_, i) => line(now - (720 - i) * 5_000));
console.log("an hour of history:", await send(history));
syslog("block in on igb0 from 203.0.113.7 to 10.0.0.5 port 22");
console.log(`now a few lines a second to ${base}; Ctrl-C stops`);
setInterval(() => {
  void send([line(Date.now()), line(Date.now())]).catch((err: unknown) => console.error(String(err)));
  if (n % 30 === 0) syslog(`block in on igb0 from 198.51.100.${n % 250} to 10.0.0.5 port 22`);
}, 1000);
