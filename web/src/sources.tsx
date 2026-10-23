import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, IconButton, navigate, PageHeader, Panel, SelectField, Switch, Tabs, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowDown, ArrowUp, Check, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { NewSource, Processor, Source, Syslog } from "./api.ts";
import { Code, count, explore, List, Pairs, quote, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const KIND = (t: T) => ({ http: t("kind.sentOverHttp"), syslog: "Syslog", ssh: t("kind.readOverSsh") } as const);

const STEPS = (t: T): Record<Processor["type"], string> => ({
  "parse-json": "Parse JSON in the message",
  "parse-regex": t("steps.parseWithARegularExpression"),
  "map-level": t("steps.nameTheLevelAlike"),
  mask: t("steps.maskWhatMatches"),
  "mask-secrets": t("steps.maskPasswordsTokensAndKeys"),
  drop: t("steps.dropLines"),
  sample: t("steps.keepAShareOfLines"),
  set: t("steps.setAField"),
});

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
  const t = useT();
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch } as Processor);
  switch (step.type) {
    case "parse-regex":
      return <TextField label={t("stepFields.patternWithNamedParts")} mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="status=(?<status>\d{3}) (?<msg>.*)" className="min-w-0 grow" />;
    case "map-level":
      return <TextField label={t("stepFields.fromTheField")} mono value={step.field ?? "level"} onChange={(e) => set({ field: e.target.value })} />;
    case "mask":
      return (
        <>
          <TextField label={t("stepFields.pattern")} mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="\b\d{16}\b" className="min-w-0 grow" />
          <TextField label={t("stepFields.replaceWith")} mono value={step.replacement ?? "***"} onChange={(e) => set({ replacement: e.target.value })} />
        </>
      );
    case "drop":
    case "sample":
      return (
        <>
          <TextField label={t("stepFields.field")} mono value={step.field} onChange={(e) => set({ field: e.target.value })} hint={t("stepFields.msgIsTheMessage")} />
          <TextField label={t("stepFields.matches")} mono value={step.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="^/healthz$" className="min-w-0 grow" />
          {step.type === "sample" && <TextField label={t("stepFields.keep")} type="number" min={1} max={99} value={String(step.percent)} onChange={(e) => set({ percent: Number(e.target.value) })} />}
        </>
      );
    case "set":
      return (
        <>
          <TextField label={t("stepFields.field")} mono value={step.field} onChange={(e) => set({ field: e.target.value })} />
          <TextField label={t("stepFields.value")} mono value={step.value} onChange={(e) => set({ value: e.target.value })} className="min-w-0 grow" />
        </>
      );
    default:
      return <span className="text-sm text-fg-muted">{t("stepFields.noSettings")}</span>;
  }
}

function PipelineEditor({ call, source, onSaved }: { call: Call; source: Source; onSaved: () => void }) {
  const t = useT();
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
    <Panel title={t("pipelineEditor.pipeline")} description={t("pipelineEditor.eachLineGoesThroughThese")}>
      <ol className="logs-steps" aria-label={t("pipelineEditor.stepsOf", { name: source.name })}>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-medium">{STEPS(t)[s.type]}</span>
              <span className="flex flex-wrap items-end gap-2">
                <StepFields step={s} onChange={(p) => setSteps((all) => all.map((x, j) => (j === i ? p : x)))} />
              </span>
            </span>
            {can("admin") && (
              <span className="flex gap-0.5">
                <IconButton label={t("pipelineEditor.moveStepUp", { value: i + 1 })} size="xs" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </IconButton>
                <IconButton label={t("pipelineEditor.moveStepDown", { value: i + 1 })} size="xs" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </IconButton>
                <IconButton label={t("pipelineEditor.removeStep", { value: i + 1 })} size="xs" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 />
                </IconButton>
              </span>
            )}
          </li>
        ))}
      </ol>
      {steps.length === 0 && <p className="text-sm text-fg-muted">{t("pipelineEditor.noStepsLinesAreStored")}</p>}
      {can("admin") && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <SelectField label={t("pipelineEditor.addAStep")} value={adding} onChange={(e) => setAdding(e.target.value as Processor["type"])} options={Object.entries(STEPS(t)).map(([value, label]) => ({ value, label }))} />
          <Button icon={<Plus />} onClick={() => setSteps((s) => [...s, blank(adding)])}>
            {t("pipelineEditor.add")}
          </Button>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor={`samples-${source.id}`}>
          {t("pipelineEditor.tryItOnSampleLines")}
        </label>
        <textarea id={`samples-${source.id}`} className="logs-textarea" value={samples} onChange={(e) => setSamples(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={() => void tryIt()}>{t("pipelineEditor.try")}</Button>
          {can("admin") && (
            <Button variant="primary" disabled={!changed} onClick={() => void save()}>
              {t("pipelineEditor.savePipeline")}
            </Button>
          )}
        </div>
        {error && (
          <Callout tone="danger" title={t("pipelineEditor.thePipelineHasAProblem")}>
            {error}
          </Callout>
        )}
        {preview && (
          <ul aria-label={t("pipelineEditor.whatThePipelineMakesOf")} className="m-0 flex list-none flex-col gap-1.5 p-0">
            {preview.map((r, i) => (
              <li key={i} className="rounded-md border border-line p-2 font-mono text-xs">
                {r.kept ? (
                  <>
                    <div className="logs-msg">{r.msg}</div>
                    <div className="text-fg-muted">{Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join("  ") || t("pipelineEditor.noFields")}</div>
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
  const msg = useT();
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
        label={msg("httpSetup.shipper")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "vector", label: msg("httpSetup.vector") },
          { value: "fluentbit", label: msg("httpSetup.fluentBit") },
          { value: "otel", label: "OpenTelemetry" },
          { value: "beats", label: msg("httpSetup.winlogbeatFilebeat") },
          { value: "curl", label: "curl" },
        ]}
      />
      <div className="mt-3">
        <Code label={msg("httpSetup.configurationFor", { tab })}>{snippets[tab]}</Code>
      </div>
    </>
  );
  if (bare) return tabs;
  return (
    <Panel title={msg("httpSetup.sendToThisSource")} description={msg("httpSetup.useTheShipperYouAlready")}>
      {tabs}
    </Panel>
  );
}

function SyslogSetup({ call, source }: { call: Call; source: Source }) {
  const t = useT();
  const s = useData<Syslog>(call, "/api/v1/syslog", 0);
  const host = window.location.hostname;
  if (s.error) return <Callout tone="warning" title={t("syslogSetup.syslogIsSwitchedOff")}>{t("syslogSetup.startLogsWithoutLogsSyslog", { error: s.error })}</Callout>;
  if (!s.data) return null;
  const rsyslog = `# /etc/rsyslog.d/90-openasy-logs.conf (needs the rsyslog-gnutls package)
global(DefaultNetstreamDriverCAFile="/etc/rsyslog.d/openasy-logs.pem")
*.* action(type="omfwd" target="${host}" port="${s.data.tlsPort}" protocol="tcp"
           StreamDriver="gtls" StreamDriverMode="1"
           StreamDriverAuthMode="x509/name" StreamDriverPermittedPeers="${host}"
           TCP_Framing="octet-counted" template="RSYSLOG_SyslogProtocol23Format"
           queue.type="LinkedList" queue.filename="openasy" action.resumeRetryCount="-1")`;
  return (
    <Panel title={t("syslogSetup.sendSyslog")} description={t("syslogSetup.fromSyslogCarriesNoToken", { value: source.networks.join(", ") })}>
      <div className="flex flex-col gap-3">
        <Pairs
          items={[
            ["TLS", `${host}:${s.data.tlsPort}, TCP, RFC 5424 or RFC 3164, octet-counted or one message per line`],
            ["Plain", source.plain ? `${host}:${s.data.plainPort}, TCP and UDP` : "Off for this source"],
            ["Certificate", <span className="logs-wrap font-mono text-xs">{s.data.fingerprint}</span>],
          ]}
        />
        <Code label={t("syslogSetup.rsyslogConfiguration")}>{rsyslog}</Code>
        <Code label={t("syslogSetup.theCertificateAsEtcRsyslog")}>{s.data.certificate.trim()}</Code>
        {s.data.origin === "generated" && (
          <Callout tone="info" title={t("syslogSetup.logsMadeThisCertificate")}>
            {t("syslogSetup.sendersTrustItBecauseYou")}
          </Callout>
        )}
      </div>
    </Panel>
  );
}

export function SourcePage({ call, id }: { call: Call; id: string }) {
  const ago = useAgo();
  const t = useT();
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
        breadcrumbs={[{ label: t("sourcePage.sources"), href: "/sources" }]}
        description={KIND(t)[s.kind]}
        meta={!s.enabled && <Badge tone="neutral">{t("sourcePage.off")}</Badge>}
        actions={
          <>
            <Button onClick={() => navigate(explore(`source:${quote(s.name)}`))}>{t("sourcePage.showItsLines")}</Button>
            {can("admin") && s.kind === "http" && (
              <Button icon={<RotateCw />} onClick={() => window.confirm(t("sourcePage.aNewTokenTheCurrent")) && void call<NewSource>(`/api/v1/sources/${id}/token`, { method: "POST" }).then((r) => setToken(r.token))}>
                {t("sourcePage.newToken")}
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
          title={t("sourcePage.theNewTokenOf", { name: s.name })}
          description={t("sourcePage.itIsShownOncePut")}
          footer={
            <Button variant="primary" onClick={() => setToken(undefined)}>
              {t("sourcePage.done")}
            </Button>
          }
        >
          <Code label={t("sourcePage.ingestToken")}>{token}</Code>
          <Callout tone="warning" title={t("sourcePage.closingThisDialogHidesThe")} />
        </Dialog>
      )}
      {error && (
        <Callout tone="danger" title={t("sourcePage.notChanged")}>
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
          {can("admin") && <Switch label={t("sourcePage.takeLines")} description={t("sourcePage.offSendersAreRefusedAnd")} checked={s.enabled} onCheckedChange={(v) => void patch({ enabled: v })} />}
          {can("admin") && s.kind === "syslog" && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <TextField label={t("sourcePage.networksItTakes")} mono value={networks ?? s.networks.join(", ")} onChange={(e) => setNetworks(e.target.value)} hint={t("sourcePage.addressesOrNetworksSeparatedBy")} className="min-w-0 grow" />
                <Button disabled={networks === undefined} onClick={() => void patch({ networks: (networks ?? "").split(/[\s,]+/).filter(Boolean) }).then(() => setNetworks(undefined))}>
                  {t("sourcePage.saveNetworks")}
                </Button>
              </div>
              <Switch label={t("sourcePage.alsoPlainTcpAndUdp")} description={t("sourcePage.forDevicesThatCannotDo")} checked={s.plain} onCheckedChange={(v) => void patch({ plain: v })} />
            </>
          )}
        </div>
      </Panel>
      {s.kind === "http" && <HttpSetup />}
      {s.kind === "syslog" && <SyslogSetup call={call} source={s} />}
      {s.kind === "ssh" && (
        <Callout tone="info" title={t("sourcePage.hostsReadOverSsh")}>
          {t("sourcePage.logsAgentReadsJournaldAnd")}{" "}<a href="/hosts">{t("sourcePage.hosts")}</a>{t("sourcePage.andTheirLinesGoThrough")}
        </Callout>
      )}
      <PipelineEditor call={call} source={s} onSaved={reload} />
    </>
  );
}

function AddSource({ call, onAdded, onCancel }: { call: Call; onAdded: (r: NewSource) => void; onCancel: () => void }) {
  const t = useT();
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
      title={t("addSource.addASource")}
      description={t("addSource.oneForEachWayLogs")}
      onSubmit={add}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            {t("addSource.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name || (kind === "syslog" && !networks.trim())}>
            {t("addSource.addSource")}
          </Button>
        </>
      }
    >
      <SelectField label={t("addSource.logsCome")} value={kind} onChange={(e) => setKind(e.target.value as Source["kind"])} options={[{ value: "http", label: t("addSource.sentOverHttpVectorFluent") }, { value: "syslog", label: t("addSource.bySyslogServersFirewallsSwitches") }, { value: "ssh", label: t("addSource.readOverSshByLogs") }]} />
      <TextField label={t("addSource.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "syslog" ? "network" : "apps"} hint={t("addSource.storedAsTheSourceField")} error={error} />
      {kind === "syslog" && (
        <>
          <TextField label={t("addSource.networksItTakes")} mono value={networks} onChange={(e) => setNetworks(e.target.value)} placeholder="10.0.0.0/8, 192.0.2.10" hint={t("addSource.syslogCarriesNoTokenOnly")} />
          <Checkbox label={t("addSource.alsoPlainTcpAndUdp")} description={t("addSource.offTlsOnly")} checked={plain} onChange={(e) => setPlain(e.target.checked)} />
        </>
      )}
    </Dialog>
  );
}

export function SourcesPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ sources: Source[] }>(call, "/api/v1/sources", 15_000);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<NewSource>();
  const cols: Column<Source>[] = [
    { id: "name", header: t("sourcesPage.source"), cell: (s) => <a href={`/sources/${s.id}`}>{s.name}</a>, sortValue: (s) => s.name },
    { id: "kind", header: t("sourcesPage.how"), width: "150px", cell: (s) => KIND(t)[s.kind] },
    { id: "on", header: "", width: "60px", cell: (s) => !s.enabled && <Badge tone="neutral">{t("sourcesPage.off")}</Badge> },
    { id: "lines", header: t("sourcesPage.linesTaken"), width: "110px", align: "right", mono: true, cell: (s) => count(s.linesIn), sortValue: (s) => s.linesIn },
    { id: "dropped", header: t("sourcesPage.dropped"), width: "90px", align: "right", mono: true, cell: (s) => count(s.linesDropped) },
    { id: "seen", header: t("sourcesPage.lastLine"), width: "110px", cell: (s) => <span title={s.lastError ?? undefined}>{ago(s.lastSeenAt)}</span> },
    { id: "steps", header: t("sourcesPage.pipeline"), cell: (s) => <span className="text-xs text-fg-muted">{s.processors.map((p) => p.type).join(" → ") || "none"}</span> },
  ];
  return (
    <>
      <PageHeader
        title={t("sourcesPage.sources")}
        description={t("sourcesPage.whereLogsComeFromSent")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("sourcesPage.addSource")}
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
          title={t("sourcesPage.isAddedCopyItsToken", { name: created.source.name })}
          description={t("sourcesPage.itIsShownOnceThe")}
          footer={
            <Button variant="primary" onClick={() => setCreated(undefined)}>
              {t("sourcesPage.done")}
            </Button>
          }
        >
          <Code label={t("sourcesPage.ingestToken")}>{created.token}</Code>
          <HttpSetup token={created.token} bare />
          <Callout tone="warning" title={t("sourcesPage.closingThisDialogHidesThe")}>
            {t("sourcesPage.ifItIsLostMake")}
          </Callout>
        </Dialog>
      )}
      {data?.sources.length === 0 ? (
        <EmptyState title={t("sourcesPage.noSourcesYet")}>{t("sourcesPage.addOneForEachWay")}</EmptyState>
      ) : (
        <Panel flush>
          <List label={t("sourcesPage.sources")} rows={data?.sources} columns={cols} empty={t("sourcesPage.noSources")} getRowId={(s) => s.id} />
        </Panel>
      )}
    </>
  );
}
