import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  TextField,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
  useAgo,
  toLocale,
  useLocalePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { Bookmark, Bot, Cable, Eye, KeyRound, LayoutDashboard, LogIn, LogOut, Radio, Search, Server, Settings2, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ProductLink, SearchRecord, Settings, Summary } from "./api.ts";
import { ExplorerPage } from "./explorer.tsx";
import { AgentsPage, HostsPage } from "./hosts.tsx";
import { SourcePage, SourcesPage } from "./sources.tsx";
import { TailPage } from "./tail.tsx";
import { ViewsPage } from "./views.tsx";
import { bytes, count, List, useApi, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";
import { search } from "./search.ts";

export const PAGES = [
  "overview",
  "explorer",
  "tail",
  "views",
  "sources",
  "hosts",
  "agents",
  "settings",
  "searches",
  "account",
  "members",
  "signin",
  "tokens",
  "about",
] as const;
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
  const t = useT();
  const { data: s } = useData<Summary>(call, "/api/v1/summary", 30_000);
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  if (s && total(s.sources) === 0) {
    return (
      <>
        <PageHeader title={t("overviewPage.getStarted")} description={t("overviewPage.logsKeepsWhatYourHosts")} />
        <EmptyState
          title={t("overviewPage.noLogsYet")}
          action={
            <Button variant="primary" onClick={() => navigate("/sources")}>
              {t("overviewPage.addASource")}
            </Button>
          }
        >
          {t("overviewPage.addASourceForEach")}
        </EmptyState>
      </>
    );
  }
  const notOk = total(s?.hosts) - (s?.hosts.ok ?? 0);
  return (
    <>
      <PageHeader title={t("overviewPage.overview")} description={t("overviewPage.whatArrivesFromWhereAnd")} />
      <KpiGrid>
        <KpiCard label={t("overviewPage.linesInTheLastHour")} value={s ? count(s.linesLastHour) : "–"} href="/explorer" />
        <KpiCard
          label={t("overviewPage.stored")}
          value={s ? bytes(s.storedBytes) : "–"}
          footer={s && t("overviewPage.keptDays", { retentionDays: s.retentionDays })}
          href="/settings"
        />
        <KpiCard label={t("overviewPage.sources")} value={s ? total(s.sources) : "–"} href="/sources" />
        <KpiCard
          label={t("overviewPage.hostsRead")}
          value={s ? `${s.hosts.ok ?? 0}/${total(s.hosts)}` : "–"}
          tone={notOk > 0 ? "warning" : undefined}
          href="/hosts"
        />
        <KpiCard label={t("overviewPage.viewsOverThreshold")} value={s?.alertsFiring ?? "–"} tone={s?.alertsFiring ? "danger" : undefined} href="/views" />
      </KpiGrid>
      {s && s.linesLastHour === null && (
        <Callout tone="danger" title={t("overviewPage.storageIsNotAnswering")}>
          {t("overviewPage.victorialogsInsideLogsIsStarting")}
        </Callout>
      )}
      <Panel title={t("overviewPage.search")}>
        <p className="m-0 text-sm">
          {t("overviewPage.open")} <a href="/explorer">{t("overviewPage.explorer")}</a> {t("overviewPage.andWriteLogsql")}{" "}
          <code>service:checkout level:error</code>, <code>"connection refused"</code>, <code>host:web-1 -service:cron</code>. The{" "}
          <a href="https://docs.victoriametrics.com/victorialogs/logsql/" target="_blank" rel="noreferrer">
            {t("overviewPage.logsqlReference")}
          </a>{" "}
          has the rest.
        </p>
      </Panel>
    </>
  );
}

function SettingsPage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<Settings>(call, "/api/v1/settings", 0);
  const [days, setDays] = useState<string>();
  const [gb, setGb] = useState<string>();
  const [state, setState] = useState<{ tone: "success" | "danger"; text: string }>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({ ...(days !== undefined && { retentionDays: Number(days) }), ...(gb !== undefined && { maxDiskGb: Number(gb) }) }),
      });
      setState({ tone: "success", text: t("settingsPage.savedStorageRestartedWithIt") });
      setDays(undefined);
      setGb(undefined);
      reload();
    } catch (err) {
      setState({ tone: "danger", text: (err as Error).message });
    }
  };
  return (
    <>
      <PageHeader title={t("settingsPage.retention")} description={t("settingsPage.howLongLinesAreKept")} />
      <Panel>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <TextField
            label={t("settingsPage.keepFor")}
            type="number"
            min={1}
            max={3650}
            value={days ?? String(data?.retentionDays ?? "")}
            onChange={(e) => setDays(e.target.value)}
            hint="days"
            disabled={!can("admin")}
          />
          <TextField
            label={t("settingsPage.useAtMost")}
            type="number"
            min={0}
            value={gb ?? String(data?.maxDiskGb ?? "")}
            onChange={(e) => setGb(e.target.value)}
            hint={t("settingsPage.gb0IsUpTo")}
            disabled={!can("admin")}
          />
          {can("admin") && (
            <Button type="submit" variant="primary" disabled={days === undefined && gb === undefined}>
              {t("settingsPage.save")}
            </Button>
          )}
        </form>
      </Panel>
      {state && (
        <Callout
          tone={state.tone}
          title={state.tone === "success" ? t("settingsPage.retentionChanged") : t("settingsPage.notSaved")}
          onDismiss={() => setState(undefined)}
        >
          {state.text}
        </Callout>
      )}
    </>
  );
}

function SearchesPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { data } = useData<{ searches: SearchRecord[] }>(call, "/api/v1/searches?limit=500", 30_000);
  const cols: Column<SearchRecord>[] = [
    {
      id: "at",
      header: t("searchesPage.when"),
      width: "120px",
      cell: (s) => <span title={new Date(s.at).toLocaleString()}>{ago(s.at)}</span>,
      sortValue: (s) => s.at,
    },
    { id: "who", header: t("searchesPage.who"), width: "240px", cell: (s) => s.actor },
    { id: "kind", header: "", width: "70px", cell: (s) => (s.kind === "tail" ? "tail" : "search") },
    { id: "query", header: t("searchesPage.query"), cell: (s) => <span className="logs-wrap font-mono text-xs">{s.query}</span> },
  ];
  return (
    <>
      <PageHeader title={t("searchesPage.whoSearched")} description={t("searchesPage.logsHoldPersonalDataAnd")} />
      <Panel flush>
        <List label={t("searchesPage.searches")} rows={data?.searches} columns={cols} empty={t("searchesPage.noSearchesYet")} getRowId={(s) => String(s.id)} />
      </Panel>
    </>
  );
}

const ACCOUNT = (t: T) =>
  ({
    account: [t("settings.account"), t("settings.accountText")],
    members: [t("settings.members"), t("settings.membersText")],
    signin: [t("settings.signin"), t("settings.signinText")],
    tokens: [t("settings.tokens"), t("settings.tokensText")],
  }) as const;

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can, signOut } = useAuth();
  const account = useAccountMenu();
  const call = useApi();
  const onSearch = useMemo(() => search(call, t), [call, t]);
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
    { id: "overview", label: t("product.overview"), icon: LayoutDashboard },
    { id: "explorer", label: t("product.explorer"), icon: Search },
    { id: "tail", label: t("product.liveTail"), icon: Radio },
    { id: "views", label: t("product.savedViews"), icon: Bookmark, count: summary.data?.alertsFiring || undefined },
    { id: "sources", label: t("product.sources"), icon: Cable, count: total(summary.data?.sources) || undefined },
    { id: "hosts", label: t("product.hosts"), icon: Server, count: total(summary.data?.hosts) || undefined },
  ];
  const footerNav = [
    { id: "agents", label: t("product.agents"), icon: Bot },
    { id: "settings", label: t("product.retention"), icon: Settings2 },
    ...(can("admin")
      ? [
          { id: "searches", label: t("product.whoSearched"), icon: Eye },
          { id: "members", label: t("product.members"), icon: Users },
          { id: "signin", label: t("product.signIn"), icon: LogIn },
          { id: "tokens", label: t("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("product.account"), icon: UserRound },
  ];
  const active = route.page === "source" ? "sources" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const page = route.page;
  return (
    <AppShell
      product="logs"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
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
        can("admin") ? (
          <SearchesPage call={call} />
        ) : (
          <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
        )
      ) : page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        page !== "account" && !can("admin") ? (
          <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
        ) : (
          <>
            <PageHeader
              title={ACCOUNT(t)[page][0]}
              description={ACCOUNT(t)[page][1]}
              actions={
                page === "account" && (
                  <Button icon={<LogOut />} onClick={() => void signOut()}>
                    {t("product.signOut")}
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
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Logs">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
