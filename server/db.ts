import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Configuration and state only (ADR 0011, 0035): the logs themselves are in VictoriaLogs.
// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Where logs come from. http sources send with their own ingest token (only its hash is kept); syslog sources are
   -- told apart by the networks they send from; ssh sources hold the hosts logs-agent reads. Each has its pipeline.
   CREATE TABLE sources (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK (kind IN ('http', 'syslog', 'ssh')),
     token_hash TEXT UNIQUE,
     networks TEXT NOT NULL DEFAULT '[]',
     -- Syslog without TLS on 514, for devices that cannot do better. Off unless set (ADR 0013).
     plain INTEGER NOT NULL DEFAULT 0,
     processors TEXT NOT NULL DEFAULT '[]',
     enabled INTEGER NOT NULL DEFAULT 1,
     lines_in INTEGER NOT NULL DEFAULT 0,
     lines_dropped INTEGER NOT NULL DEFAULT 0,
     last_seen_at TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL
   );
   -- logs-agent instances (ADR 0018, 0031), like infra-agent: a one-time token, then their own secret.
   CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     enroll_token_hash TEXT UNIQUE,
     enroll_expires_at TEXT,
     secret_hash TEXT UNIQUE,
     version TEXT,
     ca_public_key TEXT,
     key_public_key TEXT,
     setup TEXT,
     last_seen_at TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL
   );
   -- Hosts an agent reads over SSH. The cursors say where the last read stopped; they move only after its lines
   -- are stored, so a failed write is read again rather than lost.
   CREATE TABLE hosts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     agent_id TEXT NOT NULL REFERENCES agents (id),
     source_id TEXT NOT NULL REFERENCES sources (id),
     address TEXT NOT NULL,
     port INTEGER NOT NULL DEFAULT 22,
     ssh_user TEXT NOT NULL DEFAULT 'openasy',
     auth TEXT NOT NULL CHECK (auth IN ('certificate', 'key')),
     containers INTEGER NOT NULL DEFAULT 0,
     interval_seconds INTEGER NOT NULL DEFAULT 60,
     host_keys TEXT NOT NULL DEFAULT '[]',
     pending_host_keys TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'new',
     status_detail TEXT,
     unreadable TEXT NOT NULL DEFAULT '[]',
     journal_cursor TEXT,
     docker_since TEXT,
     lines_in INTEGER NOT NULL DEFAULT 0,
     last_attempt_at TEXT,
     last_success_at TEXT,
     read_requested INTEGER NOT NULL DEFAULT 0,
     key_requested INTEGER NOT NULL DEFAULT 1,
     lease_until TEXT,
     created_at TEXT NOT NULL
   );
   -- Saved LogsQL queries. A view with a threshold is checked every minute and calls its webhook when crossed.
   CREATE TABLE views (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     query TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     owner_name TEXT NOT NULL,
     shared INTEGER NOT NULL DEFAULT 1,
     alert_threshold INTEGER,
     alert_window_minutes INTEGER,
     alert_webhook_url TEXT,
     alert_secret_sealed TEXT,
     alert_state TEXT NOT NULL DEFAULT 'ok',
     alert_last_count INTEGER,
     alert_last_checked_at TEXT,
     alert_last_fired_at TEXT,
     alert_last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- Who searched for what (ADR 0015, 0035): logs hold personal data, so reading them is recorded.
   CREATE TABLE searches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     kind TEXT NOT NULL,
     query TEXT NOT NULL
   );
   CREATE INDEX searches_at ON searches (at)`,
  `-- Hosts from the hosts file (OPENASY_HOSTS, ADR 0052) are changed there, not here; origin says which. file_host_key is
   -- the fingerprint the file gives: a host that presents that key is trusted without an admin comparing it.
   ALTER TABLE hosts ADD COLUMN origin TEXT NOT NULL DEFAULT 'ui' CHECK (origin IN ('ui', 'file'));
   ALTER TABLE hosts ADD COLUMN file_host_key TEXT`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
