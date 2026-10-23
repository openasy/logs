import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, PageHeader, Panel, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { NewView, View } from "./api.ts";
import { Code, List, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const ALERT = (t: T) =>
  ({
    ok: { tone: "success", label: t("alert.under") },
    firing: { tone: "danger", label: t("alert.over") },
    error: { tone: "warning", label: t("alert.notChecked") },
  }) as const;

function ViewForm({ call, view, onDone, onCancel }: { call: Call; view?: View; onDone: (r: NewView) => void; onCancel: () => void }) {
  const t = useT();
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
      title={view ? t("viewForm.change", { name: view.name }) : t("viewForm.saveAView")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            {t("viewForm.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !query.trim() || (alert && !webhookUrl)}>
            {t("viewForm.save")}
          </Button>
        </>
      }
    >
      <TextField label={t("viewForm.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("viewForm.checkoutErrors")} />
      <TextField label={t("viewForm.logsqlQuery")} mono value={query} onChange={(e) => setQuery(e.target.value)} placeholder="service:checkout level:error" />
      <Checkbox
        label={t("viewForm.everyoneCanSeeIt")}
        description={t("viewForm.otherwiseOnlyYouCan")}
        checked={shared}
        onChange={(e) => setShared(e.target.checked)}
      />
      <Checkbox
        label={t("viewForm.callAWebhookWhenIt")}
        description={t("viewForm.checkedEveryMinuteTheWebhook")}
        checked={alert}
        onChange={(e) => setAlert(e.target.checked)}
      />
      {alert && (
        <div className="flex flex-wrap items-end gap-3">
          <TextField label={t("viewForm.moreThan")} type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} hint="lines" />
          <TextField
            label={t("viewForm.in")}
            type="number"
            min={1}
            max={1440}
            value={windowMinutes}
            onChange={(e) => setWindow(e.target.value)}
            hint="minutes"
          />
          <TextField
            label={t("viewForm.webhook")}
            type="url"
            value={webhookUrl}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.example.com/logs"
            className="min-w-0 grow"
          />
        </div>
      )}
      {error && (
        <Callout tone="danger" title={t("viewForm.notSaved")}>
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

export function ViewsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can, me } = useAuth();
  const { data, reload } = useData<{ views: View[] }>(call, "/api/v1/views", 30_000);
  const [editing, setEditing] = useState<View | "new" | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string }>();
  const mayChange = (v: View) => can("admin") || (can("editor") && v.owner.id === me.user.id);
  const cols: Column<View>[] = [
    { id: "name", header: t("viewsPage.view"), cell: (v) => <a href={`/explorer?view=${v.id}`}>{v.name}</a>, sortValue: (v) => v.name },
    { id: "query", header: t("viewsPage.query"), cell: (v) => <span className="logs-wrap font-mono text-xs">{v.query}</span> },
    { id: "owner", header: t("viewsPage.owner"), width: "140px", cell: (v) => (v.shared ? v.owner.name : `${v.owner.name}, private`) },
    {
      id: "alert",
      header: t("viewsPage.threshold"),
      width: "220px",
      cell: (v) =>
        v.alert ? (
          <span className="flex flex-col gap-0.5" title={v.alert.lastError ?? undefined}>
            <span className="flex items-center gap-1.5">
              <Badge tone={ALERT(t)[v.alert.state].tone}>{ALERT(t)[v.alert.state].label}</Badge>
              <span className="text-xs">{t("viewsPage.gtInMin", { threshold: v.alert.threshold, windowMinutes: v.alert.windowMinutes })}</span>
            </span>
            <span className="text-xs text-fg-muted">
              {v.alert.lastCount === null ? t("viewsPage.notCheckedYet") : `${v.alert.lastCount} ${ago(v.alert.lastCheckedAt)}`}
            </span>
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
              {t("viewsPage.change")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<Trash2 />}
              onClick={() => window.confirm(t("viewsPage.remove", { name: v.name })) && void call(`/api/v1/views/${v.id}`, { method: "DELETE" }).then(reload)}
            >
              {t("viewsPage.remove2")}
            </Button>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("viewsPage.savedViews")}
        description={t("viewsPage.queriesKeptForLaterShared")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              {t("viewsPage.newView")}
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
          title={t("viewsPage.theWebhookSecretOf", { name: secret.name })}
          description={t("viewsPage.itIsShownOnceCalls")}
          footer={
            <Button variant="primary" onClick={() => setSecret(undefined)}>
              {t("viewsPage.done")}
            </Button>
          }
        >
          <Code label={t("viewsPage.webhookSecret")}>{secret.secret}</Code>
          <Callout tone="warning" title={t("viewsPage.closingThisDialogHidesThe")} />
        </Dialog>
      )}
      {data?.views.length === 0 ? (
        <EmptyState title={t("viewsPage.noSavedViewsYet")}>{t("viewsPage.searchInExplorerThenSave")}</EmptyState>
      ) : (
        <Panel flush>
          <List label={t("viewsPage.savedViews")} rows={data?.views} columns={cols} empty={t("viewsPage.noViews")} getRowId={(v) => v.id} />
        </Panel>
      )}
    </>
  );
}
