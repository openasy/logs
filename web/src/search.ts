// What the search window (Cmd+K) finds in Logs: the explorer with the text as its query, saved views and sources by
// name.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Bookmark, Radio, ScrollText } from "lucide-react";
import type { Source, View } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [views, sources] = await Promise.all([
      call<{ views: View[] }>("/api/v1/views", { signal }),
      call<{ sources: Source[] }>("/api/v1/sources", { signal }),
    ]);
    const has = (...texts: string[]) => texts.some((x) => x.toLowerCase().includes(q));
    return [
      {
        id: "explore",
        label: t("search.linesWith", { text: q }),
        detail: t("search.inTheLastHour"),
        kind: t("search.query"),
        icon: ScrollText,
        href: `/explorer?${new URLSearchParams({ q })}`,
      },
      ...views.views
        .filter((v) => has(v.name, v.query))
        .slice(0, 6)
        .map((v): SearchResult => ({
          id: `view:${v.id}`,
          label: v.name,
          detail: v.query,
          kind: t("search.view"),
          icon: Bookmark,
          href: `/explorer?${new URLSearchParams({ view: v.id })}`,
        })),
      ...sources.sources
        .filter((s) => has(s.name))
        .slice(0, 6)
        .map((s): SearchResult => ({
          id: `source:${s.id}`,
          label: s.name,
          detail: s.kind,
          kind: t("search.source"),
          icon: Radio,
          href: `/sources/${encodeURIComponent(s.id)}`,
        })),
    ];
  };
}
