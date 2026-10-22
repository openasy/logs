import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, IconButton, navigate, PageHeader, Panel, SelectField, Switch, Tabs, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowDown, ArrowUp, Check, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { NewSource, Processor, Source, Syslog } from "./api.ts";
import { ago, Code, count, explore, List, Pairs, quote, useData, type Call } from "./shared.tsx";

const KIND = { http: "Sent over HTTP", syslog: "Syslog", ssh: "Read over SSH" } as const;

const STEPS: Record<Processor["type"], string> = {
  "parse-json": "Parse JSON in the message",
  "parse-regex": "Parse with a regular expression",
  "map-level": "Name the level alike",
  mask: "Mask what matches",
  "mask-secrets": "Mask passwords, tokens and keys",
  drop: "Drop lines",
  sample: "Keep a share of lines",
  set: "Set a field",
};

const blank = (type: Processor["type"]): Processor => {
  switch (type) {
    case "parse-regex":
      return { type, pattern: "" };
    case "mask":
      return { type, pattern: "" };
    case "drop":
      return { type, field: "msg", pattern: "" };
    case "sample":
      return { type, field: "msg", pattern: "", percent: 10 };
    case "set":
      return { type, field: "service", value: "" };
    default:
      return { type } as Processor;
  }
};

/** One step's settings; the fields depend on its type. */
function StepFields({ step, onChange }: { step: Processor; onChange: (p: Processor) => void }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch } as Processor);
  switch (step.type) {
    case "parse-regex":
      return <TextField label="Pattern, with named parts" mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="status=(?<status>\d{3}) (?<msg>.*)" className="min-w-0 grow" />;
    case "map-level":
      return <TextField label="From the field" mono value={step.field ?? "level"} onChange={(e) => set({ field: e.target.value })} />;
    case "mask":
      return (
        <>
          <TextField label="Pattern" mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="\b\d{16}\b" className="min-w-0 grow" />
          <TextField label="Replace with" mono value={step.replacement ?? "***"} onChange={(e) => set({ replacement: e.target.value })} />
        </>
      );
    case "drop":
    case "sample":
      return (
        <>
          <TextField label="Field" mono value={step.field} onChange={(e) => set({ field: e.target.value })} hint="msg is the message" />
          <TextField label="Matches" mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="^/healthz$" className="min-w-0 grow" />
          {step.type === "sample" && <TextField label="Keep %" type="number" min={1} max={99} value={String(step.percent)} onChange={(e) => set({ percent: Number(e.target.value) })} />}
        </>
      );
    case "set":
      return (
        <>
          <TextField label="Field" mono value={step.field} onChange={(e) => set({ field: e.target.value })} />
          <TextField label="Value" mono value={step.value} onChange={(e) => set({ value: e.target.value })} className="min-w-0 grow" />
        </>
      );
    default:
      return <span className="text-sm text-fg-muted">No settings.</span>;
  }
}

function PipelineEditor({ call, source, onSaved }: { call: Call; source: Source; onSaved: () => void }) {
  const { can } = useAuth();
  const [steps, setSteps] = useState<Processor[]>(source.processors);
  const [samples, setSamples] = useState('{"level":"ERR","msg":"payment failed","password":"hunter2"}\nGET /healthz 200');
  const [preview, setPreview] = useState<Array<{ kept: boolean; msg: string | null; fields: Record<string, string> }>>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState<Processor["type"]>("parse-json");
  useEffect(() => setSteps(source.processors), [source.processors]);
  const changed = JSON.stringify(steps) !== JSON.stringify(source.processors);
  const move = (i: number, d: -1 | 1) => setSteps((s) => {
    const next = [...s];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    return next;
  });
  const tryIt = async () => {
    try {
      setPreview((await call<{ results: typeof preview }>("/api/v1/pipelines/preview", { method: "POST", body: JSON.stringify({ processors: steps, lines: samples.split("\n").filter(Boolean).slice(0, 50) }) })).results);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const save = async () => {
    try {
      await call(`/api/v1/sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ processors: steps }) });
      setError(undefined);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title="Pipeline" description="Each line goes through these steps in order before it is stored. What is masked or dropped here never reaches the disk.">
      <ol className="logs-steps" aria-label={`Steps of ${source.name}`}>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-medium">{STEPS[s.type]}</span>
              <span className="flex flex-wrap items-end gap-2">
                <StepFields step={s} onChange={(p) => setSteps((all) => all.map((x, j) => (j === i ? p : x)))} />
              </span>
            </span>
            {can("admin") && (
              <span className="flex gap-0.5">
                <IconButton label={`Move step ${i + 1} up`} size="xs" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </IconButton>
                <IconButton label={`Move step ${i + 1} down`} size="xs" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </IconButton>
                <IconButton label={`Remove step ${i + 1}`} size="xs" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 />
                </IconButton>
              </span>
            )}
          </li>
        ))}
      </ol>
      {steps.length === 0 && <p className="text-sm text-fg-muted">No steps: lines are stored as they arrive.</p>}
      {can("admin") && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <SelectField label="Add a step" value={adding} onChange={(e) => setAdding(e.target.value as Processor["type"])} options={Object.entries(STEPS).map(([value, label]) => ({ value, label }))} />
          <Button icon={<Plus />} onClick={() => setSteps((s) => [...s, blank(adding)])}>
            Add
          </Button>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor={`samples-${source.id}`}>
          Try it on sample lines, one per line
        </label>
        <textarea id={`samples-${source.id}`} className="logs-textarea" value={samples} onChange={(e) => setSamples(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={() => void tryIt()}>Try</Button>
          {can("admin") && (
            <Button variant="primary" disabled={!changed} onClick={() => void save()}>
              Save pipeline
            </Button>
          )}
        </div>
        {error && (
          <Callout tone="danger" title="The pipeline has a problem">
            {error}
          </Callout>
        )}
        {preview && (
          <ul aria-label="What the pipeline makes of the samples" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {preview.map((r, i) => (
              <li key={i} className="rounded-md border border-line p-2 font-mono text-xs">
                {r.kept ? (
                  <>
                    <div className="logs-msg">{r.msg}</div>
                    <div className="text-fg-muted">{Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join("  ") || "no fields"}</div>
                  </>
                ) : (
                  <span className="text-fg-muted">dropped</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** How to send to an http source, for the shippers people already run. */
/** `bare` leaves out the panel, for the dialog that shows a new source's token. */
function HttpSetup({ token, bare }: { token?: string; bare?: boolean }) {
  const base = window.location.origin;
  const host = window.location.hostname;
  const t = token ?? "<the token of this source>";
  const [tab, setTab] = useState<"curl" | "vector" | "fluentbit" | "otel" | "beats">("vector");
  const snippets = {
    curl: `curl -H "Authorization: Bearer ${t}" \\\n  --data-binary '{"msg":"hello from curl","service":"demo","level":"info"}' \\\n  ${base}/api/v1/ingest/jsonline`,
    vector: `[sinks.openasy_logs]\ntype = "http"\ninputs = ["your_source"]\nuri = "${base}/api/v1/ingest/jsonline"\nencoding.codec = "json"\nframing.method = "newline_delimited"\ncompression = "gzip"\nauth.strategy = "bearer"\nauth.token = "${t}"`,
    fluentbit: `[OUTPUT]\n    Name      http\n    Match     *\n    Host      ${host}\n    Port      443\n    tls       On\n    URI       /api/v1/ingest/jsonline\n    Format    json_lines\n    compress  gzip\n    Header    Authorization Bearer ${t}`,
    otel: `exporters:\n  otlphttp/openasy:\n    logs_endpoint: ${base}/api/v1/ingest/otlp/v1/logs\n    headers:\n      Authorization: Bearer ${t}\n\nservice:\n  pipelines:\n    logs:\n      exporters: [otlphttp/openasy]`,
    beats: `# winlogbeat.yml or filebeat.yml\noutput.elasticsearch:\n  hosts: ["${base}/api/v1/ingest/elasticsearch"]\n  username: "openasy"\n  password: "${t}"\nsetup.template.enabled: false\nsetup.ilm.enabled: false`,
  };
  const tabs = (
    <>
      <Tabs
        label="Shipper"
        value={tab}
        onChange={setTab}
        items={[
          { value: "vector", label: "Vector" },
          { value: "fluentbit", label: "Fluent Bit" },
          { value: "otel", label: "OpenTelemetry" },
          { value: "beats", label: "Winlogbeat, Filebeat" },
          { value: "curl", label: "curl" },
        ]}
      />
      <div className="mt-3">
        <Code label={`Configuration for ${tab}`}>{snippets[tab]}</Code>
      </div>
    </>
  );
  if (bare) return tabs;
  return (
    <Panel title="Send to this source" description="Use the shipper you already run. Every request carries the source's token; gzip is welcome.">
      {tabs}
    </Panel>
  );
}

function SyslogSetup({ call, source }: { call: Call; source: Source }) {
  const s = useData<Syslog>(call, "/api/v1/syslog", 0);
  const host = window.location.hostname;
  if (s.error) return <Callout tone="warning" title="Syslog is switched off">{s.error} Start Logs without LOGS_SYSLOG=false to take syslog.</Callout>;
  if (!s.data) return null;
  const rsyslog = `# /etc/rsyslog.d/90-openasy-logs.conf (needs the rsyslog-gnutls package)
global(DefaultNetstreamDriverCAFile="/etc/rsyslog.d/openasy-logs.pem")
*.* action(type="omfwd" target="${host}" port="${s.data.tlsPort}" protocol="tcp"
           StreamDriver="gtls" StreamDriverMode="1"
           StreamDriverAuthMode="x509/name" StreamDriverPermittedPeers="${host}"
           TCP_Framing="octet-counted" template="RSYSLOG_SyslogProtocol23Format"
           queue.type="LinkedList" queue.filename="openasy" action.resumeRetryCount="-1")`;
  return (
    <Panel title="Send syslog" description={`From ${source.networks.join(", ")}. Syslog carries no token: the address a message comes from says which source it belongs to.`}>
      <div className="flex flex-col gap-3">
        <Pairs
          items={[
            ["TLS", `${host}:${s.data.tlsPort}, TCP, RFC 5424 or RFC 3164, octet-counted or one message per line`],
            ["Plain", source.plain ? `${host}:${s.data.plainPort}, TCP and UDP` : "Off for this source"],
            ["Certificate", <span className="logs-wrap font-mono text-xs">{s.data.fingerprint}</span>],
          ]}
        />
        <Code label="rsyslog configuration">{rsyslog}</Code>
        <Code label="The certificate, as /etc/rsyslog.d/openasy-logs.pem">{s.data.certificate.trim()}</Code>
        {s.data.origin === "generated" && (
          <Callout tone="info" title="Logs made this certificate">
            Senders trust it because you copy it to them. To use one from your own CA, mount it and set LOGS_SYSLOG_TLS_CERT_FILE and LOGS_SYSLOG_TLS_KEY_FILE.
          </Callout>
        )}
      </div>
    </Panel>
  );
}

export function SourcePage({ call, id }: { call: Call; id: string }) {
  const { can } = useAuth();
  const { data: s, reload } = useData<Source>(call, `/api/v1/sources/${id}`, 30_000);
  const [token, setToken] = useState<string>();
  const [networks, setNetworks] = useState<string>();
  const [error, setError] = useState<string>();
  if (!s) return null;
  const patch = async (body: Record<string, unknown>) => {
    try {
      await call(`/api/v1/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      setError(undefined);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <PageHeader
        title={s.name}
        breadcrumbs={[{ label: "Sources", href: "/sources" }]}
        description={KIND[s.kind]}
        meta={!s.enabled && <Badge tone="neutral">Off</Badge>}
        actions={
          <>
            <Button onClick={() => navigate(explore(`source:${quote(s.name)}`))}>Show its lines</Button>
            {can("admin") && s.kind === "http" && (
              <Button icon={<RotateCw />} onClick={() => window.confirm("A new token? The current one stops working at once.") && void call<NewSource>(`/api/v1/sources/${id}/token`, { method: "POST" }).then((r) => setToken(r.token))}>
                New token
              </Button>
            )}
          </>
        }
      />
      {token && (
        <Dialog
          open
          onOpenChange={(open) => !open && setToken(undefined)}
          icon={<Check aria-hidden className="size-4" />}
          iconTone="success"
          title={`The new token of ${s.name}`}
          description="It is shown once. Put it where the old one was; the old one no longer works."
          footer={
            <Button variant="primary" onClick={() => setToken(undefined)}>
              Done
            </Button>
          }
        >
          <Code label="Ingest token">{token}</Code>
          <Callout tone="warning" title="Closing this dialog hides the token" />
        </Dialog>
      )}
      {error && (
        <Callout tone="danger" title="Not changed">
          {error}
        </Callout>
      )}
      <Panel>
        <div className="flex flex-col gap-3">
          <Pairs
            items={[
              ["Lines taken", count(s.linesIn)],
              ["Dropped by the pipeline", count(s.linesDropped)],
              ["Last line", ago(s.lastSeenAt)],
              ...(s.lastError ? ([["Last error", s.lastError]] as Array<[string, string]>) : []),
              ...(s.kind === "ssh" ? ([["Hosts", <a href="/hosts">{s.hosts ?? 0}</a>]] as Array<[string, ReactNode]>) : []),
            ]}
          />
          {can("admin") && <Switch label="Take lines" description="Off: senders are refused and nothing is stored." checked={s.enabled} onCheckedChange={(v) => void patch({ enabled: v })} />}
          {can("admin") && s.kind === "syslog" && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <TextField label="Networks it takes" mono value={networks ?? s.networks.join(", ")} onChange={(e) => setNetworks(e.target.value)} hint="Addresses or networks, separated by commas" className="min-w-0 grow" />
                <Button disabled={networks === undefined} onClick={() => void patch({ networks: (networks ?? "").split(/[\s,]+/).filter(Boolean) }).then(() => setNetworks(undefined))}>
                  Save networks
                </Button>
              </div>
              <Switch label="Also plain TCP and UDP" description="For devices that cannot do TLS. Anyone on these networks can then send, and read nothing back." checked={s.plain} onCheckedChange={(v) => void patch({ plain: v })} />
            </>
          )}
        </div>
      </Panel>
      {s.kind === "http" && <HttpSetup />}
      {s.kind === "syslog" && <SyslogSetup call={call} source={s} />}
      {s.kind === "ssh" && (
        <Callout tone="info" title="Hosts read over SSH">
          logs-agent reads journald and Docker on the hosts under <a href="/hosts">Hosts</a>, and their lines go through this pipeline.
        </Callout>
      )}
      <PipelineEditor call={call} source={s} onSaved={reload} />
    </>
  );
}

function AddSource({ call, onAdded, onCancel }: { call: Call; onAdded: (r: NewSource) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Source["kind"]>("http");
  const [name, setName] = useState("");
  const [networks, setNetworks] = useState("");
  const [plain, setPlain] = useState(false);
  const [error, setError] = useState<string>();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { kind, name, ...(kind === "syslog" && { networks: networks.split(/[\s,]+/).filter(Boolean), plain }) };
      onAdded(await call<NewSource>("/api/v1/sources", { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title="Add a source"
      description="One for each way logs reach you. Each source has its own pipeline."
      onSubmit={add}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name || (kind === "syslog" && !networks.trim())}>
            Add source
          </Button>
        </>
      }
    >
      <SelectField label="Logs come" value={kind} onChange={(e) => setKind(e.target.value as Source["kind"])} options={[{ value: "http", label: "Sent over HTTP: Vector, Fluent Bit, OpenTelemetry, Beats" }, { value: "syslog", label: "By syslog: servers, firewalls, switches" }, { value: "ssh", label: "Read over SSH by logs-agent" }]} />
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "syslog" ? "network" : "apps"} hint="Stored as the source field of each line" error={error} />
      {kind === "syslog" && (
        <>
          <TextField label="Networks it takes" mono value={networks} onChange={(e) => setNetworks(e.target.value)} placeholder="10.0.0.0/8, 192.0.2.10" hint="Syslog carries no token: only these senders are taken." />
          <Checkbox label="Also plain TCP and UDP" description="Off: TLS only." checked={plain} onChange={(e) => setPlain(e.target.checked)} />
        </>
      )}
    </Dialog>
  );
}

export function SourcesPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ sources: Source[] }>(call, "/api/v1/sources", 15_000);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<NewSource>();
  const cols: Column<Source>[] = [
    { id: "name", header: "Source", cell: (s) => <a href={`/sources/${s.id}`}>{s.name}</a>, sortValue: (s) => s.name },
    { id: "kind", header: "How", width: "150px", cell: (s) => KIND[s.kind] },
    { id: "on", header: "", width: "60px", cell: (s) => !s.enabled && <Badge tone="neutral">Off</Badge> },
    { id: "lines", header: "Lines taken", width: "110px", align: "right", mono: true, cell: (s) => count(s.linesIn), sortValue: (s) => s.linesIn },
    { id: "dropped", header: "Dropped", width: "90px", align: "right", mono: true, cell: (s) => count(s.linesDropped) },
    { id: "seen", header: "Last line", width: "110px", cell: (s) => <span title={s.lastError ?? undefined}>{ago(s.lastSeenAt)}</span> },
    { id: "steps", header: "Pipeline", cell: (s) => <span className="text-xs text-fg-muted">{s.processors.map((p) => p.type).join(" → ") || "none"}</span> },
  ];
  return (
    <>
      <PageHeader
        title="Sources"
        description="Where logs come from: sent by shippers with a token, by syslog from known networks, or read over SSH. Each source has its pipeline."
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add source
            </Button>
          )
        }
      />
      {adding && (
        <AddSource
          call={call}
          onAdded={(r) => {
            setAdding(false);
            reload();
            // Syslog and SSH sources have no token to show: their page says how to send to them.
            if (r.token) setCreated(r);
            else navigate(`/sources/${r.source.id}`);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {created?.token && (
        <Dialog
          open
          onOpenChange={(open) => !open && setCreated(undefined)}
          size="lg"
          icon={<Check aria-hidden className="size-4" />}
          iconTone="success"
          title={`${created.source.name} is added. Copy its token`}
          description="It is shown once. The snippets already hold it; use the shipper you already run."
          footer={
            <Button variant="primary" onClick={() => setCreated(undefined)}>
              Done
            </Button>
          }
        >
          <Code label="Ingest token">{created.token}</Code>
          <HttpSetup token={created.token} bare />
          <Callout tone="warning" title="Closing this dialog hides the token">
            If it is lost, make a new one on the source's page.
          </Callout>
        </Dialog>
      )}
      {data?.sources.length === 0 ? (
        <EmptyState title="No sources yet">Add one for each way logs reach you: shippers over HTTP, syslog from devices, or hosts read over SSH.</EmptyState>
      ) : (
        <Panel flush>
          <List label="Sources" rows={data?.sources} columns={cols} empty="No sources" getRowId={(s) => s.id} />
        </Panel>
      )}
    </>
  );
}
