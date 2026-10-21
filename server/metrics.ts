// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();
const ingested = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

/** Lines taken in, by how they arrived: jsonline, elasticsearch, otlp, syslog or ssh. */
export function countIngest(via: string, lines: number) {
  ingested.set(via, (ingested.get(via) ?? 0) + lines);
}

export interface Gauges {
  sources: Record<string, number>;
  hosts: Record<string, number>;
  storedBytes: number | null;
  alertsFiring: number;
  victoriaLogsUp: boolean;
  victoriaLogsRestarts: number;
  syslog: { received: number; unmatched: number; connections: number; errors: number } | null;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="logs",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_logs_ingested_lines_total Lines taken in, before pipelines, by how they arrived.",
    "# TYPE openasy_logs_ingested_lines_total counter",
    ...[...ingested].map(([via, n]) => `openasy_logs_ingested_lines_total{via="${via}"} ${n}`),
    "# HELP openasy_logs_sources Sources by kind.",
    "# TYPE openasy_logs_sources gauge",
    ...Object.entries(g.sources).map(([k, n]) => `openasy_logs_sources{kind="${k}"} ${n}`),
    "# HELP openasy_logs_hosts Hosts read over SSH, by the status of their last read.",
    "# TYPE openasy_logs_hosts gauge",
    ...Object.entries(g.hosts).map(([s, n]) => `openasy_logs_hosts{status="${s}"} ${n}`),
    "# HELP openasy_logs_stored_bytes Disk used by stored logs.",
    "# TYPE openasy_logs_stored_bytes gauge",
    ...(g.storedBytes === null ? [] : [`openasy_logs_stored_bytes ${g.storedBytes}`]),
    "# HELP openasy_logs_alerts_firing Saved views over their threshold.",
    "# TYPE openasy_logs_alerts_firing gauge",
    `openasy_logs_alerts_firing ${g.alertsFiring}`,
    "# HELP openasy_logs_victorialogs_up Whether VictoriaLogs answers.",
    "# TYPE openasy_logs_victorialogs_up gauge",
    `openasy_logs_victorialogs_up ${g.victoriaLogsUp ? 1 : 0}`,
    "# HELP openasy_logs_victorialogs_restarts_total Times VictoriaLogs stopped and was started again.",
    "# TYPE openasy_logs_victorialogs_restarts_total counter",
    `openasy_logs_victorialogs_restarts_total ${g.victoriaLogsRestarts}`,
    ...(g.syslog
      ? [
          "# HELP openasy_logs_syslog_messages_total Syslog messages received, and those from an address no source takes.",
          "# TYPE openasy_logs_syslog_messages_total counter",
          `openasy_logs_syslog_messages_total{result="taken"} ${g.syslog.received}`,
          `openasy_logs_syslog_messages_total{result="unmatched"} ${g.syslog.unmatched}`,
          "# HELP openasy_logs_syslog_connections Open syslog connections.",
          "# TYPE openasy_logs_syslog_connections gauge",
          `openasy_logs_syslog_connections ${g.syslog.connections}`,
        ]
      : []),
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
