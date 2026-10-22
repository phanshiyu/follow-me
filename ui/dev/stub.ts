// Dev only. `npm run ui:dev` proxies the page's API to a running follow-me server. A server older
// than this page lacks submit, excluded, the JSON report and offer dismissal; these stand in for
// them, so the whole page can be driven before the server half lands. They answer only when the
// server says 404.

import type { Connect } from "vite";
import { lineNumbers } from "../src/lib/rows.ts";
import type { ReportItem, State } from "../src/lib/wire.ts";

const excluded = new Set<string>();
const dismissed = new Set<string>();

function itemsOf(state: State): ReportItem[] {
  const numbers = lineNumbers(state.units);
  const lines = (anchor: State["comments"][number]["anchor"]) => {
    if (anchor.kind !== "hunk")
      return { newLine: null, oldLine: null, startNewLine: null, startOldLine: null };
    const rows = (anchor.offsets ?? [])
      .map((i) => numbers.get(anchor.unit)?.[i])
      .filter((n) => n !== undefined);
    const news = rows.flatMap((n) => (n.new === null ? [] : [n.new]));
    const olds = rows.flatMap((n) => (n.old === null ? [] : [n.old]));
    const one = rows.length < 2;
    return {
      newLine: news.at(-1) ?? null,
      oldLine: news.length > 0 ? null : (olds.at(-1) ?? null),
      startNewLine: one ? null : (news[0] ?? null),
      startOldLine: one || news.length > 0 ? null : (olds[0] ?? null),
    };
  };
  return state.comments
    .filter((c) => c.author !== "agent")
    .map((c) => {
      const answer = c.replies?.findLast((r) => r.author === "agent")?.body;
      const body =
        c.kind === "question"
          ? `${c.body}${answer === undefined ? "" : `\n\n<details><summary>Answer</summary>\n\n${answer}\n\n</details>`}`
          : c.severity === undefined
            ? c.body
            : `**${c.severity}**\n\n${c.body}`;
      return {
        id: c.id,
        path: c.context.path,
        oldPath: c.context.path,
        ...lines(c.anchor),
        severity: c.severity ?? null,
        kind: c.kind === "question" ? "question" : "flag",
        body,
        thread: (c.replies ?? []).map((r) => ({ author: r.author, body: r.body })),
        resolved: false,
        excluded: excluded.has(c.id),
      };
    });
}

function json(res: Parameters<Connect.NextHandleFunction>[1], body: unknown): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: Connect.IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text === "" ? {} : JSON.parse(text);
}

export function stubs(target: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match =
      /^(\/s\/[^/]+)\/api\/(submit|excluded|report|state|offers\/[^/]+\/dismiss)(\?.*)?$/.exec(
        req.url ?? "",
      );
    if (match === null) return next();
    const [, session = "", route = "", query = ""] = match;
    if (route === "state" && dismissed.size === 0) return next();
    if (route === "report" && !query.includes("format=json")) return next();
    void (async () => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const real = await fetch(`${target}${req.url}`, {
        method: req.method ?? "GET",
        headers: { "content-type": "application/json", origin: target },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const isJson = real.headers.get("content-type")?.includes("json") ?? false;
      if (route === "state") {
        const state: State = await real.json();
        return json(res, { ...state, dismissedOffers: state.dismissedOffers ?? [...dismissed] });
      }
      if (real.status !== 404 && isJson) {
        res.statusCode = real.status;
        return json(res, await real.json());
      }
      if (route.startsWith("offers/")) {
        dismissed.add(route.split("/")[1] ?? "");
        return json(res, { dismissed: [...dismissed] });
      }
      if (route === "submit") return json(res, { released: 0 });
      if (route === "excluded") {
        const fields = typeof body === "object" && body !== null ? Object.entries(body) : [];
        const id = fields.find(([k]) => k === "comment" || k === "concern")?.[1];
        const off = fields.find(([k]) => k === "excluded")?.[1];
        if (typeof id === "string") {
          if (off === true) excluded.add(id);
          else excluded.delete(id);
        }
        return json(res, { excluded: [...excluded] });
      }
      const state: State = await (await fetch(`${target}${session}/api/state`)).json();
      return json(res, itemsOf(state));
    })().catch(next);
  };
}
