import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { NewView, View } from "./api.ts";
import { ago, Code, List, useData, type Call } from "./shared.tsx";

const ALERT = { ok: { tone: "success", label: "Under" }, firing: { tone: "danger", label: "Over" }, error: { tone: "warning", label: "Not checked" } } as const;

function ViewForm({ call, view, onDone, onCancel }: { call: Call; view?: View; onDone: (r: NewView) => void; onCancel: () => void }) {
  const [name, setName] = useState(view?.name ?? "");
  const [query, setQuery] = useState(view?.query ?? "");
  const [shared, setShared] = useState(view?.shared ?? true);
  const [alert, setAlert] = useState(!!view?.alert);
  const [threshold, setThreshold] = useState(String(view?.alert?.threshold ?? 0));
  const [windowMinutes, setWindow] = useState(String(view?.alert?.windowMinutes ?? 5));
  const [webhookUrl, setUrl] = useState(view?.alert?.webhookUrl ?? "");
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name, query, shared, alert: alert ? { threshold: Number(threshold), windowMinutes: Number(windowMinutes), webhookUrl } : null };
    try {
      onDone(await call<NewView>(view ? `/api/v1/views/${view.id}` : "/api/v1/views", { method: view ? "PATCH" : "POST", body: JSON.stringify(body) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      size="lg"
      title={view ? `Change ${view.name}` : "Save a view"}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !query.trim() || (alert && !webhookUrl)}>
            Save
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout errors" />
      <TextField label="LogsQL query" mono value={query} onChange={(e) => setQuery(e.target.value)} placeholder="service:checkout level:error" />
      <Checkbox label="Everyone can see it" description="Otherwise only you can." checked={shared} onChange={(e) => setShared(e.target.checked)} />
      <Checkbox label="Call a webhook when it crosses a threshold" description="Checked every minute. The webhook is called when more lines match than the threshold, and again when it is back under." checked={alert} onChange={(e) => setAlert(e.target.checked)} />
      {alert && (
        <div className="flex flex-wrap items-end gap-3">
          <TextField label="More than" type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} hint="lines" />
          <TextField label="In" type="number" min={1} max={1440} value={windowMinutes} onChange={(e) => setWindow(e.target.value)} hint="minutes" />
          <TextField label="Webhook" type="url" value={webhookUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/logs" className="min-w-0 grow" />
        </div>
      )}
      {error && (
        <Callout tone="danger" title="Not saved">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

export function ViewsPage({ call }: { call: Call }) {
  const { can, me } = useAuth();
  const { data, reload } = useData<{ views: View[] }>(call, "/api/v1/views", 30_000);
  const [editing, setEditing] = useState<View | "new" | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string }>();
  const mayChange = (v: View) => can("admin") || (can("editor") && v.owner.id === me.user.id);
  const cols: Column<View>[] = [
    { id: "name", header: "View", cell: (v) => <a href={`/explorer?view=${v.id}`}>{v.name}</a>, sortValue: (v) => v.name },
    { id: "query", header: "Query", cell: (v) => <span className="logs-wrap font-mono text-xs">{v.query}</span> },
    { id: "owner", header: "Owner", width: "140px", cell: (v) => (v.shared ? v.owner.name : `${v.owner.name}, private`) },
    {
      id: "alert",
      header: "Threshold",
      width: "220px",
      cell: (v) =>
        v.alert ? (
          <span className="flex flex-col gap-0.5" title={v.alert.lastError ?? undefined}>
            <span className="flex items-center gap-1.5">
              <Badge tone={ALERT[v.alert.state].tone}>{ALERT[v.alert.state].label}</Badge>
              <span className="text-xs">
                &gt; {v.alert.threshold} in {v.alert.windowMinutes} min
              </span>
            </span>
            <span className="text-xs text-fg-muted">{v.alert.lastCount === null ? "not checked yet" : `${v.alert.lastCount} ${ago(v.alert.lastCheckedAt)}`}</span>
          </span>
        ) : (
          <span className="text-fg-muted">–</span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "170px",
      cell: (v) =>
        mayChange(v) && (
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" icon={<Pencil />} onClick={() => setEditing(v)}>
              Change
            </Button>
            <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => window.confirm(`Remove ${v.name}?`) && void call(`/api/v1/views/${v.id}`, { method: "DELETE" }).then(reload)}>
              Remove
            </Button>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Saved views"
        description="Queries kept for later. Shared views are seen by everyone; a threshold calls a signed webhook, such as Alerts, Slack through a relay, or your own service."
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              New view
            </Button>
          )
        }
      />
      {editing && (
        <ViewForm
          call={call}
          view={editing === "new" ? undefined : editing}
          onDone={(r) => {
            if (r.webhookSecret) setSecret({ name: r.view.name, secret: r.webhookSecret });
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {secret && (
        <Dialog
          open
          onOpenChange={(open) => !open && setSecret(undefined)}
          icon={<Check aria-hidden className="size-4" />}
          iconTone="success"
          title={`The webhook secret of ${secret.name}`}
          description="It is shown once. Calls carry webhook-id, webhook-timestamp and webhook-signature headers (Standard Webhooks): check the signature with this secret before you trust a call."
          footer={
            <Button variant="primary" onClick={() => setSecret(undefined)}>
              Done
            </Button>
          }
        >
          <Code label="Webhook secret">{secret.secret}</Code>
          <Callout tone="warning" title="Closing this dialog hides the secret" />
        </Dialog>
      )}
      {data?.views.length === 0 ? (
        <EmptyState title="No saved views yet">Search in Explorer, then Save view; or add one here.</EmptyState>
      ) : (
        <Panel flush>
          <List label="Saved views" rows={data?.views} columns={cols} empty="No views" getRowId={(v) => v.id} />
        </Panel>
      )}
    </>
  );
}
