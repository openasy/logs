import { Button, Callout, PageHeader, Panel, QueryBar, StatusBadge } from "@openasy/ui";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Line } from "./api.ts";
import { LogHeader, LogRow } from "./explorer.tsx";
import { useT } from "./i18n.ts";

const KEEP = 500;

/** New lines as they arrive, newest on top, from the server-sent events of /api/v1/tail. */
export function TailPage({ params }: { params: URLSearchParams }) {
  const t = useT();
  const [draft, setDraft] = useState(params.get("q") ?? "*");
  const [query, setQuery] = useState(draft);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<Array<Line & { n: number }>>([]);
  const [state, setState] = useState<"connecting" | "streaming" | "error">("connecting");
  const [open, setOpen] = useState<number | null>(null);
  const seq = useRef(0);
  const held = useRef<Array<Line & { n: number }>>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setState("connecting");
    const es = new EventSource(`/api/v1/tail?${new URLSearchParams({ query })}`);
    es.onopen = () => setState("streaming");
    // EventSource reconnects by itself; the badge says when it is trying.
    es.onerror = () => setState("error");
    es.onmessage = (e: MessageEvent<string>) => {
      const line = { ...(JSON.parse(e.data) as Line), n: ++seq.current };
      if (pausedRef.current) held.current.push(line);
      else setLines((ls) => [line, ...ls].slice(0, KEEP));
    };
    return () => es.close();
  }, [query]);

  const resume = () => {
    setLines((ls) => [...held.current.reverse(), ...ls].slice(0, KEEP));
    held.current = [];
    setPaused(false);
  };

  return (
    <>
      <PageHeader
        title={t("tailPage.liveTail")}
        description={t("tailPage.linesSentToLogsAppear")}
        meta={paused ? <StatusBadge tone="neutral">{t("tailPage.paused")}</StatusBadge> : state === "streaming" ? <StatusBadge tone="success">{t("tailPage.streaming")}</StatusBadge> : <StatusBadge tone={state === "error" ? "warning" : "info"}>{state === "error" ? t("tailPage.reconnecting") : t("tailPage.connecting")}</StatusBadge>}
        actions={
          <Button variant={paused ? "primary" : "secondary"} icon={paused ? <Play /> : <Pause />} aria-pressed={paused} onClick={() => (paused ? resume() : setPaused(true))}>
            {paused ? t("tailPage.resume") : t("tailPage.pause")}
          </Button>
        }
      >
        <QueryBar
          value={draft}
          onChange={setDraft}
          onSubmit={(q) => {
            setLines([]);
            setQuery(q.trim() || "*");
          }}
          label={t("tailPage.tailQuery")}
          placeholder="service:checkout level:error"
        />
      </PageHeader>
      {state === "error" && (
        <Callout tone="warning" title={t("tailPage.theStreamStopped")}>
          {t("tailPage.logsIsReconnectingIfIt")}
        </Callout>
      )}
      <Panel title={t("tailPage.stream")} description={t("tailPage.shownNewestFirst", { length: lines.length, value: lines.length === 1 ? "line" : "lines", value2: paused && held.current.length ? `, ${held.current.length} waiting` : "" })} flush>
        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            <LogHeader />
            <ul aria-label={t("tailPage.liveLogLines")} aria-live={paused ? "off" : "polite"} className="m-0 flex list-none flex-col p-0">
              {lines.map((l) => (
                <LogRow key={l.n} id={`t${l.n}`} line={l} open={open === l.n} onToggle={() => setOpen((o) => (o === l.n ? null : l.n))} />
              ))}
            </ul>
            {lines.length === 0 && <p className="px-3 py-8 text-center text-sm text-fg-muted">{t("tailPage.waitingForLinesThatMatch")}</p>}
          </div>
        </div>
      </Panel>
    </>
  );
}
