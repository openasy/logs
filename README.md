# logs

[![CI](https://github.com/openasy/logs/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/logs/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Logs product: search what happened on every host and service. Logs are sent
to it, or read over SSH by [logs-agent](https://github.com/openasy/logs-agent). **Nothing is installed on the hosts**
(ADR 0031, 0035).

```
hosts ── Syslog (TLS), OpenTelemetry, Loki, Elasticsearch bulk, JSON lines ──▶ logs (pipelines, UI, API)
                                                                                 │  VictoriaLogs inside, on 127.0.0.1
hosts ◀── SSH, 5-minute certificate ── logs-agent ── asks for jobs, sends lines ──┘
```

Storage is [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/), started by Logs as a child process in the
same container. Nobody reaches it directly: every read and write goes through Logs, which checks roles and tokens and
keeps an audit log of searches. Searches are written in LogsQL.

## Run

```bash
openssl rand -hex 32 > openasy-kek
openssl rand -hex 32 > openasy-agent-kek
docker compose up -d logs
docker compose logs logs | grep 'no owner yet'
# then in the UI: Settings, Agents, Add agent, and with the token it shows:
LOGS_ENROLL_TOKEN=... docker compose up -d logs-agent
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts ingest tokens and sign-in secrets in Logs' database; `openasy-agent-kek` encrypts the agent's
SSH certificate authority, keys and secret on its volume (ADR 0021). Keep each apart from its volume and with your
backups. Neither starts without its key.

## Getting logs in

Receivers are off until you enable them under Sources, each with its own ingest token. Syslog over TLS (RFC 5424 and
3164) listens on 6514, with a certificate you mount or one Logs makes and shows the fingerprint of. Plain Syslog is a
separate switch, off by default. OpenTelemetry logs over HTTP and the Loki push, Elasticsearch bulk and JSON lines
formats work with Vector, Fluent Bit, Promtail, Winlogbeat and OpenTelemetry collectors using their own outputs.

Hosts that send nothing are read by logs-agent: it runs `journalctl` and, where you allow it, `docker logs` as the
unprivileged `openasy` account with 5-minute SSH certificates, about once a minute. Reading the whole system journal
needs that account in the `systemd-journal` group; without it only its own journal is readable and the UI says so.
Hosts are prepared as for Infrastructure (see the [infra README](https://github.com/openasy/infra#prepare-a-host)).
Values that look like passwords, tokens or keys are masked before they leave the network.

Hosts can also come from the install's hosts file, the same file Infrastructure reads (ADR 0052): mount it and set
`OPENASY_HOSTS`. Logs reads `name`, `address`, `port`, `user`, `auth`, `containers`, `agent` and `hostKey` (see the
[infra README](https://github.com/openasy/infra#from-a-file)); a host that presents the key `hostKey` names is
trusted without an admin. Logs reaches hosts directly, so an entry with `jump` is left out with a warning. Hosts
from the file show **From file** and are changed there; the API answers 409 to a change or delete. A file with a
mistake is not applied at all, and the Hosts page and the log say what to fix.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `LOGS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `OPENASY_HOSTS` | | A YAML file of hosts to read, shared with Infrastructure; see [Getting logs in](#getting-logs-in) |
| `LOGS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `LOGS_DATA` | `/data` | SQLite file and VictoriaLogs' storage |
| `LOGS_SYSLOG` | `true` | `false` turns every Syslog receiver off |
| `LOGS_SYSLOG_TLS_PORT` | `6514` | Syslog over TLS |
| `LOGS_SYSLOG_PORT` | `1514` | Plain Syslog over TCP and UDP, when switched on |
| `LOGS_SYSLOG_TLS_CERT_FILE`, `LOGS_SYSLOG_TLS_KEY_FILE` | | Your own Syslog certificate and key |
| `LOGS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `LOGS_HEADLESS` | `false` | `true` serves only the API |
| `LOGS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

Retention (30 days by default) and the disk limit are set under Settings; when the disk is nearly full the oldest days
go first. Logs holds personal data and sometimes secrets: anyone with the viewer role reads every log it keeps.

Both containers run as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Develop

```bash
npm install
npm test        # fetches the pinned VictoriaLogs binary, then unit and contract tests
node scripts/openapi.ts   # after changing the API: rewrites openapi.json
```

## Licence

AGPL-3.0 (ADR 0008).
