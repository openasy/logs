import { AppShell, BrandProvider, Button, Callout, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, PRODUCT_IDS, TextField, usePath, type Column, type ProductId } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { Bookmark, Bot, Cable, Eye, KeyRound, LayoutDashboard, LogIn, LogOut, Radio, Search, Server, Settings2, UserRound, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ProductLink, SearchRecord, Settings, Summary } from "./api.ts";
import { ExplorerPage } from "./explorer.tsx";
import { AgentsPage, HostsPage } from "./hosts.tsx";
import { SourcePage, SourcesPage } from "./sources.tsx";
import { TailPage } from "./tail.tsx";
import { ViewsPage } from "./views.tsx";
import { ago, bytes, count, List, useApi, useData, type Call } from "./shared.tsx";

export const PAGES = ["overview", "explorer", "tail", "views", "sources", "hosts", "agents", "settings", "searches", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page; params: URLSearchParams } | { page: "source"; id: string; params: URLSearchParams };

function parseRoute(path: string, query: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  const params = new URLSearchParams(query);
  if (page === "sources" && id) return { page: "source", id: decodeURIComponent(id), params };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page, params };
  return { page: "overview", params };
}

function OverviewPage({ call }: { call: Call }) {
  const { data: s } = useData<Summary>(call, "/api/v1/summary", 30_000);
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  if (s && total(s.sources) === 0) {
    return (
      <>
        <PageHeader title="Get started" description="Logs keeps what your hosts and services write, and finds it again." />
        <EmptyState title="No logs yet" action={<Button variant="primary" onClick={() => navigate("/sources")}>Add a source</Button>}>
          Add a source for each way logs reach you: shippers such as Vector, Fluent Bit or an OpenTelemetry collector send over HTTP with a token; servers and network devices send syslog; and hosts that send nothing are read over SSH by logs-agent.
        </EmptyState>
      </>
    );
  }
  const notOk = total(s?.hosts) - (s?.hosts.ok ?? 0);
  return (
    <>
      <PageHeader title="Overview" description="What arrives, from where, and what is kept." />
      <KpiGrid>
        <KpiCard label="Lines in the last hour" value={s ? count(s.linesLastHour) : "–"} href="/explorer" />
        <KpiCard label="Stored" value={s ? bytes(s.storedBytes) : "–"} footer={s && `kept ${s.retentionDays} days`} href="/settings" />
        <KpiCard label="Sources" value={s ? total(s.sources) : "–"} href="/sources" />
        <KpiCard label="Hosts read" value={s ? `${s.hosts.ok ?? 0}/${total(s.hosts)}` : "–"} tone={notOk > 0 ? "warning" : undefined} href="/hosts" />
        <KpiCard label="Views over threshold" value={s?.alertsFiring ?? "–"} tone={s?.alertsFiring ? "danger" : undefined} href="/views" />
      </KpiGrid>
      {s && s.linesLastHour === null && (
        <Callout tone="danger" title="Storage is not answering">
          VictoriaLogs inside Logs is starting or has stopped; it is started again on its own. Lines sent meanwhile are refused, so senders keep and retry them.
        </Callout>
      )}
      <Panel title="Search">
        <p className="m-0 text-sm">
          Open <a href="/explorer">Explorer</a> and write LogsQL: <code>service:checkout level:error</code>, <code>"connection refused"</code>, <code>host:web-1 -service:cron</code>. The{" "}
          <a href="https://docs.victoriametrics.com/victorialogs/logsql/" target="_blank" rel="noreferrer">
            LogsQL reference
          </a>{" "}
          has the rest.
        </p>
      </Panel>
    </>
  );
}

function SettingsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<Settings>(call, "/api/v1/settings", 0);
  const [days, setDays] = useState<string>();
  const [gb, setGb] = useState<string>();
  const [state, setState] = useState<{ tone: "success" | "danger"; text: string }>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ ...(days !== undefined && { retentionDays: Number(days) }), ...(gb !== undefined && { maxDiskGb: Number(gb) }) }) });
      setState({ tone: "success", text: "Saved. Storage restarted with it; lines older than the new retention are removed." });
      setDays(undefined);
      setGb(undefined);
      reload();
    } catch (err) {
      setState({ tone: "danger", text: (err as Error).message });
    }
  };
  return (
    <>
      <PageHeader title="Retention" description="How long lines are kept. When the volume fills first, the oldest days go first, so Logs never stops taking lines." />
      <Panel>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <TextField label="Keep for" type="number" min={1} max={3650} value={days ?? String(data?.retentionDays ?? "")} onChange={(e) => setDays(e.target.value)} hint="days" disabled={!can("admin")} />
          <TextField label="Use at most" type="number" min={0} value={gb ?? String(data?.maxDiskGb ?? "")} onChange={(e) => setGb(e.target.value)} hint="GB; 0 is up to 90% of the volume" disabled={!can("admin")} />
          {can("admin") && (
            <Button type="submit" variant="primary" disabled={days === undefined && gb === undefined}>
              Save
            </Button>
          )}
        </form>
      </Panel>
      {state && (
        <Callout tone={state.tone} title={state.tone === "success" ? "Retention changed" : "Not saved"} onDismiss={() => setState(undefined)}>
          {state.text}
        </Callout>
      )}
    </>
  );
}

function SearchesPage({ call }: { call: Call }) {
  const { data } = useData<{ searches: SearchRecord[] }>(call, "/api/v1/searches?limit=500", 30_000);
  const cols: Column<SearchRecord>[] = [
    { id: "at", header: "When", width: "120px", cell: (s) => <span title={new Date(s.at).toLocaleString()}>{ago(s.at)}</span>, sortValue: (s) => s.at },
    { id: "who", header: "Who", width: "240px", cell: (s) => s.actor },
    { id: "kind", header: "", width: "70px", cell: (s) => (s.kind === "tail" ? "tail" : "search") },
    { id: "query", header: "Query", cell: (s) => <span className="logs-wrap font-mono text-xs">{s.query}</span> },
  ];
  return (
    <>
      <PageHeader title="Who searched" description="Logs hold personal data and sometimes secrets, so every search and tail is recorded with who ran it, for 400 days. Anyone with the viewer role reads every line Logs keeps." />
      <Panel flush>
        <List label="Searches" rows={data?.searches} columns={cols} empty="No searches yet" getRowId={(s) => String(s.id)} />
      </Panel>
    </>
  );
}

const ACCOUNT = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can sign in, and with which role. Viewers search and tail every line; editors also save views and set thresholds; admins also manage sources, agents, hosts, retention, members and tokens."],
  signin: ["Sign-in", "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role."],
  tokens: ["API tokens", "For scripts that search. Each token has one role and an expiry; the secret is shown once. Shippers use a source's ingest token instead."],
} as const;

function Product() {
  const { me, can, signOut } = useAuth();
  const call = useApi();
  // usePath follows the query too, so the route has this page's parameters.
  const route = parseRoute(usePath(), window.location.search);
  const summary = useData<Summary>(call, "/api/v1/summary", 60_000);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "logs" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const nav = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "explorer", label: "Explorer", icon: Search },
    { id: "tail", label: "Live tail", icon: Radio },
    { id: "views", label: "Saved views", icon: Bookmark, count: summary.data?.alertsFiring || undefined },
    { id: "sources", label: "Sources", icon: Cable, count: total(summary.data?.sources) || undefined },
    { id: "hosts", label: "Hosts", icon: Server, count: total(summary.data?.hosts) || undefined },
  ];
  const footerNav = [
    { id: "agents", label: "Agents", icon: Bot },
    { id: "settings", label: "Retention", icon: Settings2 },
    ...(can("admin")
      ? [
          { id: "searches", label: "Who searched", icon: Eye },
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const active = route.page === "source" ? "sources" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const page = route.page;
  return (
    <AppShell
      product="logs"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
    >
      {route.page === "source" ? (
        <SourcePage key={route.id} call={call} id={route.id} />
      ) : page === "explorer" ? (
        <ExplorerPage key={route.params.toString()} call={call} params={route.params} />
      ) : page === "tail" ? (
        <TailPage key={route.params.toString()} params={route.params} />
      ) : page === "views" ? (
        <ViewsPage call={call} />
      ) : page === "sources" ? (
        <SourcesPage call={call} />
      ) : page === "hosts" ? (
        <HostsPage call={call} />
      ) : page === "agents" ? (
        <AgentsPage call={call} />
      ) : page === "settings" ? (
        <SettingsPage call={call} />
      ) : page === "searches" ? (
        can("admin") ? <SearchesPage call={call} /> : <EmptyState title="Admins only">Ask an admin of this Logs for access.</EmptyState>
      ) : page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        page !== "account" && !can("admin") ? (
          <EmptyState title="Admins only">Ask an admin of this Logs for access.</EmptyState>
        ) : (
          <>
            <PageHeader
              title={ACCOUNT[page][0]}
              description={ACCOUNT[page][1]}
              actions={
                page === "account" && (
                  <Button icon={<LogOut />} onClick={() => void signOut()}>
                    Sign out
                  </Button>
                )
              }
            />
            {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
          </>
        )
      ) : (
        <OverviewPage call={call} />
      )}
    </AppShell>
  );
}

export function App() {
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Logs">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
