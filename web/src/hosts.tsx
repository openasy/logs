import { Badge, Button, Callout, Checkbox, EmptyState, navigate, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, AgentSetup, Host, Source } from "./api.ts";
import { ago, Code, count, explore, List, quote, Status, useData, type Call } from "./shared.tsx";

function AddHost({ call, agents, sources, onAdded }: { call: Call; agents: Agent[]; sources: Source[]; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [containers, setContainers] = useState(false);
  const [error, setError] = useState<string>();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/hosts", { method: "POST", body: JSON.stringify({ name, address, agentId, ...(sourceId && { sourceId }), containers }) });
      setName("");
      setAddress("");
      setError(undefined);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title="Add a host" description="The agent asks the host for its key first. Check the fingerprint on the host, then accept it; reading starts within a minute.">
      <form onSubmit={add} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="web-1" hint="Its lines carry it as host" error={error} />
          <TextField label="Address" mono value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5" />
          {agents.length > 1 && <SelectField label="Read by" value={agentId} onChange={(e) => setAgentId(e.target.value)} options={agents.map((a) => ({ value: a.id, label: a.name }))} />}
          {sources.length > 1 && <SelectField label="Pipeline of" value={sourceId} onChange={(e) => setSourceId(e.target.value)} options={sources.map((s) => ({ value: s.id, label: s.name }))} />}
        </div>
        <Checkbox label="Also read container logs" description="Through the host's Docker. Access to the Docker socket is equivalent to root on that host." checked={containers} onChange={(e) => setContainers(e.target.checked)} />
        <div>
          <Button type="submit" variant="primary" icon={<Plus />} disabled={!name || !address}>
            Add host
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** A host that waits for an admin to compare its key with what the host itself prints. */
function KeyCheck({ call, host, onDone }: { call: Call; host: Host; onDone: () => void }) {
  const { can } = useAuth();
  const key = host.pendingHostKeys[0];
  if (!key) return null;
  return (
    <Callout tone={host.status === "host-key-changed" ? "danger" : "warning"} title={host.status === "host-key-changed" ? `${host.name} presents another key` : `Check the key of ${host.name}`}>
      <span className="flex flex-col gap-2">
        <span>On the host, this must print the same fingerprint:</span>
        <Code label="Command to run on the host">{`ssh-keygen -lf /etc/ssh/ssh_host_${key.type.includes("ed25519") ? "ed25519" : key.type.startsWith("ecdsa") ? "ecdsa" : "rsa"}_key.pub`}</Code>
        <span className="logs-wrap font-mono text-xs">{key.fingerprint}</span>
        {can("admin") && (
          <span>
            <Button variant="primary" icon={<KeyRound />} onClick={() => void call(`/api/v1/hosts/${host.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint: key.fingerprint }) }).then(onDone)}>
              It matches: accept
            </Button>
          </span>
        )}
      </span>
    </Callout>
  );
}

export function HostsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ hosts: Host[] }>(call, "/api/v1/hosts", 10_000);
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0).data?.agents ?? [];
  const sources = (useData<{ sources: Source[] }>(call, "/api/v1/sources", 0).data?.sources ?? []).filter((s) => s.kind === "ssh");
  const [adding, setAdding] = useState(false);
  const waiting = (data?.hosts ?? []).filter((h) => h.pendingHostKeys.length > 0);
  const cols: Column<Host>[] = [
    { id: "name", header: "Host", cell: (h) => <a href={explore(`host:${quote(h.name)}`)}>{h.name}</a>, sortValue: (h) => h.name },
    { id: "address", header: "Address", width: "150px", mono: true, cell: (h) => `${h.address}${h.port === 22 ? "" : `:${h.port}`}` },
    { id: "status", header: "Status", width: "190px", cell: (h) => <span title={h.statusDetail ?? undefined}><Status status={h.status} /></span> },
    { id: "lines", header: "Lines", width: "90px", align: "right", mono: true, cell: (h) => count(h.linesIn), sortValue: (h) => h.linesIn },
    { id: "last", header: "Last read", width: "110px", cell: (h) => ago(h.lastSuccessAt) },
    {
      id: "what",
      header: "Reads",
      cell: (h) => (
        <span className="text-xs">
          journald{h.containers ? ", containers" : ""} every {h.intervalSeconds} s
          {h.unreadable.length > 0 && <span className="block text-warning-text">Not readable: {h.unreadable.join(", ")}</span>}
        </span>
      ),
    },
    { id: "agent", header: "Agent", width: "120px", cell: (h) => h.agent.name },
    {
      id: "actions",
      header: "",
      width: "190px",
      cell: (h) => (
        <span className="flex gap-1">
          {can("editor") && h.hostKeys.length > 0 && (
            <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={() => void call(`/api/v1/hosts/${h.id}/read`, { method: "POST" }).then(reload)}>
              Read now
            </Button>
          )}
          {can("admin") && (
            <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => window.confirm(`Stop reading ${h.name}? Its lines stay until retention removes them.`) && void call(`/api/v1/hosts/${h.id}`, { method: "DELETE" }).then(reload)}>
              Remove
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Hosts"
        description="Servers logs-agent reads over SSH: the system journal, and container logs where switched on. Nothing is installed on them."
        actions={
          can("admin") &&
          agents.length > 0 && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
              Add host
            </Button>
          )
        }
      />
      {agents.length === 0 && data && (
        <EmptyState title="Add an agent first" action={<Button variant="primary" onClick={() => navigate("/agents")}>Add an agent</Button>}>
          logs-agent is installed once per network and reads the hosts there. Hosts that already send their logs need no agent: add a source for them instead.
        </EmptyState>
      )}
      {adding && (
        <AddHost
          call={call}
          agents={agents}
          sources={sources}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {waiting.map((h) => (
        <KeyCheck key={h.id} call={call} host={h} onDone={reload} />
      ))}
      {agents.length > 0 && (
        <Panel flush>
          <List label="Hosts" rows={data?.hosts} columns={cols} empty="No hosts yet. Prepare one with the commands under Agents, then add it here." getRowId={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}

const AGENT_STATUS: Record<string, { tone: "success" | "warning" | "danger" | "info"; label: string }> = {
  online: { tone: "success", label: "Online" },
  offline: { tone: "danger", label: "Offline" },
  "waiting-to-enrol": { tone: "info", label: "Waiting to enrol" },
  "version-mismatch": { tone: "danger", label: "Other version" },
};

/** How to start logs-agent with its one-time token, next to Logs or in another network. */
function EnrollCommand({ token, expiresAt, version }: { token: string; expiresAt: string; version?: string }) {
  return (
    <Callout tone="warning" title="Start the agent with this one-time token">
      <span className="flex flex-col gap-2">
        <span>It works once, until {new Date(expiresAt).toLocaleString()}, and is not shown again. With the compose file of Logs:</span>
        <Code label="Start the agent next to Logs">{`LOGS_ENROLL_TOKEN=${token} docker compose up -d logs-agent`}</Code>
        <span>In another network, on any server that reaches the hosts there and reaches Logs:</span>
        <Code label="Start the agent in another network">
          {`openssl rand -hex 32 > openasy-agent-kek
docker run -d --name logs-agent --restart unless-stopped --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges \\
  -v logs-agent-data:/data -v "$PWD/openasy-agent-kek:/run/secrets/openasy-agent-kek:ro" \\
  -e LOGS_URL=${window.location.origin} -e LOGS_ENROLL_TOKEN=${token} \\
  ghcr.io/openasy/logs-agent:${version ?? "<the version of Logs>"}`}
        </Code>
      </span>
    </Callout>
  );
}

export function AgentsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 10_000);
  // The agent must be the same version as Logs (ADR 0019).
  const version = useData<{ version: string }>(call, "/api/v1/version", 0).data?.version;
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ enrollToken: string; enrollExpiresAt: string }>();
  const [error, setError] = useState<string>();
  const enrolled = (data?.agents ?? []).filter((a) => a.caFingerprint);
  const [setupFor, setSetupFor] = useState("");
  const chosen = setupFor || enrolled[0]?.id || "";
  const setup = useData<AgentSetup>(call, chosen ? `/api/v1/agents/${chosen}/setup` : null, 0).data;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setCreated(await call("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) }));
      setName("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const cols: Column<Agent>[] = [
    { id: "name", header: "Agent", cell: (a) => a.name, sortValue: (a) => a.name },
    { id: "status", header: "Status", width: "150px", cell: (a) => <span title={a.lastError ?? undefined}><Badge tone={AGENT_STATUS[a.status]?.tone ?? "neutral"}>{AGENT_STATUS[a.status]?.label ?? a.status}</Badge></span> },
    { id: "hosts", header: "Hosts", width: "80px", align: "right", cell: (a) => a.hosts },
    { id: "version", header: "Version", width: "90px", mono: true, cell: (a) => a.version ?? "–" },
    { id: "ca", header: "CA fingerprint", cell: (a) => <span className="logs-wrap font-mono text-xs">{a.caFingerprint ?? "–"}</span> },
    { id: "seen", header: "Last seen", width: "110px", cell: (a) => ago(a.lastSeenAt) },
    {
      id: "actions",
      header: "",
      width: "200px",
      cell: (a) =>
        can("admin") && (
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={() => window.confirm(`Enrol ${a.name} again? Its secret stops working; if its CA changes, the hosts it reads must trust the new one.`) && void call<{ enrollToken: string; enrollExpiresAt: string }>(`/api/v1/agents/${a.id}/enroll-token`, { method: "POST" }).then((r) => (setCreated(r), reload()))}>
              Enrol again
            </Button>
            {a.hosts === 0 && (
              <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => window.confirm(`Remove ${a.name}?`) && void call(`/api/v1/agents/${a.id}`, { method: "DELETE" }).then(reload)}>
                Remove
              </Button>
            )}
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader title="Agents" description="logs-agent is installed once, next to Logs or in another network, and reads the hosts there over SSH with 5-minute certificates. It keeps its SSH certificate authority; Logs only says which host to read and from where." />
      {can("admin") && (
        <Panel title="Add an agent">
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="dc-frankfurt" error={error} />
            <Button type="submit" variant="primary" icon={<Plus />} disabled={!name}>
              Add agent
            </Button>
          </form>
        </Panel>
      )}
      {created && <EnrollCommand token={created.enrollToken} expiresAt={created.enrollExpiresAt} version={version} />}
      <Panel flush>
        <List label="Agents" rows={data?.agents} columns={cols} empty="No agents yet" getRowId={(a) => a.id} />
      </Panel>
      {setup && (
        <Panel
          title="Prepare a host"
          description={`Run as root on each host ${setup.agent.name} reads. It creates the openasy account, trusts the agent's CA for that account only, and lets it read the system journal. Nothing else is installed.`}
          actions={enrolled.length > 1 && <SelectField label="For hosts read by" value={chosen} onChange={(e) => setSetupFor(e.target.value)} options={enrolled.map((a) => ({ value: a.id, label: a.name }))} />}
        >
          <div className="flex flex-col gap-3">
            <Code label="Commands to prepare a host">{setup.hostSetup}</Code>
            <span className="text-sm text-fg-muted">Or, where sshd_config cannot change, one fixed key that can open no TTY and forward nothing:</span>
            <Code label="authorized_keys line">{`# ~openasy/.ssh/authorized_keys\n${setup.authorizedKey}`}</Code>
            <span className="logs-wrap text-xs text-fg-muted">CA fingerprint {setup.caFingerprint}</span>
          </div>
        </Panel>
      )}
    </>
  );
}
