// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json and server/.
import type { Processor } from "../../server/pipeline.ts";
import type { ProductLink } from "../../server/products.ts";

export type { Processor, ProductLink };

export interface Line {
  time: string;
  msg: string;
  level: string | null;
  host: string | null;
  service: string | null;
  source: string | null;
  fields: Record<string, string>;
}

export interface Search {
  lines: Line[];
  start: string;
  end: string;
  truncated: boolean;
}

export interface Volume {
  step: string;
  times: string[];
  series: Array<{ level: string; values: number[]; total: number }>;
}

export interface Facets {
  fields: Array<{ field: string; values: Array<{ value: string; hits: number }> }>;
}

export interface Alert {
  threshold: number;
  windowMinutes: number;
  webhookUrl: string;
  state: "ok" | "firing" | "error";
  lastCount: number | null;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
}

export interface View {
  id: string;
  name: string;
  query: string;
  owner: { id: string; name: string };
  shared: boolean;
  alert: Alert | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewView {
  view: View;
  webhookSecret?: string;
}

export interface Source {
  id: string;
  name: string;
  kind: "http" | "syslog" | "ssh";
  networks: string[];
  plain: boolean;
  processors: Processor[];
  enabled: boolean;
  linesIn: number;
  linesDropped: number;
  lastSeenAt: string | null;
  lastError: string | null;
  hosts: number | null;
  createdAt: string;
}

export interface NewSource {
  source: Source;
  token?: string;
}

export interface Syslog {
  tlsPort: number;
  plainPort: number;
  fingerprint: string;
  certificate: string;
  origin: "file" | "generated";
}

export interface HostKey {
  type: string;
  fingerprint: string;
}

export interface Host {
  id: string;
  name: string;
  agent: { id: string; name: string };
  source: { id: string; name: string };
  address: string;
  port: number;
  user: string;
  auth: "certificate" | "key";
  containers: boolean;
  intervalSeconds: number;
  hostKeys: HostKey[];
  pendingHostKeys: HostKey[];
  status: string;
  statusDetail: string | null;
  unreadable: string[];
  linesIn: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  status: "waiting-to-enrol" | "online" | "offline" | "version-mismatch";
  version: string | null;
  caFingerprint: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  hosts: number;
  createdAt: string;
}

export interface NewAgent {
  agent: Agent;
  enrollToken: string;
  enrollExpiresAt: string;
}

export interface AgentSetup {
  agent: Agent;
  caPublicKey: string;
  caFingerprint: string;
  keyPublicKey: string | null;
  sshdConfig: string;
  hostSetup: string;
  authorizedKey: string;
}

export interface Settings {
  retentionDays: number;
  maxDiskGb: number;
}

export interface Summary extends Settings {
  sources: Record<string, number>;
  agents: Record<string, number>;
  hosts: Record<string, number>;
  linesLastHour: number | null;
  storedBytes: number | null;
  alertsFiring: number;
}

export interface SearchRecord {
  id: number;
  at: string;
  actor: string;
  kind: "search" | "tail";
  query: string;
}

export class Unauthorized extends Error {}
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
