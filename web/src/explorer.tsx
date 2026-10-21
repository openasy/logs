import { Button, Callout, Checkbox, EntityChip, FacetFilter, FilterBar, LOG_LEVEL_META, navigate, PageHeader, Panel, QueryBar, StackedBarChart, StatusBadge, TextField, TimeRangePicker, TONE_COLORS, toLogLevel, cn } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Bookmark, ChevronRight, Radio } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Facets, Line, NewView, Search, View, Volume } from "./api.ts";
import { count, explore, Level, quote, useData, type Call } from "./shared.tsx";

const RANGES: Record<string, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440, "7d": 10_080, "30d": 43_200 };
/** Fields the facets filter on, in this order; the line's own columns. */
const FACETS = ["level", "service", "host", "source"] as const;

/** The query with the facet choices added as LogsQL filters. */
export function withFilters(query: string, picked: Record<string, string[]>): string {
  const filters = Object.entries(picked)
    .filter(([, v]) => v.length)
    .map(([f, v]) => (v.length === 1 ? `${f}:${quote(v[0]!)}` : `${f}:in(${v.map(quote).join(",")})`));
  const base = query.trim() || "*";
  return filters.length ? `${base === "*" ? "" : `(${base}) `}${filters.join(" ")}` : base;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

const ROW = "grid w-full grid-cols-[14px_96px_52px_110px_110px_minmax(0,1fr)] items-center gap-2 px-3 py-1 text-left";

export function LogHeader() {
  return (
    <div aria-hidden className="grid grid-cols-[14px_96px_52px_110px_110px_minmax(0,1fr)] gap-2 border-b border-line bg-canvas px-3 py-1.5 text-2xs font-medium tracking-wider text-fg-muted uppercase">
      <span />
      <span>Time</span>
      <span>Level</span>
      <span>Host</span>
      <span>Service</span>
      <span>Message</span>
    </div>
  );
}

/** One line; opened, its fields, each of which adds itself as a filter. */
export function LogRow({ line, id, open, onToggle, onFilter }: { line: Line; id: string; open: boolean; onToggle: () => void; onFilter?: (field: string, value: string) => void }) {
  const detailId = `log-detail-${id}`;
  const fields: Array<[string, string]> = [
    ...(["level", "host", "service", "source"] as const).flatMap((k): Array<[string, string]> => (line[k] ? [[k, line[k]]] : [])),
    ...Object.entries(line.fields).sort(([a], [b]) => a.localeCompare(b)),
  ];
  return (
    <li className={cn("border-b border-subtle last:border-0", open && "bg-canvas")}>
      <button type="button" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle} className={cn(ROW, "hover:bg-canvas")}>
        <ChevronRight aria-hidden className={cn("size-3.5 text-fg-muted transition-transform", open && "rotate-90")} />
        <span className="font-mono text-2xs text-fg-muted tabular-nums" title={line.time}>
          {time(line.time).split(" ").slice(-1)[0]}
        </span>
        <Level level={line.level} />
        <span className="truncate font-mono text-xs text-fg-muted">{line.host ?? ""}</span>
        <span className="truncate font-mono text-xs text-fg-muted">{line.service ?? ""}</span>
        <span className="truncate font-mono text-xs text-fg">{line.msg}</span>
      </button>
      {open && (
        <div id={detailId} role="region" aria-label={`Log details ${line.time}`} className="grid gap-3 border-t border-subtle px-3 py-2.5 pl-8 lg:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="logs-msg m-0 font-mono text-xs text-fg">{line.msg}</p>
            <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
              <div className="contents">
                <dt className="text-fg-muted">time</dt>
                <dd className="m-0 text-fg">{line.time}</dd>
              </div>
              {fields.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-muted">{k}</dt>
                  <dd className="m-0 text-fg">
                    {onFilter ? (
                      <button type="button" className="logs-field" title={`Show only lines with ${k} ${v}`} onClick={() => onFilter(k, v)}>
                        {v}
                      </button>
                    ) : (
                      v
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {line.host && (
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-xs font-semibold text-fg">This host</h3>
              <EntityChip kind="host" value={line.host} href={explore(`host:${quote(line.host)}`)} />
              {line.service && <EntityChip kind="process" value={line.service} href={explore(`service:${quote(line.service)}`)} />}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function SaveView({ call, query, onSaved }: { call: Call; query: string; onSaved: (v: View) => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(true);
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved((await call<NewView>("/api/v1/views", { method: "POST", body: JSON.stringify({ name, query, shared }) })).view);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title="Save this view" description={<span className="font-mono text-xs">{query}</span>}>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout errors" error={error} />
        <Checkbox label="Everyone can see it" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Save
        </Button>
      </form>
    </Panel>
  );
}

export function ExplorerPage({ call, params }: { call: Call; params: URLSearchParams }) {
  const { can } = useAuth();
  const viewId = params.get("view");
  const view = useData<View>(call, viewId ? `/api/v1/views/${viewId}` : null, 0).data;
  const initial = params.get("q") ?? "*";
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [range, setRange] = useState(params.get("range") ?? "1h");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<View>();
  // A new range or query is a new search: "now" moves with it.
  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    if (!view) return;
    setDraft(view.query);
    setQuery(view.query);
    setAt(Date.now());
  }, [view]);

  const full = withFilters(query, picked);
  const qs = useMemo(() => {
    const end = new Date(at);
    const start = new Date(at - RANGES[range]! * 60_000);
    return new URLSearchParams({ query: full, start: start.toISOString(), end: end.toISOString() }).toString();
  }, [full, range, at]);
  const search = useData<Search>(call, `/api/v1/search?${qs}&limit=500`, 0);
  const volume = useData<Volume>(call, `/api/v1/volume?${qs}`, 0);
  const facets = useData<Facets>(call, `/api/v1/facets?${new URLSearchParams({ query, start: new URLSearchParams(qs).get("start")!, end: new URLSearchParams(qs).get("end")! })}`, 0);

  const submit = (q: string) => {
    setQuery(q.trim() || "*");
    setOpen(null);
    setAt(Date.now());
  };
  const addFilter = (field: string, value: string) => {
    const next = `${query.trim() === "*" ? "" : `${query.trim()} `}${field}:${quote(value)}`;
    setDraft(next);
    submit(next);
  };
  const facetOf = (f: string) => facets.data?.fields.find((x) => x.field === f)?.values ?? [];
  const levels = [...(volume.data?.series ?? [])].sort((a, b) => (LOG_LEVEL_META[toLogLevel(b.level)]?.rank ?? -1) - (LOG_LEVEL_META[toLogLevel(a.level)]?.rank ?? -1));
  const total = levels.reduce((n, s) => n + s.total, 0);
  const anyPicked = Object.values(picked).some((v) => v.length);

  return (
    <>
      <PageHeader
        title={view ? view.name : "Explorer"}
        description={volume.data ? `${count(total)} lines in this range` : "Search every line kept, with LogsQL."}
        actions={
          <>
            <Button icon={<Radio />} onClick={() => navigate(`/tail?${new URLSearchParams({ q: full })}`)}>
              Live tail
            </Button>
            {can("editor") && (
              <Button icon={<Bookmark />} onClick={() => setSaving((s) => !s)} aria-expanded={saving}>
                Save view
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <QueryBar value={draft} onChange={setDraft} onSubmit={submit} label="Log query" placeholder='service:checkout level:error "timeout"' className="min-w-0 grow" />
          <TimeRangePicker
            value={range}
            onChange={(r) => {
              setRange(r);
              setAt(Date.now());
            }}
          />
        </div>
      </PageHeader>
      {saving && (
        <SaveView
          call={call}
          query={full}
          onSaved={(v) => {
            setSaved(v);
            setSaving(false);
          }}
        />
      )}
      {saved && (
        <Callout tone="success" title={`Saved as ${saved.name}`} onDismiss={() => setSaved(undefined)}>
          Find it under <a href="/views">Saved views</a>, where a threshold can also call a webhook.
        </Callout>
      )}
      <FilterBar onClear={anyPicked ? () => setPicked({}) : undefined}>
        {FACETS.map((f) => (
          <FacetFilter
            key={f}
            label={f.charAt(0).toUpperCase() + f.slice(1)}
            searchable={f === "host"}
            selected={picked[f] ?? []}
            onChange={(v) => setPicked((p) => ({ ...p, [f]: v }))}
            options={facetOf(f).map((v) => ({ value: v.value, label: f === "level" ? <Level level={v.value} /> : undefined, count: v.hits }))}
          />
        ))}
      </FilterBar>
      {(search.error || volume.error) && (
        <Callout tone="danger" title="The search did not run">
          {search.error ?? volume.error}
        </Callout>
      )}
      <Panel title="Lines over time" description={volume.data ? `By level, per ${volume.data.step}` : undefined}>
        {volume.data && volume.data.times.length > 0 ? (
          <StackedBarChart
            label="Lines over time by level"
            categories={volume.data.times.map((t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }))}
            segments={[...levels].reverse().map((s) => ({ id: s.level, name: s.level, color: TONE_COLORS[LOG_LEVEL_META[toLogLevel(s.level)]?.tone ?? "neutral"] }))}
            values={volume.data.times.map((_, i) => [...levels].reverse().map((s) => s.values[i] ?? 0))}
            height={120}
            xTicks={6}
          />
        ) : (
          <p className="m-0 py-6 text-center text-sm text-fg-muted">{volume.data ? "No lines in this range." : "Counting…"}</p>
        )}
      </Panel>
      <Panel
        title="Lines"
        description={search.data ? `${search.data.lines.length} newest first` : "Searching…"}
        actions={search.data?.truncated && <StatusBadge tone="info">More match: narrow the query or the range</StatusBadge>}
        flush
      >
        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            <LogHeader />
            <ul aria-label="Log lines" className="m-0 flex list-none flex-col p-0">
              {(search.data?.lines ?? []).map((l, i) => (
                <LogRow key={`${l.time}-${i}`} id={String(i)} line={l} open={open === i} onToggle={() => setOpen((o) => (o === i ? null : i))} onFilter={addFilter} />
              ))}
            </ul>
            {search.data?.lines.length === 0 && <p className="px-3 py-8 text-center text-sm text-fg-muted">No lines match. Widen the time range, or check the query.</p>}
          </div>
        </div>
      </Panel>
    </>
  );
}
