import { Badge, Button, Callout, Dialog, EmptyState, navigate, PageHeader, Panel, SelectField, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, AgentSetup, Host, Summary } from "./api.ts";
import { Code, count, explore, List, quote, Status, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

// What to write in the hosts file (ADR 0052), shown where there is nothing yet.
const EXAMPLE = `hosts:
  - name: web-1
    address: 10.0.0.5
    agent: dc1
    containers: true`;

/** The entries of the hosts file for hosts added here before it was the way in. */
function toYaml(hosts: Host[]): string {
  const entry = (h: Host) => {
    const lines = [`  - name: ${h.name}`, `    address: ${h.address}`, `    agent: ${h.agent.name}`];
    if (h.port !== 22) lines.push(`    port: ${h.port}`);
    if (h.user !== "openasy") lines.push(`    user: ${h.user}`);
    if (h.auth === "key") lines.push("    auth: key");
    if (h.containers) lines.push("    containers: true");
    return lines.join("\n");
  };
  return ["hosts:", ...hosts.map(entry)].join("\n");
}

function KeyCheck({ call, host, onDone }: { call: Call; host: Host; onDone: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const key = host.pendingHostKeys[0];
  if (!key) return null;
  return (
    <Callout
      tone={host.status === "host-key-changed" ? "danger" : "warning"}
      title={host.status === "host-key-changed" ? t("keyCheck.presentsAnotherKey", { name: host.name }) : t("keyCheck.checkTheKeyOf", { name: host.name })}
    >
      <span className="flex flex-col gap-2">
        <span>{t("keyCheck.onTheHostThisMust")}</span>
        <Code
          label={t("keyCheck.commandToRunOnThe")}
        >{`ssh-keygen -lf /etc/ssh/ssh_host_${key.type.includes("ed25519") ? "ed25519" : key.type.startsWith("ecdsa") ? "ecdsa" : "rsa"}_key.pub`}</Code>
        <span className="logs-wrap font-mono text-xs">{key.fingerprint}</span>
        {host.fileHostKey && (
          <span>
            {t("keyCheck.theHostsFileTrusts")} <span className="logs-wrap font-mono text-xs">{host.fileHostKey}</span> {t("keyCheck.forThisHostAndThe")}
          </span>
        )}
        {can("admin") && !host.fileHostKey && (
          <span>
            <Button
              variant="primary"
              icon={<KeyRound />}
              onClick={() =>
                void call(`/api/v1/hosts/${host.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint: key.fingerprint }) }).then(onDone)
              }
            >
              {t("keyCheck.itMatchesAccept")}
            </Button>
          </span>
        )}
      </span>
    </Callout>
  );
}

/** infraUrl: where Infrastructure is, when the install has it (OPENASY_PRODUCTS). */
export function HostsPage({ call, infraUrl }: { call: Call; infraUrl?: string }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ hosts: Host[] }>(call, "/api/v1/hosts", 10_000);
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0).data?.agents ?? [];
  const added = (data?.hosts ?? []).filter((h) => h.origin === "ui");
  const file = useData<Summary>(call, "/api/v1/summary", 30_000).data?.hostsFile;
  const waiting = (data?.hosts ?? []).filter((h) => h.pendingHostKeys.length > 0);
  const cols: Column<Host>[] = [
    {
      id: "name",
      header: t("hostsPage.host"),
      cell: (h) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <a href={explore(`host:${quote(h.name)}`)}>{h.name}</a>
          {h.origin === "file" && <Badge tone="neutral">{t("hostsPage.fromFile")}</Badge>}
          {/* A host from the hosts file has the same name in Infrastructure, which opens it by that name (ADR 0052). */}
          {h.origin === "file" && infraUrl && (
            <a href={`${infraUrl.replace(/\/$/, "")}/hosts?name=${encodeURIComponent(h.name)}`} className="text-xs">
              {t("hostsPage.inInfrastructure")}
            </a>
          )}
        </span>
      ),
      sortValue: (h) => h.name,
    },
    { id: "address", header: t("hostsPage.address"), width: "150px", mono: true, cell: (h) => `${h.address}${h.port === 22 ? "" : `:${h.port}`}` },
    {
      id: "status",
      header: t("hostsPage.status"),
      width: "190px",
      cell: (h) => (
        <span title={h.statusDetail ?? undefined}>
          <Status status={h.status} />
        </span>
      ),
    },
    { id: "lines", header: t("hostsPage.lines"), width: "90px", align: "right", mono: true, cell: (h) => count(h.linesIn), sortValue: (h) => h.linesIn },
    { id: "last", header: t("hostsPage.lastRead"), width: "110px", cell: (h) => ago(h.lastSuccessAt) },
    {
      id: "what",
      header: t("hostsPage.reads"),
      cell: (h) => (
        <span className="text-xs">
          journald{h.containers ? t("hostsPage.containers") : ""} every {h.intervalSeconds} s
          {h.unreadable.length > 0 && (
            <span className="block text-warning-text">
              {t("hostsPage.notReadable")} {h.unreadable.join(", ")}
            </span>
          )}
        </span>
      ),
    },
    { id: "agent", header: t("hostsPage.agent"), width: "120px", cell: (h) => h.agent.name },
    {
      id: "actions",
      header: "",
      width: "190px",
      cell: (h) => (
        <span className="flex gap-1">
          {can("editor") && h.hostKeys.length > 0 && (
            <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={() => void call(`/api/v1/hosts/${h.id}/read`, { method: "POST" }).then(reload)}>
              {t("hostsPage.readNow")}
            </Button>
          )}
          {can("admin") && h.origin === "ui" && (
            <Button
              size="xs"
              variant="ghost"
              icon={<Trash2 />}
              onClick={() =>
                window.confirm(t("hostsPage.stopReadingItsLinesStay", { name: h.name })) &&
                void call(`/api/v1/hosts/${h.id}`, { method: "DELETE" }).then(reload)
              }
            >
              {t("hostsPage.remove")}
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("hostsPage.hosts")} description={t("hostsPage.serversLogsAgentReadsOver")} />
      {agents.length === 0 && data && (
        <EmptyState
          title={t("hostsPage.addAnAgentFirst")}
          action={
            <Button variant="primary" onClick={() => navigate("/agents")}>
              {t("hostsPage.addAnAgent")}
            </Button>
          }
        >
          {t("hostsPage.logsAgentIsInstalledOnce")}
        </EmptyState>
      )}
      {file?.error && (
        <Callout tone="danger" title={t("hostsPage.theHostsFileIsNot")}>
          {t("hostsPage.theHostsFromItsLast", { error: file.error, path: file.path })}
        </Callout>
      )}
      {!!file?.warnings.length && (
        <Callout tone="warning" title={t("hostsPage.theHostsFileHasSomething")}>
          {file.warnings.join(" ")}
        </Callout>
      )}
      {!!added.length && (
        <Callout tone="info" title={t("hostsPage.addedHereBefore", { count: added.length })}>
          {t("hostsPage.copyTheseIntoTheHostsFile")}
          <div className="mt-2">
            <Code label={t("hostsPage.linesForTheHostsFile")}>{toYaml(added)}</Code>
          </div>
        </Callout>
      )}
      {waiting.map((h) => (
        <KeyCheck key={h.id} call={call} host={h} onDone={reload} />
      ))}
      {agents.length > 0 && data?.hosts.length === 0 && (
        <EmptyState title={t("hostsPage.noHostsYet")}>
          {t("hostsPage.noHostsYetPrepareOne")}
          <div className="mt-3 text-left">
            <Code label={t("hostsPage.linesForTheHostsFile")}>{EXAMPLE}</Code>
          </div>
        </EmptyState>
      )}
      {agents.length > 0 && !!data?.hosts.length && (
        <Panel flush>
          <List label={t("hostsPage.hosts")} rows={data?.hosts} columns={cols} empty={t("hostsPage.noHostsYet")} getRowId={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}

const AGENT_STATUS = (t: T): Record<string, { tone: "success" | "warning" | "danger" | "info"; label: string }> => ({
  online: { tone: "success", label: t("agentStatus.online") },
  offline: { tone: "danger", label: t("agentStatus.offline") },
  "waiting-to-enrol": { tone: "info", label: t("agentStatus.waitingToEnrol") },
  "version-mismatch": { tone: "danger", label: t("agentStatus.otherVersion") },
});

/** How to start logs-agent with its one-time token, next to Logs or in another network. */
function EnrollCommand({ token, expiresAt, version, onDone }: { token: string; expiresAt: string; version?: string; onDone: () => void }) {
  const t = useT();
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      icon={<Check aria-hidden className="size-4" />}
      iconTone="success"
      title={t("enrollCommand.startTheAgentWithThis")}
      description={t("enrollCommand.itWorksOnceUntilAnd", { value: new Date(expiresAt).toLocaleString() })}
      footer={
        <Button variant="primary" onClick={onDone}>
          {t("enrollCommand.done")}
        </Button>
      }
    >
      <span className="flex flex-col gap-2">
        <span>{t("enrollCommand.withTheComposeFileOf")}</span>
        <Code label={t("enrollCommand.startTheAgentNextTo")}>{`LOGS_ENROLL_TOKEN=${token} docker compose up -d logs-agent`}</Code>
        <span>{t("enrollCommand.inAnotherNetworkOnAny")}</span>
        <Code label={t("enrollCommand.startTheAgentInAnother")}>
          {`openssl rand -hex 32 > openasy-agent-kek
docker run -d --name logs-agent --restart unless-stopped --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges \\
  -v logs-agent-data:/data -v "$PWD/openasy-agent-kek:/run/secrets/openasy-agent-kek:ro" \\
  -e LOGS_URL=${window.location.origin} -e LOGS_ENROLL_TOKEN=${token} \\
  ghcr.io/openasy/logs-agent:${version ?? "<the version of Logs>"}`}
        </Code>
      </span>
      <Callout tone="warning" title={t("enrollCommand.closingThisDialogHidesThe")}>
        {t("enrollCommand.ifItIsLostEnrol")}
      </Callout>
    </Dialog>
  );
}

export function AgentsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 10_000);
  // The agent must be the same version as Logs (ADR 0019).
  const version = useData<{ version: string }>(call, "/api/v1/version", 0).data?.version;
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ enrollToken: string; enrollExpiresAt: string }>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => (setAdding(false), setName(""), setError(undefined));
  const enrolled = (data?.agents ?? []).filter((a) => a.caFingerprint);
  const [setupFor, setSetupFor] = useState("");
  const chosen = setupFor || enrolled[0]?.id || "";
  const setup = useData<AgentSetup>(call, chosen ? `/api/v1/agents/${chosen}/setup` : null, 0).data;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await call<{ enrollToken: string; enrollExpiresAt: string }>("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) });
      close();
      setCreated(r);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const cols: Column<Agent>[] = [
    { id: "name", header: t("agentsPage.agent"), cell: (a) => a.name, sortValue: (a) => a.name },
    {
      id: "status",
      header: t("agentsPage.status"),
      width: "150px",
      cell: (a) => (
        <span title={a.lastError ?? undefined}>
          <Badge tone={AGENT_STATUS(t)[a.status]?.tone ?? "neutral"}>{AGENT_STATUS(t)[a.status]?.label ?? a.status}</Badge>
        </span>
      ),
    },
    { id: "hosts", header: t("agentsPage.hosts"), width: "80px", align: "right", cell: (a) => a.hosts },
    { id: "version", header: t("agentsPage.version"), width: "90px", mono: true, cell: (a) => a.version ?? "–" },
    { id: "ca", header: t("agentsPage.caFingerprint"), cell: (a) => <span className="logs-wrap font-mono text-xs">{a.caFingerprint ?? "–"}</span> },
    { id: "seen", header: t("agentsPage.lastSeen"), width: "110px", cell: (a) => ago(a.lastSeenAt) },
    {
      id: "actions",
      header: "",
      width: "200px",
      cell: (a) =>
        can("admin") && (
          <span className="flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              icon={<RefreshCw />}
              onClick={() =>
                window.confirm(t("agentsPage.enrolAgainItsSecretStops", { name: a.name })) &&
                void call<{ enrollToken: string; enrollExpiresAt: string }>(`/api/v1/agents/${a.id}/enroll-token`, { method: "POST" }).then(
                  (r) => (setCreated(r), reload()),
                )
              }
            >
              {t("agentsPage.enrolAgain")}
            </Button>
            {a.hosts === 0 && (
              <Button
                size="xs"
                variant="ghost"
                icon={<Trash2 />}
                onClick={() =>
                  window.confirm(t("agentsPage.remove", { name: a.name })) && void call(`/api/v1/agents/${a.id}`, { method: "DELETE" }).then(reload)
                }
              >
                {t("agentsPage.remove2")}
              </Button>
            )}
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("agentsPage.agents")}
        description={t("agentsPage.logsAgentIsInstalledOnce")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("agentsPage.addAgent")}
            </Button>
          )
        }
      />
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={t("agentsPage.addAnAgent")}
        description={t("agentsPage.nameItAfterWhereIt")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("agentsPage.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!name}>
              {t("agentsPage.addAgent")}
            </Button>
          </>
        }
      >
        <TextField label={t("agentsPage.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="dc-frankfurt" error={error} />
      </Dialog>
      {created && <EnrollCommand token={created.enrollToken} expiresAt={created.enrollExpiresAt} version={version} onDone={() => setCreated(undefined)} />}
      <Panel flush>
        <List label={t("agentsPage.agents")} rows={data?.agents} columns={cols} empty={t("agentsPage.noAgentsYet")} getRowId={(a) => a.id} />
      </Panel>
      {setup && (
        <Panel
          title={t("agentsPage.prepareAHost")}
          description={t("agentsPage.runAsRootOnEach", { name: setup.agent.name })}
          actions={
            enrolled.length > 1 && (
              <SelectField
                label={t("agentsPage.forHostsReadBy")}
                value={chosen}
                onChange={(e) => setSetupFor(e.target.value)}
                options={enrolled.map((a) => ({ value: a.id, label: a.name }))}
              />
            )
          }
        >
          <div className="flex flex-col gap-3">
            <Code label={t("agentsPage.commandsToPrepareAHost")}>{setup.hostSetup}</Code>
            <span className="text-sm text-fg-muted">{t("agentsPage.orWhereSshdConfigCannot")}</span>
            <Code label="authorized_keys line">{`# ~openasy/.ssh/authorized_keys\n${setup.authorizedKey}`}</Code>
            <span className="logs-wrap text-xs text-fg-muted">{t("agentsPage.caFingerprint2", { caFingerprint: setup.caFingerprint })}</span>
          </div>
        </Panel>
      )}
    </>
  );
}
