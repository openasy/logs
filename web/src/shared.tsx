import { Button, DataTable, EmptyState, LevelBadge, StatusBadge, toLogLevel, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import { useT, type T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path now and every `everyMs`; `reload` loads it again at once. */
export function useData<T>(call: Call, path: string | null, everyMs = 15_000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!path) return;
    call<T>(path).then(
      (d) => {
        setData(d);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [call, path]);
  useEffect(() => {
    setData(undefined);
    load();
    if (!everyMs) return;
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, reload: load };
}

export const bytes = (n: number | null | undefined) => {
  if (n == null) return "–";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

export const count = (n: number | null | undefined) => (n == null ? "–" : new Intl.NumberFormat("en", { notation: n >= 100_000 ? "compact" : "standard" }).format(n));

/** A line's level as a badge; lines without one show none. */
export function Level({ level }: { level: string | null }) {
  return level ? <LevelBadge level={toLogLevel(level)} /> : <span aria-hidden />;
}

const STATUS = (t: T): Record<string, { tone: "success" | "warning" | "danger" | "info" | "neutral"; label: string }> => ({
  ok: { tone: "success", label: t("status.reading") },
  new: { tone: "info", label: t("status.new") },
  pending: { tone: "info", label: t("status.waitingForTheFirstRead") },
  "host-key-pending": { tone: "warning", label: t("status.checkTheHostKey") },
  "host-key-changed": { tone: "danger", label: t("status.hostKeyChanged") },
  unreachable: { tone: "danger", label: t("status.unreachable") },
  "auth-failed": { tone: "danger", label: t("status.loginRefused") },
  timeout: { tone: "warning", label: t("status.timedOut") },
  error: { tone: "danger", label: t("status.failed") },
});
export function Status({ status }: { status: string }) {
  const t = useT();
  const s = STATUS(t)[status] ?? { tone: "neutral" as const, label: status };
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

export function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/** A file, a command or a token to copy. */
export function Code({ children, label }: { children: string; label: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <pre tabIndex={0} aria-label={label} className="logs-code">
        {children}
      </pre>
      <div>
        <Button size="xs" icon={<Copy />} onClick={() => copy(children)}>
          {t("code.copy")}
        </Button>
      </div>
    </div>
  );
}

export function Pairs({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="logs-pairs text-sm">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A simple table of rows, with search over every column. */
export function List<T>({ label, rows, columns, empty, getRowId, pageSize = 50 }: { label: string; rows: T[] | undefined; columns: Column<T>[]; empty: string; getRowId: (r: T) => string; pageSize?: number }) {
  return <DataTable label={label} columns={columns} rows={rows ?? []} loading={!rows} getRowId={getRowId} pageSize={pageSize} density="compact" empty={<EmptyState title={empty} />} />;
}

/** The link to Explorer with a query. */
export const explore = (query: string) => `/explorer?${new URLSearchParams({ q: query })}`;

/** A LogsQL value, quoted when it has to be. */
export const quote = (v: string) => (/^[A-Za-z0-9_.\-/]+$/.test(v) ? v : JSON.stringify(v));
