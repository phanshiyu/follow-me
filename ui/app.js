import {
  allConcerns,
  anchorLine,
  blockersToHold,
  bodyIndexes,
  concernsInChunk,
  dwellExtra,
  pickConcern,
  SEVERITIES,
  severityOf,
  toDecide,
  topSeverity,
  undecided,
  undecidedPrompt,
} from "/concerns.js";
import { componentsForAll, highlightBody, languageFor } from "/highlight.js";
import {
  applyEvent,
  backoffMs,
  bannerText,
  decisionsById,
  eventBody,
  keepCommit,
  nextSince,
} from "/live.js";
import {
  beatAt,
  beatStart,
  buildScript,
  chunkOf,
  commitOf,
  describeRows,
  diagramAt,
  duration,
  hasNarration,
  introOf,
  lineKey,
  lineNumbers,
  lineStates,
  parseSpeed,
  pickVoice,
  progress,
  rowsOf,
  SPEEDS,
  schedule,
  scopeOf,
  speechRate,
  speechTimeout,
} from "/playback.js";
import {
  answerCards,
  answeredCount,
  askAgain,
  cardsAt,
  holdAt,
  inferKind,
  kindCounts,
  statusLine,
} from "/questions.js";
import {
  anchorFor,
  lastShown,
  pickRow,
  rowsOfAnchor,
  selectionRange,
  snapshotRows,
  stepRow,
} from "/selection.js";
import { endSummary, reportPath } from "/summary.js";
import {
  anchorText,
  atBottom,
  beatFor,
  blocksOf,
  chipText,
  concernLine,
  dividerText,
  entriesHere,
  locate,
  quoteOf,
  snippet,
  timelineOf,
  unreadAfter,
} from "/timeline.js";

const $ = (id) => document.getElementById(id);

/** "/s/<id>": this page's session on the shared server. Every session API sits under it. */
const sessionPrefix = /^\/s\/[^/]+/.exec(location.pathname)?.[0] ?? "";

/** Builds an element. Text always goes through textContent, never innerHTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

let state = null;
let selected = 0;
let unitsById = new Map();
/** unit id -> per hunk line, its { old, new } file line numbers */
let numbers = new Map();
/** unit id -> (change index -> index of the commit that owns the line) */
let owners = new Map();
/**
 * The rows picked for a comment: a contiguous run of rows of one hunk as one commit shows it,
 * context and changes alike, as hunk body indices. from is where a range started.
 */
let selection = null;
/** The row to focus after the next render, as a data-line key. */
let focusRow = null;
/** A gutter drag in progress: the hunk element, the unit, and the rows it began and now ends on. */
let drag = null;
/** The comment box to focus after the next render. */
let focusKey = null;
/** Unsent textarea contents survive re-renders, keyed like the boxes. */
const drafts = new Map();
const openBoxes = new Set();
const editing = new Set();
/** key -> the kind picked for the box, and whether the reviewer chose it or the text implied it. */
const kindDrafts = new Map();
/** Answers shown or paused on, so a replay does not stop again. */
const seenAnswers = new Set();
/** Blockers playback already stopped on. */
const seenBlockers = new Set();
/** The previous version's questions with where they now sit, refreshed on every render. */
let cards = [];

/** Component scripts already requested, so a language shared by two files loads once. */
const scripts = new Map();

function loadScript(name) {
  if (!scripts.has(name)) {
    scripts.set(
      name,
      new Promise((resolve, reject) => {
        const node = el("script", { src: `/vendor/prism/${name}.js` });
        node.addEventListener("load", resolve);
        node.addEventListener("error", () => reject(new Error(`Prism ${name} did not load`)));
        document.head.append(node);
      }),
    );
  }
  return scripts.get(name);
}

/**
 * Loads Prism and the grammars for the plan's files, and only those. Without a known language
 * nothing is fetched. A failed load leaves the code plain, which is still a complete review.
 */
async function loadHighlighting(units) {
  const languages = new Set(
    units.flatMap((u) => (u.kind === "hunk" ? [languageFor(u.path)] : [])).filter(Boolean),
  );
  const names = componentsForAll(languages);
  if (names.length === 0) return;
  try {
    // Prism reads this before it runs, and then waits to be called instead of scanning the page.
    window.Prism ??= { manual: true };
    await loadScript("core");
    for (const name of names) await loadScript(name);
  } catch {
    // Plain code is the fallback.
  }
}

/** unit id -> its lines as coloured spans, or null when the file stays plain. */
const highlighted = new Map();

function spansOf(unit) {
  if (!highlighted.has(unit.id)) {
    const grammar = window.Prism?.languages?.[languageFor(unit.path)];
    highlighted.set(
      unit.id,
      grammar ? highlightBody(unit.body, (text) => window.Prism.tokenize(text, grammar)) : null,
    );
  }
  return highlighted.get(unit.id);
}

const RETRY_MS = 400;

/** A write during a plan swap or an end answers 409; it is safe to repeat once a moment later. */
async function api(method, path, body, retried = false) {
  const res = await fetch(`${sessionPrefix}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 409 && method !== "GET" && !retried) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    return api(method, path, body, true);
  }
  if (!res.ok) throw new Error(payload.error ?? `${method} ${path} failed with ${res.status}`);
  return payload;
}

/** Links to every session the server hosts, so one tab can move between workstreams. */
async function renderSwitcher() {
  const res = await fetch("/api/sessions").catch(() => null);
  if (!res?.ok) return;
  const sessions = await res.json();
  const here = `${sessionPrefix}/`;
  const nav = $("sessions");
  nav.hidden = sessions.length < 2;
  nav.replaceChildren(
    ...sessions.map((s) =>
      el("a", {
        href: s.url,
        title: s.repo,
        "aria-current": s.url === here ? "page" : undefined,
        text: s.mode === "walk" ? `${s.branch} (walk)` : `${s.branch} v${s.version}`,
      }),
    ),
    el("a", { href: "/", text: "All sessions" }),
  );
}

function report(error) {
  const status = $("status");
  status.textContent = error ? error.message : "";
  status.classList.toggle("error", Boolean(error));
}

async function guarded(action) {
  try {
    report(null);
    await action();
  } catch (error) {
    report(error);
  }
}

function indexOwnership() {
  unitsById = new Map(state.units.map((unit) => [unit.id, unit]));
  numbers = lineNumbers(state.units);
  owners = new Map();
  for (const commit of state.commits) {
    for (const ref of commit.refs) {
      if (ref.select.kind !== "lines") continue;
      const byChange = owners.get(ref.unit) ?? new Map();
      for (const change of ref.select.changes) byChange.set(change, commit.index);
      owners.set(ref.unit, byChange);
    }
  }
}

async function reloadComments() {
  const fresh = await api("GET", "/api/state");
  state.comments = fresh.comments;
  render();
}

function sameAnchor(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "plan") return true;
  if (a.commit !== b.commit) return false;
  return a.kind !== "hunk" || a.unit === b.unit;
}

function commentsAt(anchor) {
  return state.comments.filter((comment) => sameAnchor(comment.anchor, anchor));
}

function firstLine(message) {
  return message.split("\n")[0] ?? "";
}

/**
 * While rows are picked, the box under them and the composer in the panel write one comment, so
 * what is typed in either shows in both. The other one's key, or null.
 */
function mirrorOf(key) {
  if (selection === null) return null;
  const box = boxKey(selection.commit, selection.unit);
  if (key === "composer") return box;
  return key === box ? "composer" : null;
}

function mirrorDraft(key, value) {
  const other = mirrorOf(key);
  if (other === null) return;
  drafts.set(other, value);
  const area = document.querySelector(`[data-box="${other}"] textarea`);
  if (area instanceof HTMLTextAreaElement && area.value !== value) area.value = value;
}

/**
 * A comment textarea with its buttons. Cmd or Ctrl+Enter saves and Escape cancels; neither
 * resumes playback.
 */
function commentForm({
  key,
  placeholder,
  action = "Comment",
  initial = "",
  submit,
  close,
  kinds = false,
  startKind,
}) {
  const fresh =
    startKind === undefined
      ? { kind: inferKind(drafts.get(key) ?? ""), touched: false, severity: "" }
      : { kind: startKind, touched: true, severity: "" };
  const choice = kindDrafts.get(key) ?? kindDrafts.get(mirrorOf(key)) ?? fresh;
  if (kinds) kindDrafts.set(key, choice);
  const toggles = new Map();
  const paint = () => {
    for (const [kind, button] of toggles) {
      button.setAttribute("aria-pressed", String(choice.kind === kind));
    }
  };
  const area = el("textarea", {
    placeholder,
    "aria-label": placeholder,
    oninput: () => {
      drafts.set(key, area.value);
      mirrorDraft(key, area.value);
      if (kinds && !choice.touched) {
        choice.kind = inferKind(area.value);
        paint();
      }
    },
  });
  area.value = drafts.get(key) ?? initial;
  const done = () => {
    for (const k of [key, mirrorOf(key)]) {
      drafts.delete(k);
      kindDrafts.delete(k);
    }
  };
  const cancel = () => {
    done();
    close();
    render();
  };
  const save = () =>
    guarded(async () => {
      const body = area.value.trim();
      if (!body) return;
      await submit(body, choice.kind, choice.severity);
      done();
      close();
      if (player.view === "play") notice = "Comment saved. Space to continue.";
      await reloadComments();
    });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  const toggle = el("div", { class: "kind", role: "group", "aria-label": "Kind of comment" });
  for (const [kind, text] of [
    ["question", "Ask a question"],
    ["change", isWalk() ? "Code comment" : "Request a change"],
  ]) {
    const button = el("button", {
      type: "button",
      text,
      onclick: () => {
        choice.kind = kind;
        choice.touched = true;
        if (mirrorOf(key) === null) {
          paint();
          area.focus();
        } else {
          // The same pick has a box under its rows and the composer; redraw so both show it.
          focusKey = key;
          render();
        }
      },
    });
    toggles.set(kind, button);
    toggle.append(button);
  }
  paint();
  const severity = el("select", {
    "aria-label": "Severity, optional",
    onchange: () => {
      choice.severity = severity.value;
    },
  });
  severity.append(el("option", { value: "", text: "No severity" }));
  for (const level of [...SEVERITIES].reverse()) {
    severity.append(el("option", { value: level, text: level }));
  }
  severity.value = choice.severity;
  if (kinds) toggle.append(severity);
  return el(
    "div",
    { class: "box", "data-box": key },
    kinds ? toggle : null,
    area,
    el(
      "div",
      { class: "row" },
      el("button", { class: "primary", text: action, onclick: save }),
      el("button", { text: "Cancel", onclick: cancel }),
      el("span", { class: "hint", text: "⌘/Ctrl+Enter to save, Esc to cancel" }),
    ),
  );
}

/** Mermaid sources a reply carried, drawn once each, so a re-render only copies the picture. */
const replyDiagrams = new Map();

/** What a failed diagram shows: the message, and the source folded under it. */
function diagramFailure(message, source) {
  return [
    el("pre", { class: "diagram-error", text: message }),
    el("details", {}, el("summary", { text: "Diagram source" }), el("pre", { text: source })),
  ];
}

function fillDiagram(node, drawn) {
  if (drawn.svg !== undefined) {
    // Mermaid sanitizes its own output under securityLevel "strict".
    node.innerHTML = drawn.svg;
  } else {
    node.replaceChildren(...diagramFailure(drawn.error, node.getAttribute("data-source") ?? ""));
  }
}

/** Opens a drawn diagram large, in a dialog that scrolls and starts fitted to its width. */
function expandDiagram(svgHost, title) {
  const svg = svgHost.querySelector("svg");
  if (!svg) return;
  const body = $("dialog-body");
  const copy = svg.cloneNode(true);
  copy.removeAttribute("style");
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  body.replaceChildren(copy);
  body.classList.add("fit");
  $("dialog-title").textContent = title;
  $("dialog-fit").textContent = "Actual size";
  $("diagram-dialog").showModal();
}

async function drawReplyDiagram(source) {
  if (replyDiagrams.has(source)) return;
  replyDiagrams.set(source, null);
  drawing += 1;
  let drawn;
  try {
    const { svg } = await (await loadMermaid()).render(`reply-diagram-${drawing}`, source);
    drawn = { svg };
  } catch (error) {
    drawn = { error: `Mermaid could not draw this diagram: ${error?.message ?? String(error)}` };
  }
  replyDiagrams.set(source, drawn);
  for (const node of document.querySelectorAll(".reply-diagram")) {
    if (node.getAttribute("data-source") === source) fillDiagram(node, drawn);
  }
}

function diagramSlot(source) {
  const node = el("div", { class: "reply-diagram", "data-source": source });
  const drawn = replyDiagrams.get(source);
  if (drawn) fillDiagram(node, drawn);
  else drawReplyDiagram(source);
  return el(
    "div",
    { class: "diagram-box" },
    node,
    el("button", {
      type: "button",
      class: "expand",
      text: "Expand",
      onclick: () => expandDiagram(node, "Diagram"),
    }),
  );
}

/**
 * Agent text: paragraphs with code spans, fenced blocks that scroll, and past 12 lines a fold with
 * Show more. Whether it overflows is measured after it is on the page, so wrapped lines count.
 */
function agentText(id, text) {
  const open = openFolds.has(id);
  const clamp = el(
    "div",
    { class: open ? "said clamp open" : "said clamp" },
    ...blocksOf(text).map((block) =>
      block.kind === "pre"
        ? el("pre", { class: "fenced", text: block.text })
        : el(
            "p",
            {},
            ...block.spans.map((span) => (span.code ? el("code", { text: span.text }) : span.text)),
          ),
    ),
  );
  return el(
    "div",
    { class: "fold-wrap" },
    clamp,
    el("button", {
      type: "button",
      class: "link fold-toggle",
      hidden: true,
      text: open ? "Show less" : "Show more",
      onclick: () => {
        if (openFolds.has(id)) openFolds.delete(id);
        else openFolds.add(id);
        renderTimeline();
      },
    }),
  );
}

/** Shows the Show more button on the folds that overflow their twelve lines. */
function measureFolds() {
  for (const wrap of $("timeline").querySelectorAll(".fold-wrap")) {
    const clamp = wrap.querySelector(".clamp");
    const toggle = wrap.querySelector(".fold-toggle");
    toggle.hidden = !(
      clamp.classList.contains("open") || clamp.scrollHeight > clamp.clientHeight + 1
    );
  }
}

function commentLabel(comment) {
  if (comment.kind === "question") return "Question";
  return isWalk() ? "Code comment" : "Change request";
}

/**
 * The one line a thread leaves in the code: "Question · 2 replies · answered". It opens the
 * thread in the panel, where all writing happens.
 */
function commentChip(comment) {
  const label = chipText(comment, {
    walk: isWalk(),
    resolved: state.resolved.includes(comment.id),
  });
  const classes = ["thread-chip"];
  if (comment.kind === "question") classes.push("question");
  if (comment.author === "agent") classes.push("agent");
  return el("button", {
    type: "button",
    class: classes.join(" "),
    title: "Open this thread in the conversation",
    text: `${comment.kind === "question" ? "? " : ""}${label}`,
    onclick: () => focusThread(comment.id),
  });
}

/** Shows a thread in the panel: opens the panel, clears the filter, scrolls to it and flashes it. */
function focusThread(id) {
  if (onlyHere) {
    onlyHere = false;
    renderNow();
    renderTimeline();
  }
  revealEntry(`c:${id}`);
}

/** Marks a previous question resolved or reopens it; the server's event repeats it harmlessly. */
function setResolved(card, resolved) {
  return guarded(async () => {
    await api("POST", "/api/resolved", { comment: card.id, resolved });
    const others = state.resolved.filter((id) => id !== card.id);
    state.resolved = resolved ? [...others, card.id] : others;
    render();
  });
}

function explainedIn(card) {
  const { place } = card;
  if (place === null) return null;
  const path = place.unit === null ? null : unitsById.get(place.unit)?.path;
  return `${path ? `${path} in ` : ""}commit ${place.commit + 1}`;
}

/** The previous version's question with the agent's answer, where it now lives. */
function answerView(card) {
  const { comment, response, place } = card;
  if (card.resolved) {
    return el(
      "div",
      { class: "answer resolved", "data-answer": card.id },
      el("span", { text: `✓ Resolved · ${firstLine(comment.body)}` }),
      el("button", { class: "link", text: "Reopen", onclick: () => setResolved(card, false) }),
    );
  }
  const againKey = `again:${card.id}`;
  const lines = comment.context.lines ?? [];
  const followUps = state.comments.filter((c) => c.follows === card.id);
  return el(
    "section",
    { class: "answer", "data-answer": card.id, "aria-label": "Answer to your question" },
    el("div", {
      class: "meta",
      text: `You asked (v${state.previous.version}) · ${statusLine(card)}`,
    }),
    el("div", { class: "said", text: comment.body }),
    lines.length > 0 ? el("pre", { class: "quote", text: lines.join("\n") }) : null,
    response ? el("div", { class: "meta", text: "Answer" }) : null,
    response ? el("div", { class: "said", text: response.note }) : null,
    place === null && comment.anchor.kind === "hunk"
      ? el("div", { class: "meta", text: "The code you asked about has changed since." })
      : null,
    place === null ? null : el("div", { class: "meta", text: `Explained in ${explainedIn(card)}` }),
    ...(place?.continues ?? []).map((commit) =>
      el("button", {
        class: "link",
        text: `continues in commit ${commit + 1}`,
        onclick: () => select(commit, { focus: true }),
      }),
    ),
    ...followUps.map(commentChip),
    openBoxes.has(againKey)
      ? commentForm({
          key: againKey,
          placeholder: "What is still unclear?",
          action: "Ask again",
          submit: (body) => api("POST", "/api/comments", askAgain(card, body)),
          close: () => openBoxes.delete(againKey),
        })
      : el(
          "div",
          { class: "answer-actions" },
          el("button", {
            class: "primary",
            text: "Resolved",
            onclick: () => setResolved(card, true),
          }),
          el("button", {
            text: "Ask again",
            onclick: () => {
              openBoxes.add(againKey);
              focusKey = againKey;
              render();
            },
          }),
        ),
  );
}

/** While playing, an answer waits for its moment; browsing shows every one. */
function visibleCards(list) {
  return player.view === "play" ? list.filter((c) => seenAnswers.has(c.id) || c.resolved) : list;
}

function showAnswer(card) {
  seenAnswers.add(card.id);
  if (card.place !== null) select(card.place.commit);
  else render();
  document.querySelector(`[data-answer="${card.id}"]`)?.scrollIntoView({ block: "center" });
}

/** The sidebar list of the previous version's questions. Answers with no place show in full. */
function renderAnswers() {
  const panel = $("answers");
  panel.hidden = cards.length === 0;
  if (cards.length === 0) return;
  const open = cards.filter((c) => !c.resolved).length;
  panel.replaceChildren(
    el("strong", { text: `Answers · ${open} to read` }),
    ...cards.map((card) =>
      el(
        "div",
        { class: "answer-entry" },
        el("button", {
          type: "button",
          class: card.resolved ? "answer-row done" : "answer-row",
          text: `${statusLine(card)} · ${firstLine(card.comment.body)}`,
          onclick: () => showAnswer(card),
        }),
        card.place === null && !card.resolved ? answerView(card) : null,
      ),
    ),
  );
}

/** Severity picked for an undecided concern, applied when it is kept. */
const pickedSeverity = new Map();

/** Records a decision on a concern; the server's event repeats it harmlessly. */
function decide(concern, decision, extra = {}) {
  return guarded(async () => {
    const severity = extra.severity ?? pickedSeverity.get(concern.id);
    const body = {
      decision,
      ...(severity && severity !== concern.severity ? { severity } : {}),
      ...(extra.note === undefined ? {} : { note: extra.note }),
    };
    await api("POST", `/api/concerns/${concern.id}`, body);
    state.decisions = { ...state.decisions, [concern.id]: { concern: concern.id, ...body } };
    pickedSeverity.delete(concern.id);
    if (player.view === "play") notice = null;
    render();
  });
}

function severitySelect(current, onchange) {
  const select = el("select", { "aria-label": "Severity" });
  for (const level of SEVERITIES) {
    select.append(el("option", { value: level, text: level }));
  }
  select.value = current;
  select.addEventListener("change", () => onchange(select.value));
  return select;
}

/**
 * The agent's concern as a card in its own voice. It is never spoken. Undecided it offers keep and
 * dismiss; kept it takes the reviewer's own words; dismissed it folds to one row.
 */
function concernView(concern, { after } = {}) {
  const decision = state.decisions[concern.id];
  const verdict = decision?.decision ?? "undecided";
  const level = severityOf(concern, state.decisions);
  const attrs = { "data-concern": concern.id, "data-after": after };
  if (verdict === "dismissed") {
    return el(
      "div",
      { class: "concern dismissed", ...attrs },
      el("span", { text: `Dismissed · ${concern.text}` }),
      el("button", {
        class: "link",
        text: "Undo",
        onclick: () => decide(concern, "kept"),
      }),
    );
  }
  const noteKey = `note:${concern.id}`;
  return el(
    "section",
    {
      class: `concern sev-${level} ${verdict}`,
      "aria-label": `Agent concern, ${level}`,
      ...attrs,
    },
    el(
      "div",
      { class: "concern-head" },
      el("span", { class: "who", text: "Agent" }),
      el("span", { class: "chip", text: level }),
      el("span", { class: "kind-tag", text: concern.kind }),
      verdict === "kept" ? el("span", { class: "verdict", text: "Kept" }) : null,
    ),
    el("div", { class: "said", text: concern.text }),
    verdict === "kept" && decision.note
      ? el("div", { class: "said mine", text: `You: ${decision.note}` })
      : null,
    verdict === "kept"
      ? commentForm({
          key: noteKey,
          placeholder: "Your words (optional)",
          action: "Save note",
          initial: decision.note ?? "",
          submit: (note) => decide(concern, "kept", { note, severity: level }),
          close: () => {},
        })
      : null,
    el(
      "div",
      { class: "concern-actions" },
      verdict === "undecided"
        ? el("button", {
            class: "primary",
            text: "Keep",
            title: "Keep this concern in the report (y)",
            onclick: () => decide(concern, "kept"),
          })
        : null,
      el("button", {
        text: "Dismiss",
        title: "Drop this concern (x)",
        onclick: () => decide(concern, "dismissed"),
      }),
      el(
        "label",
        { class: "sev-pick" },
        "Severity ",
        severitySelect(level, (next) => {
          if (verdict === "kept") decide(concern, "kept", { severity: next, note: decision.note });
          else {
            pickedSeverity.set(concern.id, next);
            render();
          }
        }),
      ),
    ),
  );
}

/** The commit's concerns with no unit, shown under its message. */
function commitConcerns(commit) {
  return (commit.concerns ?? []).filter((c) => c.unit === undefined);
}

/** Concerns on the commit that are still undecided, for the list dot and the stage reminder. */
function openConcerns() {
  return undecided(allConcerns(state.commits), state.decisions);
}

/** The concern y and x act on: the chunk on screen, else the commit being read. */
function actionableConcern() {
  const commit = state.commits[selected];
  if (!commit) return null;
  const at = player.view === "play" ? currentBeat() : -1;
  const unit = beats[at]?.kind === "chunk" ? unitsById.get(beats[at].unit) : undefined;
  const chunk =
    unit?.kind === "hunk" ? concernsInChunk(commit.concerns ?? [], beats, at, unit.body) : [];
  return pickConcern(commit.concerns ?? [], chunk, state.decisions);
}

function decideCurrent(decision) {
  const concern = actionableConcern();
  if (concern) decide(concern, decision);
}

/** Only a question is written with a kind; absent means a change request. */
function kindField(kind) {
  return kind === "question" ? { kind } : {};
}

/** A reviewer's own severity rating, when they gave one. */
function rated(severity) {
  return severity ? { severity } : {};
}

/** A button that opens into a comment form, focused. */
function commentBox({ key, label, placeholder, anchor, context }) {
  if (!openBoxes.has(key)) {
    return el("button", {
      text: label,
      onclick: () => {
        openBoxes.add(key);
        focusKey = key;
        render();
      },
    });
  }
  return commentForm({
    key,
    placeholder,
    kinds: true,
    submit: (body, kind, severity) =>
      api("POST", "/api/comments", {
        anchor,
        context,
        body,
        ...kindField(kind),
        ...rated(severity),
      }),
    close: () => openBoxes.delete(key),
  });
}

function describeFileUnit(unit) {
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.reason} file ${change}`;
}

/** Body indices of a commit's own change lines in a unit, in hunk order. */
function ownLines(unit, commitIndex) {
  return rowsOf(unit.body, ownersOf(unit), commitIndex).flatMap((r) =>
    r.kind === "line" && r.mine ? [r.line] : [],
  );
}

/** The row a .dl element shows, as an index into its hunk body. */
function rowIndex(node) {
  return Number(node.dataset.line.slice(node.dataset.line.lastIndexOf(":") + 1));
}

/** The rows a hunk shows right now, in order; playback hides the ones not yet revealed. */
function shownRows(diff) {
  return [...diff.querySelectorAll(".dl:not(.pending)")].map(rowIndex);
}

function hunkOf(unit, commitIndex) {
  return { id: unit.id, commit: commitIndex, body: unit.body, owners: ownersOf(unit) };
}

function boxKey(commitIndex, unitId) {
  return `line:${commitIndex}:${unitId}`;
}

/**
 * Makes a pick the page's selection and redraws. A mouse pick takes you to the comment box; a key
 * pick keeps focus on the row, so the next arrow can extend it. Pauses playback.
 */
function setPick(unit, commitIndex, pick, { box, focus }) {
  selection = pick === null ? null : { commit: commitIndex, unit: unit.id, ...pick };
  if (box && pick !== null) focusKey = boxKey(commitIndex, unit.id);
  else focusRow = focus === undefined ? null : lineKey(unit.id, focus);
  if (player.playing) pause();
  render();
}

/** The pick in this hunk, or null when the selection is elsewhere. */
function pickIn(unit, commitIndex) {
  return selection?.unit === unit.id && selection.commit === commitIndex ? selection : null;
}

/** Click or shift-click on a row. */
function pickLine(unit, commitIndex, line, diff, extend) {
  const next = pickRow(shownRows(diff), pickIn(unit, commitIndex), line, { extend });
  setPick(unit, commitIndex, next, { box: true, focus: line });
}

function clearPick() {
  if (selection === null) return;
  const { unit, from } = selection;
  selection = null;
  focusRow = lineKey(unit, from);
  render();
}

function postPick(unit, commit, lines, body, kind, severity) {
  return api("POST", "/api/comments", {
    anchor: anchorFor(hunkOf(unit, commit.index), lines),
    context: {
      commitMessage: commit.message,
      path: unit.path,
      lines: snapshotRows(unit.body, lines),
    },
    body,
    ...kindField(kind),
    ...rated(severity),
  });
}

function lineBox(unit, commit) {
  const { lines } = selection;
  return commentForm({
    key: boxKey(commit.index, unit.id),
    placeholder: `Comment on ${describeRows(unit.body, numbers.get(unit.id) ?? [], lines)}`,
    kinds: true,
    submit: (body, kind, severity) => postPick(unit, commit, lines, body, kind, severity),
    close: () => {
      selection = null;
    },
  });
}

/** One row of a hunk. Every row can be picked for a comment: context, changes, all of them. */
function diffLine(unit, commit, index, mine, marked) {
  const line = unit.body[index];
  const key = lineKey(unit.id, index);
  const spans = spansOf(unit)?.[index];
  const text = spans
    ? el(
        "span",
        { class: "text" },
        ...spans.map((s) =>
          el("span", { class: s.tone ? `tok-${s.tone}` : undefined, text: s.text }),
        ),
      )
    : el("span", { class: "text", text: line.text.replace(/\n$/, "") });
  const at = numbers.get(unit.id)?.[index];
  const gutter = el(
    "span",
    { class: "gutter" },
    el("button", {
      type: "button",
      class: "add-comment",
      tabindex: "-1",
      "aria-label": "Comment on this line",
      text: "+",
    }),
    el("span", { class: "ln", text: at?.old == null ? "" : String(at.old) }),
    el("span", { class: "ln", text: at?.new == null ? "" : String(at.new) }),
  );
  const picked = pickIn(unit, commit.index)?.lines.includes(index) ?? false;
  const classes = ["dl"];
  if (mine) classes.push(line.op === "+" ? "add" : "del", "mine");
  if (picked) classes.push("picked");
  if (marked) classes.push("marked");
  const what = mine ? (line.op === "+" ? "Added" : "Removed") : "Context";
  return el(
    "div",
    {
      class: classes.join(" "),
      "data-line": key,
      onmousedown: (event) => {
        // Shift-click extends the pick; without this it also selects page text.
        if (event.shiftKey) event.preventDefault();
        else if (event.button === 0 && event.target.closest(".gutter")) {
          event.preventDefault();
          drag = {
            diff: event.currentTarget.closest(".diff"),
            unit,
            commit: commit.index,
            from: index,
            to: index,
          };
        }
      },
      onclick: (event) => {
        // Dragging over text to copy it is not a pick.
        if (!event.shiftKey && window.getSelection()?.toString()) return;
        pickLine(unit, commit.index, index, event.currentTarget.closest(".diff"), event.shiftKey);
      },
      onkeydown: (event) => lineKeys(event, unit, commit.index, index),
      tabindex: "-1",
      "aria-label": `${what}: ${line.text.trim() || "blank line"}`,
      "aria-selected": picked ? "true" : undefined,
    },
    gutter,
    el("span", { class: "op", text: mine ? line.op : " " }),
    text,
  );
}

/** Gutter drag: rows under the pointer light up, and letting go makes them the pick. */
document.addEventListener("mouseover", (event) => {
  if (drag === null) return;
  const row = event.target.closest?.(".dl");
  if (!row || row.closest(".diff") !== drag.diff || rowIndex(row) === drag.to) return;
  drag.to = rowIndex(row);
  const range = new Set(selectionRange(shownRows(drag.diff), drag.from, drag.to));
  for (const node of drag.diff.querySelectorAll(".dl")) {
    node.classList.toggle("picked", range.has(rowIndex(node)));
  }
});

document.addEventListener("mouseup", () => {
  if (drag === null) return;
  const done = drag;
  drag = null;
  // A gutter click that never left its row is an ordinary click, which picks the row itself.
  if (done.from === done.to) return;
  const lines = selectionRange(shownRows(done.diff), done.from, done.to);
  setPick(done.unit, done.commit, { from: done.from, lines }, { box: true });
});

/**
 * Inside a hunk every row is one roving tab stop: arrows move between rows, Shift extends the
 * pick, Space or Enter picks the row, Escape clears the pick.
 */
function lineKeys(event, unit, commitIndex, index) {
  const diff = event.currentTarget.closest(".diff");
  const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (move !== undefined) {
    const to = stepRow(shownRows(diff), index, move);
    if (event.shiftKey) {
      const base = pickIn(unit, commitIndex) ?? { from: index, lines: [index] };
      const next = pickRow(shownRows(diff), base, to, { extend: true });
      setPick(unit, commitIndex, next, { box: false, focus: to });
    } else {
      const target = diff.querySelector(`[data-line="${lineKey(unit.id, to)}"]`);
      if (target) {
        event.currentTarget.tabIndex = -1;
        target.tabIndex = 0;
        target.focus();
      }
    }
  } else if (event.key === " " || event.key === "Enter") {
    const next = pickRow(shownRows(diff), pickIn(unit, commitIndex), index, {
      extend: event.shiftKey,
    });
    setPick(unit, commitIndex, next, { box: false, focus: index });
  } else if (event.key === "Escape" && selection !== null) {
    clearPick();
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

/** Gives each hunk one tab stop, on its first shown row. */
function rovingLines() {
  for (const diff of $("main").querySelectorAll(".diff")) {
    const first = diff.querySelector(".dl:not(.pending)");
    if (first) first.tabIndex = 0;
  }
}

/** Lines a later commit adds, folded into one row that leads to that commit. */
function foldRow(lines, owner) {
  const n = lines.length;
  return el("button", {
    type: "button",
    class: "fold",
    text: `${n} line${n === 1 ? "" : "s"} arrive${n === 1 ? "s" : ""} in commit ${owner + 1}`,
    onclick: () => select(owner),
  });
}

function ownersOf(unit) {
  const byChange = owners.get(unit.id);
  return Array.from({ length: unit.changeCount }, (_, c) => byChange?.get(c));
}

function unitComments(unit, commit, loose) {
  const anchor = { kind: "hunk", unit: unit.id, commit: commit.index, changes: null };
  return el(
    "div",
    { class: "comments" },
    ...loose.map(commentChip),
    el(
      "div",
      { class: "controls" },
      commentBox({
        key: `box:${commit.index}:${unit.id}`,
        label: unit.kind === "hunk" ? "Comment on this hunk" : "Comment",
        placeholder: "What about this change?",
        anchor,
        context: { commitMessage: commit.message, path: unit.path },
      }),
    ),
  );
}

/** Narration shown in place while browsing; playback moves its own card instead. */
function staticNarration(text) {
  if (!text || player.view === "play") return null;
  return el("blockquote", { class: "narration" }, text);
}

function unitView(unit, commit) {
  const ref = commit.refs.find((r) => r.unit === unit.id);
  const head = el("div", { class: "unit-head", title: unit.id });
  let content;
  let looseComments = commentsAt({
    kind: "hunk",
    unit: unit.id,
    commit: commit.index,
    changes: null,
  });
  if (unit.kind === "hunk") {
    const rows = rowsOf(unit.body, ownersOf(unit), commit.index);
    const first = rows.find((r) => r.kind === "line" && r.mine);
    const scope = first === undefined ? null : scopeOf(unit.body, first.line);
    const mineCount = rows.filter((r) => r.kind === "line" && r.mine).length;
    head.append(
      el("span", { class: "scope", text: scope === null ? "" : `in ${scope}` }),
      el("span", { class: "spacer" }),
      el("span", {
        text: `${mineCount} of ${unit.changeCount} changed lines in this commit`,
      }),
    );
    const picking = pickIn(unit, commit.index) !== null;
    const boxAfter = picking ? Math.max(...selection.lines) : -1;
    const shown = new Set(rows.flatMap((r) => (r.kind === "line" ? [r.line] : [])));
    // A comment sits under its last row; one on the whole hunk, or whose rows are gone, under it.
    const sitting = new Map();
    const loose = [];
    const marked = new Set();
    for (const comment of commentsAt({ kind: "hunk", unit: unit.id, commit: commit.index })) {
      const anchored = rowsOfAnchor(comment.anchor, unit.body);
      const under = lastShown(anchored, shown);
      for (const row of anchored) marked.add(row);
      if (under === null) loose.push(comment);
      else sitting.set(under, [...(sitting.get(under) ?? []), comment]);
    }
    const own = ownLines(unit, commit.index);
    const raised = (commit.concerns ?? []).filter((c) => c.unit === unit.id);
    const under = new Map();
    for (const concern of raised) {
      const at = anchorLine(concern, unit.body, own);
      if (at !== null) under.set(at, [...(under.get(at) ?? []), concern]);
    }
    const flagged = new Map(
      raised.flatMap((c) =>
        bodyIndexes(unit.body, c.lines ?? []).map((i) => [i, severityOf(c, state.decisions)]),
      ),
    );
    looseComments = loose;
    content = el(
      "div",
      { class: "diff" },
      ...rows.flatMap((row) => {
        if (row.kind === "fold") return [foldRow(row.lines, row.commit)];
        const line = diffLine(unit, commit, row.line, row.mine, marked.has(row.line));
        const level = flagged.get(row.line);
        if (level) line.classList.add("flagged", `flag-${level}`);
        const cardsUnder = (under.get(row.line) ?? []).map((c) =>
          concernView(c, { after: lineKey(unit.id, row.line) }),
        );
        const said = (sitting.get(row.line) ?? []).map((comment) => {
          const node = commentChip(comment);
          node.dataset.after = lineKey(unit.id, row.line);
          return node;
        });
        return [
          line,
          ...cardsUnder,
          ...said,
          ...(row.line === boxAfter ? [lineBox(unit, commit)] : []),
        ];
      }),
    );
  } else {
    const summary =
      unit.kind === "file" ? describeFileUnit(unit) : `mode change ${unit.from} → ${unit.to}`;
    head.append(el("span", { text: summary }));
    content = el("div", { class: "card", text: `${summary}: ${unit.path}` });
  }
  return el(
    "div",
    { class: "unit", "data-unit": unit.id },
    head,
    ...visibleCards(
      cardsAt(
        cards,
        commit.index,
        unit.id,
        commit.refs.map((r) => r.unit),
      ),
    ).map(answerView),
    staticNarration(ref?.narration?.trim()),
    content,
    unitComments(unit, commit, looseComments),
  );
}

/** A dot in the commit list while the commit holds concerns nobody has decided. */
function concernDot(commit) {
  const open = undecided(commit.concerns ?? [], state.decisions);
  const level = topSeverity(open, state.decisions);
  if (level === null) return null;
  return el("span", {
    class: `dot sev-${level}`,
    role: "img",
    "aria-label": `${open.length} undecided ${level} concern${open.length === 1 ? "" : "s"}`,
    title: `${open.length} agent concern${open.length === 1 ? "" : "s"} to decide`,
  });
}

function renderList() {
  const list = $("commits");
  const hadFocus = list.contains(document.activeElement);
  list.replaceChildren(
    ...state.commits.map((commit, i) => {
      const { questions, changes } = kindCounts(state.comments, commit.index);
      const playing = player.view === "play" && i === selected;
      return el(
        "li",
        { class: i === selected ? "selected" : undefined },
        el(
          "button",
          {
            type: "button",
            class: "commit-row",
            "aria-current": i === selected ? "step" : undefined,
            onclick: () => {
              setListOpen(false);
              select(i, { focus: true });
            },
          },
          el("span", { class: "index", text: String(i + 1) }),
          el("span", { class: "title", text: firstLine(commit.message) }),
          concernDot(commit),
          playing
            ? el("span", { class: "mark", title: "Playing", text: "▶" })
            : watched.has(i)
              ? el("span", { class: "mark", title: "Watched", text: "✓" })
              : null,
          questions > 0
            ? el("span", {
                class: "badge question",
                title: `${questions} question${questions === 1 ? "" : "s"}`,
                text: `${questions} ?`,
              })
            : null,
          changes > 0
            ? el("span", {
                class: "badge",
                title: `${changes} comment${changes === 1 ? "" : "s"}`,
                text: String(changes),
              })
            : null,
        ),
      );
    }),
  );
  list.children[selected]?.scrollIntoView({ block: "nearest" });
  if (hadFocus) list.children[selected]?.querySelector("button")?.focus({ preventScroll: true });
  markClamped();
}

/** Only a clamped title needs its full text on hover and focus. */
function markClamped() {
  for (const row of $("commits").querySelectorAll(".commit-row")) {
    const title = row.querySelector(".title");
    if (title.scrollHeight > title.clientHeight) row.title = title.textContent;
    else row.removeAttribute("title");
  }
}

const rail = window.matchMedia("(max-width: 1279px)");
/** Below 900px the panel is a drawer from the right. */
const narrow = window.matchMedia("(max-width: 899px)");

/** In the rail, hovering or focusing a row shows its title beside it. */
function showRailTip(event) {
  const row = event.target.closest?.(".commit-row");
  const tip = $("rail-tip");
  if (!rail.matches || $("sidebar").classList.contains("open") || !row) return;
  const box = row.getBoundingClientRect();
  tip.textContent = row.querySelector(".title").textContent;
  tip.style.left = `${box.right + 6}px`;
  tip.style.top = `${box.top + 4}px`;
  tip.hidden = false;
  row.setAttribute("aria-describedby", "rail-tip");
}

function hideRailTip(event) {
  $("rail-tip").hidden = true;
  event.target.closest?.(".commit-row")?.removeAttribute("aria-describedby");
}

function setListOpen(open) {
  $("sidebar").classList.toggle("open", open);
  $("commits-toggle").setAttribute("aria-expanded", String(open));
  $("rail-tip").hidden = true;
}

function renderMain() {
  const main = $("main");
  const scroll = main.scrollTop;
  const commit = state.commits[selected];
  if (!commit) {
    main.replaceChildren(el("p", { class: "muted", text: "This plan has no commits." }));
    return;
  }
  const messageAnchor = { kind: "message", commit: commit.index };
  const positionAnchor = { kind: "position", commit: commit.index };
  const context = { commitMessage: commit.message, path: null };

  const groups = new Map();
  for (const ref of commit.refs) {
    const unit = unitsById.get(ref.unit);
    if (!unit) continue;
    groups.set(unit.path, [...(groups.get(unit.path) ?? []), unit]);
  }

  main.replaceChildren(
    stage,
    el(
      "div",
      { class: "commit-head" },
      el("div", { class: "message", text: commit.message }),
      staticNarration(commit.narration?.trim()),
      ...commentsAt(messageAnchor).map(commentChip),
      ...visibleCards(
        cardsAt(
          cards,
          commit.index,
          null,
          commit.refs.map((r) => r.unit),
        ),
      ).map(answerView),
      ...commitConcerns(commit).map((c) => concernView(c)),
      // A walk plan's messages and order are the planner's, not the author's, so only code is
      // up for comment there.
      isWalk()
        ? null
        : el(
            "div",
            { class: "controls" },
            commentBox({
              key: `box:message:${commit.index}`,
              label: "Comment on the message",
              placeholder: "What should this message say?",
              anchor: messageAnchor,
              context,
            }),
            commentBox({
              key: `box:position:${commit.index}`,
              label: "This belongs elsewhere",
              placeholder: "Where should this go, and why?",
              anchor: positionAnchor,
              context,
            }),
          ),
      ...commentsAt(positionAnchor).map(commentChip),
    ),
    ...[...groups].map(([path, units]) =>
      el(
        "section",
        { class: "file-group" },
        el("h3", { text: path }),
        ...units.map((unit) => unitView(unit, commit)),
      ),
    ),
  );
  main.scrollTop = scroll;
  applyPlayback();
  rovingLines();
}

/** The textarea being typed in, so a re-render caused by someone else's event keeps the caret. */
function typingPlace() {
  const area = document.activeElement;
  if (!(area instanceof HTMLTextAreaElement)) return null;
  const key = area.closest("[data-box]")?.getAttribute("data-box");
  return key ? { key, start: area.selectionStart, end: area.selectionEnd } : null;
}

function render() {
  const typing = typingPlace();
  cards = answerCards(state.previous, state.resolved, state.commits);
  refreshEntries();
  renderList();
  renderAnswers();
  renderMain();
  renderTimeline();
  renderComposer();
  if (focusKey !== null) {
    document.querySelector(`[data-box="${focusKey}"] textarea`)?.focus();
    focusKey = null;
  } else if (focusRow !== null) {
    const row = document.querySelector(`[data-line="${focusRow}"]`);
    if (row) {
      for (const other of row.closest(".diff").querySelectorAll(".dl")) other.tabIndex = -1;
      row.tabIndex = 0;
      row.focus();
    }
    focusRow = null;
  } else if (typing !== null) {
    const area = document.querySelector(`[data-box="${typing.key}"] textarea`);
    if (area instanceof HTMLTextAreaElement) {
      area.focus();
      area.setSelectionRange(typing.start, typing.end);
    }
  }
}

/** Moves to a commit. A move the reviewer asked for takes focus to the commit heading. */
function select(index, { focus = false } = {}) {
  const next = Math.max(0, Math.min(state.commits.length - 1, index));
  if (player.view === "play") seek(beatStart(steps, introOf(beats, next)));
  else {
    selected = next;
    render();
    $("main").scrollTop = 0;
  }
  if (focus) focusHeading();
}

function focusHeading() {
  stage.querySelector("h2")?.focus({ preventScroll: true });
}

function isWalk() {
  return state?.mode === "walk";
}

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
/**
 * view "play" shows the plan beat by beat; "browse" shows every line. position indexes the step
 * on screen, steps.length being the end. generation retires a running loop on every move.
 */
const player = {
  view: "browse",
  playing: false,
  position: 0,
  generation: 0,
  speed: 1,
  muted: false,
  voice: null,
};
let beats = [];
/** Commits whose outro playback reached. */
const watched = new Set();
/** When p last restarted a commit, so a second press soon after goes one further back. */
let restartedAt = 0;
/** Shown in the narration card until the next move, such as after a comment is saved. */
let notice = null;
/** Whether playback has run at all, so the ready card shows only before the first Play. */
let started = false;
let steps = [];
let narrated = true;
let voices = [];
/** The one narration card. It moves to whatever the reviewer is looking at. */
const card = el("blockquote", { class: "narration", "aria-live": "polite" });
/** Sticky header of the code pane: where the reviewer is. */
const stage = el("div", { class: "stage" });

function stored(key) {
  try {
    return localStorage.getItem(`follow-me.${key}`);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(`follow-me.${key}`, value);
  } catch {
    // Private windows may refuse storage; the setting then lasts for this page only.
  }
}

function silent() {
  return player.muted || synth === null || !narrated;
}

/** Resolves true after `ms` of playing time, or false once a move retires this loop. */
function sleep(ms, generation) {
  return new Promise((resolve) => {
    let left = ms;
    let last = performance.now();
    const tick = () => {
      if (generation !== player.generation) return resolve(false);
      const now = performance.now();
      if (player.playing) left -= now - last;
      last = now;
      if (left <= 0 && player.playing) return resolve(true);
      setTimeout(tick, Math.max(16, Math.min(left, 100)));
    };
    tick();
  });
}

/**
 * Speaks one utterance, cancelling whatever was speaking, so voice and picture never drift.
 * Resolves when it ends, or after a bound for engines that never report the end.
 */
function speak(text, generation) {
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = speechRate(player.speed);
  const voice = voices.find((v) => v.name === player.voice);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  const ended = new Promise((resolve) => {
    utterance.addEventListener("end", () => resolve(true));
    utterance.addEventListener("error", () => resolve(true));
  });
  synth.speak(utterance);
  return Promise.race([ended, sleep(speechTimeout(text, player.speed), generation)]);
}

function scrollMain(top) {
  $("main").scrollTo({
    top: Math.max(0, top),
    behavior: reducedMotion.matches ? "auto" : "smooth",
  });
}

/** Brings a node to 30% from the top of the code pane. */
function scrollToChunk(node) {
  const main = $("main");
  const offset = node.getBoundingClientRect().top - main.getBoundingClientRect().top;
  scrollMain(main.scrollTop + offset - main.clientHeight * 0.3);
}

/** What watching costs, shown before the first Play. */
function readyText() {
  const paths = new Set(state.units.map((u) => u.path));
  const minutes = Math.max(1, Math.round(duration(steps) / 60_000));
  const what = `${state.commits.length} commits · ${paths.size} files · about ${minutes} min at ${player.speed}x`;
  return `${what}. Press Play or Space to watch the branch being written.`;
}

function setCard(text, kind) {
  card.textContent = text;
  card.className = `narration ${kind}`;
}

/** Where the card and the reader's eye go for a beat: its first line, else its unit. */
function anchorOf(beat) {
  const main = $("main");
  if (beat.kind !== "chunk") return main.querySelector(".commit-head");
  const first = beat.lines[0];
  const line =
    first === undefined
      ? null
      : (main.querySelector(`[data-ph="${lineKey(beat.unit, first)}"]`) ??
        main.querySelector(`[data-line="${lineKey(beat.unit, first)}"]`));
  return line ?? main.querySelector(`[data-unit="${beat.unit}"] .card`);
}

function chunkText(beat) {
  return beat.narration ?? beat.label;
}

/** Renders the position: which lines exist yet, the placeholders, the card and the countdown. */
function renderStage() {
  const commit = state.commits[selected];
  if (!commit) return;
  const beat = beatAt(steps, player.position);
  const here = player.view === "play" ? beats[beat] : undefined;
  const chunk = here === undefined ? null : chunkOf(beats, beat);
  const path = here?.kind === "chunk" ? unitsById.get(here.unit)?.path : undefined;
  const parts = [
    firstLine(commit.message),
    chunk === null ? null : `chunk ${chunk.index} of ${chunk.count}`,
    path ?? null,
  ].filter((p) => p !== null);
  stage.replaceChildren(
    el(
      "h2",
      { tabindex: "-1" },
      el("span", { text: `Commit ${selected + 1} of ${state.commits.length}` }),
      ...parts.map((p) => el("span", { class: "part", text: ` · ${p}` })),
      toDecide(openConcerns().length) === null
        ? null
        : el("span", { class: "part to-decide", text: ` · ${toDecide(openConcerns().length)}` }),
    ),
  );
  const strip = $("strip");
  strip.replaceChildren(
    ...progress(beats, player.view === "play" ? beat : 0).map((seg) =>
      el(
        "button",
        {
          type: "button",
          class: seg.commit === selected ? "seg here" : "seg",
          style: `flex-grow: ${seg.weight}`,
          title: `Commit ${seg.commit + 1}: ${firstLine(state.commits[seg.commit]?.message ?? "")}`,
          "aria-label": `Go to commit ${seg.commit + 1}`,
          onclick: () => seek(beatStart(steps, introOf(beats, seg.commit))),
        },
        el("span", { class: "fill", style: `width: ${Math.round(seg.filled * 100)}%` }),
      ),
    ),
  );
}

/** Mermaid, imported on first use, so a plan without diagrams never downloads it. */
let mermaid = null;
let drawn = null;
let drawing = 0;

async function loadMermaid() {
  if (mermaid === null) {
    const { default: loaded } = await import("/vendor/mermaid.mjs");
    loaded.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    });
    mermaid = loaded;
  }
  return mermaid;
}

/** The server's event log as far as the page holds it; the timeline is built from it and state. */
let events = [];
let entries = [];
/** The last entry the reader has seen. The agent's words after it count as unread. */
let readUpTo = null;
let panelSeen = false;
/** Whether the "threads here" button is filtering the timeline to the chunk on screen. */
let onlyHere = false;
/** Entries that arrived while the reader had scrolled up, for the "new" pill. */
let arrivedBelow = 0;
/** What is on the chunk on screen: its entry ids and how many threads they make up. */
let here = { ids: new Set(), threads: 0 };
/** Questions asked while playing, so the agent's answer to one can raise a toast. */
const askedWhilePlaying = new Set();
/** Entries whose quote the reader opened in full. */
const openQuotes = new Set();
/** Entries whose long text the reader opened in full. */
const openFolds = new Set();

async function loadLog() {
  const res = await fetch(`${sessionPrefix}/api/events?since=0&timeout=0`).catch(() => null);
  // A server without a log leaves the timeline to the saved state alone.
  events = res?.ok ? ((await res.json()).events ?? []) : [];
}

function logEvent(event) {
  if (event.seq === undefined || events.some((e) => e.seq === event.seq)) return;
  events = [...events, event];
}

/** Draws a diagram for what is on screen into the Now card, or hides the card's body. */
async function drawNow(shown) {
  const body = $("now-body");
  body.hidden = shown === null;
  if (shown === null) {
    drawn = null;
    return;
  }
  if (shown.source === drawn) return;
  drawn = shown.source;
  drawing += 1;
  const id = `diagram-${drawing}`;
  try {
    const { svg } = await (await loadMermaid()).render(id, shown.source);
    if (drawn !== shown.source) return;
    // Mermaid sanitizes its own output under securityLevel "strict".
    body.innerHTML = svg;
  } catch (error) {
    if (drawn !== shown.source) return;
    body.replaceChildren(
      ...diagramFailure(
        `Mermaid could not draw this diagram:\n${error?.message ?? String(error)}`,
        shown.source,
      ),
    );
  }
}

/** The chunk the reader is on: the beat while playing, else the commit being read. */
function hereNow() {
  const beat = player.view === "play" ? beats[beatAt(steps, player.position)] : undefined;
  if (beat?.kind === "chunk") return { commit: beat.commit, unit: beat.unit, rows: beat.lines };
  return { commit: selected };
}

/** The Now card: what the planned diagram shows and how many threads sit on this chunk. */
function renderNow() {
  const commit = state.commits[selected];
  if (!commit) return;
  const beat = player.view === "play" ? beats[beatAt(steps, player.position)] : undefined;
  const shown = diagramAt(commit, beat);
  const unit = shown?.unit == null ? null : unitsById.get(shown.unit);
  const where = `${unit ? `${unit.path}, ` : ""}commit ${selected + 1}`;
  $("now-label").textContent = shown === null ? `Commit ${selected + 1}` : `Diagram · ${where}`;
  drawNow(shown);
  here = entriesHere(state, entries, hereNow());
  const button = $("threads-here");
  button.hidden = here.threads === 0 && !onlyHere;
  button.textContent = onlyHere
    ? "Show all"
    : `${here.threads} thread${here.threads === 1 ? "" : "s"} here`;
  button.setAttribute("aria-pressed", String(onlyHere));
  if (onlyHere) renderTimeline();
  else markHere();
}

/** Entries on the chunk on screen get an accent edge. */
function markHere() {
  for (const node of $("timeline").querySelectorAll("[data-entry]")) {
    node.classList.toggle("here", here.ids.has(node.dataset.entry));
  }
}

function entryWho(from) {
  return from === "agent" ? "Agent" : "You";
}

/** Where a comment points, as the panel says it. */
function entryAnchorText(comment) {
  const { anchor } = comment;
  const earlier =
    state.previous?.comments.some((c) => c.id === comment.id) === true &&
    !state.comments.some((c) => c.id === comment.id);
  let rows = "";
  if (anchor.kind === "hunk") {
    const unit = unitsById.get(anchor.unit);
    const picked = unit?.kind === "hunk" ? rowsOfAnchor(anchor, unit.body) : [];
    rows =
      picked.length === 0
        ? "whole hunk"
        : describeRows(unit.body, numbers.get(unit.id) ?? [], picked);
  }
  return anchorText(comment, {
    rows,
    whole: isWalk() ? "Whole branch" : "Whole plan",
    version: earlier ? state.previous.version : null,
  });
}

/** The button that says where an entry points and takes the reader there. */
function anchorChip(entry, text) {
  const place = locate(state, entry);
  if (place.stale) {
    return el("span", { class: "anchor-chip stale", text: `${text} · the code has changed since` });
  }
  if (place.at === null) return el("span", { class: "anchor-chip", text });
  return el("button", {
    type: "button",
    class: "anchor-chip",
    title: "Show these lines",
    text,
    onclick: () => jump(entry),
  });
}

/** The quoted rows of a comment, three of them until the reader asks for the rest. */
function quoteView(entry, comment) {
  const lines = comment.context.lines ?? [];
  if (lines.length === 0) return null;
  const open = openQuotes.has(entry.id);
  const { shown, more } = quoteOf(lines, open ? lines.length : 3);
  return el(
    "div",
    { class: "quote-box" },
    el("pre", { class: "quote", text: shown.join("\n") }),
    more > 0
      ? el("button", {
          type: "button",
          class: "link",
          text: `Show ${more} more row${more === 1 ? "" : "s"}`,
          onclick: () => {
            openQuotes.add(entry.id);
            renderTimeline();
          },
        })
      : null,
  );
}

/** Reply, and for the reviewer's own comment edit and delete. Only this plan's comments take them. */
function threadActions(comment, mine) {
  if (!state.comments.some((c) => c.id === comment.id)) return null;
  const replyKey = `reply:${comment.id}`;
  const talk = comment.kind === "question" || comment.author === "agent" || comment.replies?.length;
  return el(
    "div",
    { class: "meta actions" },
    talk
      ? el("button", {
          type: "button",
          class: "link",
          text: "reply",
          onclick: () => {
            openBoxes.add(replyKey);
            focusKey = replyKey;
            render();
          },
        })
      : null,
    mine
      ? el("button", {
          type: "button",
          class: "link",
          text: "edit",
          onclick: () => {
            editing.add(comment.id);
            focusKey = `edit:${comment.id}`;
            render();
          },
        })
      : null,
    mine
      ? el("button", {
          type: "button",
          class: "link",
          text: "delete",
          onclick: () =>
            guarded(async () => {
              await api("DELETE", `/api/comments/${comment.id}`);
              await reloadComments();
            }),
        })
      : null,
  );
}

function replyBox(comment) {
  const key = `reply:${comment.id}`;
  return el(
    "li",
    { class: "entry compose" },
    commentForm({
      key,
      placeholder: "Reply",
      action: "Reply",
      submit: (body) =>
        api("POST", `/api/comments/${comment.id}/replies`, { author: "reviewer", body }),
      close: () => openBoxes.delete(key),
    }),
  );
}

function entryView(entry) {
  const attrs = {
    "data-entry": entry.id,
    "data-thread": entry.thread ?? undefined,
    onclick: (event) => {
      if (!event.target.closest("button, a, textarea, select, input, .box")) jump(entry);
    },
  };
  switch (entry.kind) {
    case "comment": {
      const { comment } = entry;
      const question = comment.kind === "question";
      return el(
        "li",
        { class: `entry from-${entry.from}${question ? " question" : ""}`, ...attrs },
        el(
          "div",
          { class: "meta" },
          el("strong", { text: entryWho(entry.from) }),
          el("span", { class: "chip", text: commentLabel(comment) }),
          comment.follows ? el("span", { text: "asked again" }) : null,
          comment.severity ? el("span", { class: "chip", text: comment.severity }) : null,
        ),
        anchorChip(entry, entryAnchorText(comment)),
        quoteView(entry, comment),
        editing.has(comment.id)
          ? commentForm({
              key: `edit:${comment.id}`,
              placeholder: "Edit your comment",
              action: "Save",
              initial: comment.body,
              submit: (body) => api("PUT", `/api/comments/${comment.id}`, { ...comment, body }),
              close: () => editing.delete(comment.id),
            })
          : entry.from === "agent"
            ? agentText(entry.id, comment.body)
            : el("div", { class: "said", text: comment.body }),
        comment.diagram ? diagramSlot(comment.diagram) : null,
        threadActions(comment, entry.from === "you"),
      );
    }
    case "reply":
      return el(
        "li",
        { class: `entry from-${entry.from}`, ...attrs },
        el("div", { class: "meta" }, el("strong", { text: entryWho(entry.from) })),
        anchorChip(entry, `re: ${snippet(entry.comment.body)} · ${entryAnchorText(entry.comment)}`),
        agentText(entry.id, entry.reply.body),
        entry.reply.diagram ? diagramSlot(entry.reply.diagram) : null,
        threadActions(entry.comment, false),
      );
    case "answer":
      return el(
        "li",
        { class: "entry from-agent answer", ...attrs },
        el(
          "div",
          { class: "meta" },
          el("strong", { text: "Agent" }),
          el("span", {
            class: "chip",
            text: statusLine({ resolved: false, status: entry.response.status }),
          }),
        ),
        anchorChip(entry, `re: ${snippet(entry.comment.body)} · ${entryAnchorText(entry.comment)}`),
        agentText(entry.id, entry.response.note),
      );
    case "concern": {
      const paths = Object.fromEntries(state.units.map((u) => [u.id, u.path]));
      return el(
        "li",
        { class: "entry system", ...attrs },
        el("span", { text: concernLine(entry, paths) }),
        entry.note ? el("span", { class: "said", text: `“${entry.note}”` }) : null,
      );
    }
    case "resolved":
      return el("li", {
        class: "entry system",
        ...attrs,
        text: `You ${entry.resolved ? "marked" : "reopened"} “${snippet(entry.comment.body, 40)}”${entry.resolved ? " resolved" : ""}`,
      });
    case "version":
      return el("li", { class: "divider", "data-entry": entry.id, text: dividerText(entry) });
    default:
      return el("li", { class: "divider", "data-entry": entry.id, text: "Review ended" });
  }
}

function renderTimeline() {
  const list = $("timeline");
  const stuck = atBottom(list);
  const top = list.scrollTop;
  const shown = onlyHere ? entries.filter((e) => here.ids.has(e.id)) : entries;
  const tails = new Map(shown.flatMap((e) => (e.thread === null ? [] : [[e.thread, e.id]])));
  list.replaceChildren(
    ...(shown.length === 0
      ? [
          el("li", {
            class: "empty-note",
            text: onlyHere
              ? "Nothing here yet."
              : "Questions, replies and decisions show up here, oldest first.",
          }),
        ]
      : shown.flatMap((entry) => {
          const tail = tails.get(entry.thread) === entry.id;
          const open = tail && openBoxes.has(`reply:${entry.thread}`);
          return open ? [entryView(entry), replyBox(entry.comment)] : [entryView(entry)];
        })),
  );
  list.scrollTop = stuck ? list.scrollHeight : top;
  following = stuck;
  measureFolds();
  markHere();
  renderUnread();
}

/** The agent's words the reader has not seen: counted on the tab, and a pill when scrolled up. */
function renderUnread() {
  const list = $("timeline");
  if (panelOpen && atBottom(list) && !player.playing) {
    readUpTo = entries.at(-1)?.id ?? null;
    arrivedBelow = 0;
  }
  const unread = unreadAfter(entries, readUpTo);
  const badge = $("unread");
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
  badge.setAttribute("aria-label", `${unread} unread from the agent`);
  const pill = $("new-pill");
  pill.hidden = arrivedBelow === 0;
  pill.textContent = `${arrivedBelow} new ↓`;
}

/** Rebuilds the entries from state and the log; what arrived while scrolled up is counted. */
function refreshEntries() {
  const seen = new Set(entries.map((e) => e.id));
  const stuck = atBottom($("timeline"));
  entries = timelineOf(state, events);
  if (!panelSeen) {
    panelSeen = true;
    readUpTo = entries.at(-1)?.id ?? null;
    return;
  }
  if (!stuck) arrivedBelow += entries.filter((e) => !seen.has(e.id)).length;
}

let panelOpen = true;
/** Whether the timeline sits at its end and should stay there as its box or its entries change. */
let following = true;

function setPanelOpen(open) {
  panelOpen = open;
  $("app").classList.toggle("panel-closed", !open);
  $("panel-tab").setAttribute("aria-expanded", String(open));
  if (open) renderUnread();
}

function togglePanel() {
  setPanelOpen(!panelOpen);
  // The drawer opens for a moment; only the wide layout remembers the choice.
  if (!narrow.matches) store("panel", String(panelOpen));
}

/** The composer: with rows picked it writes to them, else to the whole plan, as a question. */
function renderComposer() {
  const pick = selection;
  const unit = pick === null ? undefined : unitsById.get(pick.unit);
  const commit = pick === null ? undefined : state.commits[pick.commit];
  const picked = unit?.kind === "hunk" && commit !== undefined;
  const rows = picked ? describeRows(unit.body, numbers.get(unit.id) ?? [], pick.lines) : "";
  const whole = isWalk() ? "Whole branch" : "Whole plan";
  const lines = picked ? snapshotRows(unit.body, pick.lines) : [];
  const { shown, more } = quoteOf(lines);
  const parts = [
    el(
      "div",
      { class: "composer-anchor" },
      el("span", {
        class: "anchor-chip",
        text: picked ? `${unit.path} · ${rows} · commit ${pick.commit + 1}` : whole,
      }),
      picked
        ? el("button", {
            type: "button",
            class: "link",
            text: "×",
            title: "Clear the picked rows (Esc)",
            "aria-label": "Clear the picked rows",
            onclick: clearPick,
          })
        : null,
    ),
    picked
      ? el("pre", { class: "quote", text: shown.join("\n") + (more > 0 ? `\n… ${more} more` : "") })
      : null,
    commentForm({
      key: "composer",
      placeholder: picked
        ? `Comment on ${rows}`
        : isWalk()
          ? "Ask about the whole branch"
          : "Ask about the whole plan",
      action: "Send",
      kinds: true,
      startKind: picked ? undefined : "question",
      submit: (body, kind, severity) =>
        picked
          ? postPick(unit, commit, pick.lines, body, kind, severity)
          : api("POST", "/api/comments", {
              anchor: { kind: "plan" },
              context: { commitMessage: "", path: null },
              body,
              ...kindField(kind),
              ...rated(severity),
            }),
      close: () => {
        selection = null;
      },
    }),
  ];
  $("composer").replaceChildren(...parts.filter(Boolean));
}

function flash(nodes) {
  for (const node of nodes) node.classList.add("flash");
  setTimeout(() => {
    for (const node of nodes) node.classList.remove("flash");
  }, 1200);
}

/** Scrolls the code to the place an entry is about, flashes it and moves focus there. */
function revealAt(at) {
  const main = $("main");
  const rows = at.rows
    .map((r) => main.querySelector(`[data-line="${lineKey(at.unit, r)}"]:not(.pending)`))
    .filter(Boolean);
  const target =
    rows[0] ??
    (at.unit === null
      ? main.querySelector(".commit-head")
      : main.querySelector(`[data-unit="${at.unit}"]`));
  if (!target) return;
  scrollToChunk(target);
  flash(rows.length > 0 ? rows : [target]);
  if (rows[0]) {
    for (const other of rows[0].closest(".diff").querySelectorAll(".dl")) other.tabIndex = -1;
    rows[0].tabIndex = 0;
    rows[0].focus({ preventScroll: true });
  }
}

/**
 * Takes the reader to the lines an entry is about. While playing it pauses and moves to the beat
 * that reveals them, so they are not hidden. An anchor whose code is gone shows nothing to scroll to.
 */
function jump(entry) {
  const place = locate(state, entry);
  if (place.stale || place.at === null) return;
  const { at } = place;
  if (player.view === "play") {
    if (player.playing) pause();
    const beat = beatFor(beats, at);
    if (beat !== null) seek(steps.findIndex((s) => s.kind === "show" && s.beat === beat));
    else if (at.commit !== selected) seek(beatStart(steps, introOf(beats, at.commit)));
  } else if (at.commit !== selected) {
    selected = at.commit;
    render();
  }
  revealAt(at);
}

/** Brings one entry into view in the timeline, for a toast's Show. */
function revealEntry(id) {
  if (!panelOpen) togglePanel();
  const node = $("timeline").querySelector(`[data-entry="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: "center" });
  flash([node]);
}

let toastTimer = null;
let toastTarget = null;

function showToast(text, target) {
  $("toast-text").textContent = text;
  toastTarget = target;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 8000);
}

/** What an event means for the reader beyond the page state: a toast for an answer they waited on. */
function noticeEvent(event) {
  const body = eventBody(event);
  if (event.type === "comment" && player.view === "play") {
    const comment = body.comment ?? body;
    if (comment.author !== "agent" && typeof comment.id === "string") {
      askedWhilePlaying.add(comment.id);
    }
  } else if (event.type === "reply" && player.view === "play") {
    const { reply } = body;
    if (reply?.author === "agent" && askedWhilePlaying.has(body.commentId)) {
      showToast("Agent replied", `r:${reply.id}`);
    }
  }
}

function setUpPanel() {
  $("panel-tab").addEventListener("click", togglePanel);
  $("now-expand").addEventListener("click", () =>
    expandDiagram($("now-body"), $("now-label").textContent),
  );
  $("dialog-fit").addEventListener("click", () => {
    const fit = $("dialog-body").classList.toggle("fit");
    $("dialog-fit").textContent = fit ? "Actual size" : "Fit to width";
  });
  $("now-toggle").addEventListener("click", () => {
    const open = $("now-toggle").getAttribute("aria-expanded") !== "true";
    $("now-toggle").setAttribute("aria-expanded", String(open));
    $("now").classList.toggle("collapsed", !open);
    store("now", String(open));
  });
  const open = stored("now") !== "false";
  $("now-toggle").setAttribute("aria-expanded", String(open));
  $("now").classList.toggle("collapsed", !open);
  $("threads-here").addEventListener("click", () => {
    onlyHere = !onlyHere;
    renderNow();
    renderTimeline();
  });
  $("timeline").addEventListener("scroll", () => {
    following = atBottom($("timeline"));
    renderUnread();
  });
  // A diagram drawing above changes the timeline's height; a reader at the end stays at the end.
  new ResizeObserver(() => {
    if (following) $("timeline").scrollTop = $("timeline").scrollHeight;
  }).observe($("timeline"));
  $("new-pill").addEventListener("click", () => {
    $("timeline").scrollTop = $("timeline").scrollHeight;
    renderUnread();
  });
  $("toast-show").addEventListener("click", () => {
    $("toast").hidden = true;
    if (toastTarget !== null) revealEntry(toastTarget);
  });
  setPanelOpen(stored("panel") !== "false" && !narrow.matches);
  narrow.addEventListener("change", () =>
    setPanelOpen(!narrow.matches && stored("panel") !== "false"),
  );
}

function applyPlayback() {
  const main = $("main");
  renderNow();
  for (const node of main.querySelectorAll(".ph, .countdown")) node.remove();
  card.remove();
  renderStage();
  if (player.view !== "play") {
    for (const node of main.querySelectorAll("[data-line], .unit")) {
      node.classList.remove("pending", "struck", "in-chunk");
    }
    for (const node of main.querySelectorAll(".concern, .thread-chip"))
      node.classList.remove("pending");
    return;
  }
  const { states, upcoming, current } = lineStates(beats, steps, player.position, selected);
  const chunk = current === null ? null : beats[current];
  const inChunk = new Set(chunk?.lines.map((line) => lineKey(chunk.unit, line)) ?? []);
  for (const node of main.querySelectorAll("[data-line]")) {
    const key = node.dataset.line;
    const look = states.get(key);
    node.classList.toggle("pending", look === "hidden");
    node.classList.toggle("struck", look === "struck");
    node.classList.toggle("in-chunk", inChunk.has(key) && look !== "hidden");
  }
  for (const node of main.querySelectorAll(".concern[data-after], .thread-chip[data-after]")) {
    node.classList.toggle("pending", states.get(node.dataset.after) === "hidden");
  }
  for (const node of main.querySelectorAll(".unit")) {
    node.classList.toggle(
      "in-chunk",
      chunk?.unit === node.dataset.unit && chunk.lines.length === 0,
    );
  }
  for (const [key, n] of upcoming) {
    const line = main.querySelector(`[data-line="${key}"]`);
    const ph = el("div", {
      class: inChunk.has(key) ? "ph in-chunk" : "ph",
      "data-ph": key,
      text: `${n} line${n === 1 ? "" : "s"} coming${inChunk.has(key) ? "" : " next"}`,
    });
    line?.before(ph);
  }

  const step = steps[player.position];
  const beat = beats[beatAt(steps, player.position)];
  if (notice !== null) {
    setCard(notice, "notice");
    (beat?.kind === "chunk" ? anchorOf(beat) : null)?.before(card);
    if (!card.isConnected) main.querySelector(".commit-head .message")?.after(card);
    return;
  }
  if (step === undefined || beat === undefined) {
    setCard(
      isWalk()
        ? "That is the whole branch. Leave any last comments, then finish the code review."
        : "That is the whole plan.",
      "end",
    );
    main.querySelector(".commit-head")?.append(card);
    return;
  }
  if (beat.kind === "intro" && player.position === 0 && !player.playing && !started) {
    setCard(readyText(), "label");
    main.querySelector(".commit-head .message")?.after(card);
    return;
  }
  if (beat.kind === "intro") {
    const note = narrated ? null : "This plan has no narration. Showing commit messages.";
    if (beat.narration !== null || (note !== null && beat.commit === 0)) {
      setCard(beat.narration ?? note, "say");
      main.querySelector(".commit-head .message")?.after(card);
    }
  } else if (beat.kind === "chunk") {
    setCard(chunkText(beat), beat.narration === null ? "label" : "say");
    anchorOf(beat)?.before(card);
  } else {
    const countdown = el(
      "div",
      { class: "countdown" },
      el("span", { text: beat.next === null ? "Last commit" : `Next: ${beat.next}` }),
      el("span", { class: "bar", style: `animation-duration: ${step.ms}ms` }),
    );
    countdown.classList.toggle("paused", !player.playing);
    stage.append(countdown);
    watched.add(beat.commit);
  }
}

/** Shows the step at the current position: its commit, its lines, and where the eye goes. */
function present() {
  const commit = commitOf(beats, beatAt(steps, player.position));
  const beat = beats[beatAt(steps, player.position)];
  if (commit !== selected) {
    selected = commit;
    render();
    $("main").scrollTop = 0;
  } else {
    applyPlayback();
    renderList();
  }
  if (beat?.kind === "chunk") {
    const anchor = card.isConnected ? card : anchorOf(beat);
    if (anchor) scrollToChunk(anchor);
  } else if (beat?.kind === "intro") scrollMain(0);
  updatePlayer();
}

/** Waits out one step. A say step lasts its reading time or until speech ends, whichever is later. */
async function perform(step, generation) {
  if (step.kind === "show") {
    const extra = dwellExtra(chunkConcerns(step.beat), state.decisions, player.speed);
    return sleep(step.ms + extra, generation);
  }
  if (step.kind !== "say" || silent()) return sleep(step.ms, generation);
  const [read, heard] = await Promise.all([
    sleep(step.ms, generation),
    speak(step.text, generation).then((ok) => ok && sleep(step.tail, generation)),
  ]);
  return read && heard && generation === player.generation;
}

/** The concerns that belong to a chunk beat. */
function chunkConcerns(beat) {
  const unit = unitsById.get(beats[beat]?.unit);
  const commit = state.commits[beats[beat]?.commit];
  if (unit?.kind !== "hunk" || !commit) return [];
  return concernsInChunk(commit.concerns ?? [], beats, beat, unit.body);
}

/** A blocker stops playback as soon as the lines it is about are on screen. */
function holdForConcern() {
  const step = steps[player.position];
  if (step === undefined) return;
  const held = blockersToHold(chunkConcerns(step.beat), step, state.decisions, seenBlockers);
  if (held.length === 0) return;
  for (const concern of held) seenBlockers.add(concern.id);
  notice = "The agent flagged a blocker here. Keep or dismiss it, then Space to continue.";
  pause();
  render();
}

/** Stops on an answer to the reviewer's own question, once the narration has been heard. */
function holdForAnswer() {
  const held = holdAt(beats, steps, player.position, cards, seenAnswers);
  if (held.length === 0) return;
  for (const card of held) seenAnswers.add(card.id);
  notice =
    held.length === 1
      ? "Your question is answered here. Space to continue."
      : `${held.length} of your questions are answered here. Space to continue.`;
  pause();
  render();
}

async function playLoop(generation) {
  while (player.position < steps.length) {
    if (!(await sleep(0, generation))) return;
    if (!(await perform(steps[player.position], generation))) return;
    player.position += 1;
    present();
    holdForAnswer();
    holdForConcern();
  }
  player.playing = false;
  renderList();
  updatePlayer();
}

/** Moves to a step and starts a fresh loop, which waits while paused. */
function seek(position) {
  synth?.cancel();
  notice = null;
  player.position = Math.max(0, Math.min(steps.length, position));
  player.generation += 1;
  present();
  playLoop(player.generation);
}

function play() {
  if (player.view !== "play") enterPlay();
  if (player.position >= steps.length) seek(0);
  notice = null;
  started = true;
  player.playing = true;
  applyPlayback();
  synth?.resume();
  updatePlayer();
}

function pause() {
  player.playing = false;
  synth?.pause();
  updatePlayer();
}

function enterPlay() {
  player.view = "play";
  $("player").hidden = false;
  render();
  seek(beatStart(steps, introOf(beats, selected)));
}

function enterBrowse() {
  player.view = "browse";
  player.playing = false;
  player.generation += 1;
  synth?.cancel();
  $("player").hidden = true;
  render();
  updatePlayer();
}

function currentBeat() {
  return beatAt(steps, player.position);
}

/** Seeks to a beat; the beat starts over, so its narration replays. */
function toBeat(beat) {
  seek(beatStart(steps, Math.max(0, Math.min(beats.length, beat))));
}

function stepBeat(delta) {
  if (player.view !== "play") enterPlay();
  toBeat(currentBeat() + delta);
}

function nextCommit() {
  if (player.view !== "play") return select(selected + 1, { focus: true });
  toBeat(introOf(beats, selected + 1));
  focusHeading();
}

/** Restarts the commit; a second press within 1.5s goes to the previous one. */
function previousCommit() {
  if (player.view !== "play") return select(selected - 1, { focus: true });
  focusHeading();
  const now = performance.now();
  const intro = introOf(beats, selected);
  const again = now - restartedAt < 1500 || currentBeat() === intro;
  restartedAt = now;
  toBeat(again ? introOf(beats, selected - 1) : intro);
}

/** c and q: comment on the picked rows when there are any, else on the chunk on screen. */
function commentOnPick(kind) {
  if (selection === null) return commentOnChunk(kind);
  if (player.playing) pause();
  focusKey = `line:${selection.commit}:${selection.unit}`;
  kindDrafts.set(focusKey, { kind, touched: true, severity: "" });
  render();
}

/** Pauses and opens a comment of a kind on the chunk on screen, its lines preselected. */
function commentOnChunk(kind) {
  if (player.view !== "play") {
    report(new Error("Pick a line first, then press c or q."));
    return;
  }
  const at = currentBeat();
  const beat = beats[at];
  if (beat?.kind !== "chunk") {
    report(new Error("Step to a chunk to comment on it."));
    return;
  }
  pause();
  const show = steps.findIndex((s) => s.kind === "show" && s.beat === at);
  if (player.position < show) seek(show);
  if (beat.lines.length === 0) {
    const key = `box:${beat.commit}:${beat.unit}`;
    openBoxes.add(key);
    focusKey = key;
  } else {
    selection = { commit: beat.commit, unit: beat.unit, from: beat.lines[0], lines: beat.lines };
    focusKey = `line:${beat.commit}:${beat.unit}`;
  }
  kindDrafts.set(focusKey, { kind, touched: true, severity: "" });
  render();
}

function toggleKeys() {
  const sheet = $("keys");
  if (sheet.open) sheet.close();
  else sheet.showModal();
}

function setSpeed(speed) {
  player.speed = speed;
  steps = schedule(beats, speed);
  store("speed", String(speed));
}

function updatePlayer() {
  $("main").querySelector(".countdown")?.classList.toggle("paused", !player.playing);
  const play = $("play");
  play.querySelector(".icon").textContent = player.playing ? "❚❚" : "▶";
  play.querySelector(".label").textContent = player.playing ? "Pause" : "Play";
  play.setAttribute("aria-pressed", String(player.playing));
  $("view-toggle").textContent = player.view === "play" ? "Show all" : "Play";
  const mute = $("mute");
  mute.disabled = synth === null;
  mute.textContent = synth === null ? "No speech" : player.muted ? "Unmute" : "Mute";
  mute.setAttribute("aria-pressed", String(player.muted));
}

function toggleMute() {
  if (!narrated || synth === null) return;
  player.muted = !player.muted;
  store("muted", String(player.muted));
  if (player.muted) synth.cancel();
  updatePlayer();
}

function loadVoices() {
  if (synth === null) return;
  voices = synth.getVoices();
  if (!voices.some((v) => v.name === player.voice)) {
    player.voice = pickVoice(voices, stored("voice"), navigator.language);
  }
  const picker = $("voice");
  picker.replaceChildren(
    el("option", { value: "", text: "Browser default" }),
    ...voices.map((v) => el("option", { value: v.name, text: `${v.name} (${v.lang})` })),
  );
  picker.value = player.voice ?? "";
}

/** The beats and steps of the plan on screen; again whenever a new plan version replaces it. */
function buildPlayback() {
  beats = buildScript(state.commits, state.units);
  narrated = hasNarration(state.commits);
  steps = schedule(beats, player.speed);
  for (const id of ["voice-label", "mute"]) $(id).hidden = !narrated;
}

function setUpPlayer() {
  player.speed = parseSpeed(stored("speed"));
  buildPlayback();
  player.muted = stored("muted") === "true";
  const speed = $("speed");
  speed.replaceChildren(...SPEEDS.map((s) => el("option", { value: String(s), text: `${s}x` })));
  speed.value = String(player.speed);
  speed.addEventListener("change", () => setSpeed(parseSpeed(speed.value)));
  const picker = $("voice");
  picker.disabled = synth === null;
  picker.addEventListener("change", () => {
    player.voice = picker.value || null;
    store("voice", picker.value);
  });
  synth?.addEventListener("voiceschanged", loadVoices);
  loadVoices();
  $("play").addEventListener("click", () => (player.playing ? pause() : play()));
  $("prev-commit").addEventListener("click", previousCommit);
  $("next-commit").addEventListener("click", nextCommit);
  $("prev-beat").addEventListener("click", () => stepBeat(-1));
  $("next-beat").addEventListener("click", () => stepBeat(1));
  $("keys-button").addEventListener("click", toggleKeys);
  $("mute").addEventListener("click", toggleMute);
  setUpPanel();
  $("view-toggle").addEventListener("click", () => {
    if (player.view === "play") enterBrowse();
    else play();
    // Space should now drive playback, not this button.
    focusHeading();
  });
  updatePlayer();
}

function hasUnsentText() {
  return [...drafts.values()].some((text) => text.trim() !== "");
}

/** What the review holds, in words: comments, questions, kept concerns, unread answers. */
function commentSummary() {
  const kept = allConcerns(state.commits).filter(
    (c) => state.decisions[c.id]?.decision === "kept",
  ).length;
  const unresolved = cards.filter((c) => c.status === "answered" && !c.resolved).length;
  return endSummary({ comments: state.comments, kept, unresolved, walk: isWalk() });
}

/** The consolidated report as markdown, or null from a server that has none. */
async function fetchReport() {
  const res = await fetch(`${sessionPrefix}/api/report`).catch(() => null);
  return res?.ok ? res.text() : null;
}

function copyButton(label, text) {
  const button = el("button", {
    type: "button",
    text: label,
    onclick: async () => {
      await navigator.clipboard?.writeText(text).catch(() => {});
      button.textContent = "Copied";
    },
  });
  return button;
}

/**
 * Asks before ending, with what the review holds. Resolves "end", or with agent concerns still
 * undecided "keep-all", "dismiss-all" or "back".
 */
function confirmEnd() {
  const sheet = $("confirm-end");
  const unsent = hasUnsentText() ? " Some comment boxes have text you have not sent." : "";
  const open = openConcerns().length;
  const text = `${commentSummary()}.${unsent}`;
  $("confirm-text").textContent = open === 0 ? text : `${undecidedPrompt(open)} ${text}`;
  $("confirm-ok").textContent = $("end").textContent;
  $("confirm-ok").hidden = open > 0;
  $("confirm-keep-all").hidden = open === 0;
  $("confirm-dismiss-all").hidden = open === 0;
  $("confirm-back").textContent = open === 0 ? "Keep reviewing" : "Go back";
  sheet.returnValue = "";
  sheet.showModal();
  return new Promise((resolve) => {
    sheet.addEventListener("close", () => resolve(sheet.returnValue || "back"), { once: true });
  });
}

async function endReview() {
  if (player.playing) pause();
  const answer = await confirmEnd();
  if (answer === "back" || answer === "keep") return;
  if (answer === "keep-all" || answer === "dismiss-all") {
    const decision = answer === "keep-all" ? "kept" : "dismissed";
    for (const concern of openConcerns()) {
      await api("POST", `/api/concerns/${concern.id}`, { decision });
      state.decisions = { ...state.decisions, [concern.id]: { concern: concern.id, decision } };
    }
  }
  // The session is gone once it ends, so the report is read first. Nothing changes in between.
  const markdown = await fetchReport();
  const summary = commentSummary();
  ending = true;
  const { saved } = await api("POST", "/api/end").catch((error) => {
    ending = false;
    throw error;
  });
  player.generation += 1;
  synth?.cancel();
  const at = saved.indexOf(".follow-me/");
  const shortPath = (path) => (at === -1 ? path : path.slice(at));
  const command = "follow-me feedback";
  $("done").replaceChildren(
    el(
      "section",
      {
        class: markdown === null ? "done-card" : "done-card wide",
        "aria-labelledby": "done-title",
      },
      el("h1", { id: "done-title", text: isWalk() ? "Code review saved" : "Review saved" }),
      el("p", { class: "muted", text: `${summary}.` }),
      el("p", {}, el("code", { class: "path", text: at === -1 ? saved : saved.slice(at) })),
      markdown === null
        ? null
        : el(
            "section",
            { class: "report-box", "aria-label": "Report" },
            el(
              "div",
              { class: "report-head" },
              el("strong", { text: "Report" }),
              el("code", { text: shortPath(reportPath(saved)) }),
              copyButton("Copy markdown", markdown),
            ),
            el("pre", { class: "report", tabindex: "0", text: markdown }),
          ),
      el(
        "p",
        { class: "next" },
        isWalk() ? "The author reads it with " : "Next, run ",
        el("code", { text: command }),
        copyButton("Copy", command),
      ),
      isWalk() ? null : el("p", { class: "muted", text: "or hand the session to your agent." }),
      el("p", {}, el("a", { href: "/", text: "All sessions" })),
    ),
  );
  $("done").hidden = false;
  $("done-title").setAttribute("tabindex", "-1");
  $("done-title").focus();
}

/** Playback keys. Shift+arrows move by commit, plain arrows by chunk. */
const KEYS = {
  ArrowRight: (shift) => (shift ? nextCommit() : stepBeat(1)),
  ArrowLeft: (shift) => (shift ? previousCommit() : stepBeat(-1)),
  l: () => stepBeat(1),
  h: () => stepBeat(-1),
  n: nextCommit,
  j: nextCommit,
  p: previousCommit,
  k: previousCommit,
  r: () => player.view === "play" && toBeat(currentBeat()),
  c: () => commentOnPick("change"),
  q: () => commentOnPick("question"),
  Escape: () => (narrow.matches && panelOpen ? togglePanel() : clearPick()),
  y: () => decideCurrent("kept"),
  x: () => decideCurrent("dismissed"),
  m: toggleMute,
  t: togglePanel,
  "?": toggleKeys,
};

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    $("keys").open
  ) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // A focused button already answers space by clicking itself.
  if (event.key === " " && !(target instanceof HTMLButtonElement)) {
    event.preventDefault();
    if (player.playing) pause();
    else play();
    return;
  }
  const action = Object.hasOwn(KEYS, event.key) ? KEYS[event.key] : undefined;
  if (action === undefined) return;
  event.preventDefault();
  action(event.shiftKey);
});

$("end").addEventListener("click", () => guarded(endReview));
$("commits-toggle").addEventListener("click", () =>
  setListOpen(!$("sidebar").classList.contains("open")),
);
$("sidebar").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("sidebar").classList.contains("open")) {
    setListOpen(false);
    $("commits-toggle").focus();
  }
});
window.addEventListener("resize", markClamped);
for (const type of ["mouseover", "focusin"]) $("commits").addEventListener(type, showRailTip);
for (const type of ["mouseout", "focusout"]) $("commits").addEventListener(type, hideRailTip);
window.addEventListener("focus", () => renderSwitcher());
renderSwitcher();

function renderHeader() {
  const walk = isWalk();
  document.title = walk ? "follow-me code review" : "follow-me review";
  $("summary").textContent = walk
    ? `${state.anchor.branch} · Code review`
    : `${state.anchor.branch} · Review of plan v${state.version}`;
  $("end").textContent = walk ? "Finish code review" : "End review";
}

/** Makes a fetched state the page's own: indexes, highlighting and header. */
async function adopt(fresh) {
  state = {
    ...fresh,
    decisions: decisionsById(fresh.concerns ?? []),
    resolved: fresh.resolved ?? [],
    previous: fresh.previous ?? null,
  };
  indexOwnership();
  highlighted.clear();
  await loadHighlighting(state.units);
  renderHeader();
}

/** Says a plan arrived, and offers the answers it brings when it has any. */
function announceVersion() {
  const answered = answeredCount(state.previous);
  $("banner-text").textContent = bannerText(state.version, answered);
  $("banner-show").hidden = answered === 0;
  $("banner").hidden = false;
}

/** A newer plan arrived: swap it in place and stay on the commit being read when it survives. */
async function swapVersion() {
  const fresh = await api("GET", "/api/state");
  if (fresh.version <= state.version) return;
  const title = state.commits[selected] ? firstLine(state.commits[selected].message) : null;
  const was = selected;
  await adopt(fresh);
  buildPlayback();
  selected = keepCommit(title, was, state.commits);
  watched.clear();
  announceVersion();
  if (player.view === "play") seek(beatStart(steps, introOf(beats, selected)));
  else render();
}

let ending = false;

function showEnded() {
  if (ending || !$("done").hidden) return;
  player.generation += 1;
  synth?.cancel();
  $("done").replaceChildren(
    el(
      "section",
      { class: "done-card", "aria-labelledby": "done-title" },
      el("h1", { id: "done-title", text: "Review ended" }),
      el("p", { class: "muted", text: "This review was ended in another window. It is saved." }),
      el("p", {}, el("a", { href: "/", text: "All sessions" })),
    ),
  );
  $("done").hidden = false;
}

async function receive(event) {
  logEvent(event);
  noticeEvent(event);
  const { state: next, effect } = applyEvent(state, event);
  state = next;
  if (effect === "refetch") await swapVersion();
  else if (effect === "ended") showEnded();
  else render();
}

const sleep_ = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page's whole state again, after the server's log no longer matches what we followed. */
async function resync() {
  const fresh = await api("GET", "/api/state");
  const title = state.commits[selected] ? firstLine(state.commits[selected].message) : null;
  const was = selected;
  await adopt(fresh);
  await loadLog();
  buildPlayback();
  selected = keepCommit(title, was, state.commits);
  render();
  return fresh.seq ?? 0;
}

/** Reads the push stream until it fails twice in a row, resolving with the last seq seen. */
function followStream(since, onEvent) {
  return new Promise((resolve) => {
    let last = since;
    let failures = 0;
    const source = new EventSource(`${sessionPrefix}/api/events/stream?since=${since}`);
    const stop = () => {
      source.close();
      resolve(last);
    };
    source.addEventListener("message", async (message) => {
      failures = 0;
      try {
        const event = JSON.parse(message.data);
        last = Math.max(last, event.seq ?? 0);
        await onEvent(event);
      } catch {
        // A malformed event is skipped; the next one still applies.
      }
      if (!$("done").hidden) stop();
    });
    source.addEventListener("error", () => {
      failures += 1;
      if (failures >= 2 || source.readyState === EventSource.CLOSED) stop();
    });
  });
}

/** Long-polls for what others changed, reconnecting with backoff after an error. */
async function pollEvents(from) {
  let since = from;
  let failures = 0;
  while ($("done").hidden) {
    try {
      const res = await fetch(`${sessionPrefix}/api/events?since=${since}&timeout=25000`);
      // A server without live updates answers 404; the page then works as it always did.
      if (res.status === 404) return;
      if (res.status === 409) {
        since = await resync();
        continue;
      }
      if (!res.ok) throw new Error(`events failed with ${res.status}`);
      const reply = await res.json();
      failures = 0;
      since = nextSince(since, reply);
      for (const event of reply.events ?? []) await receive(event);
    } catch {
      failures += 1;
      await sleep_(backoffMs(failures));
    }
  }
}

/** Follows the server from the seq of the state we hold, so nothing between is missed. */
async function followEvents() {
  let since = state.seq ?? 0;
  if ("EventSource" in window) since = await followStream(since, receive);
  if ($("done").hidden) await pollEvents(since);
}

$("banner-show").addEventListener("click", () => {
  setListOpen(true);
  $("answers").scrollIntoView({ block: "nearest" });
  $("answers").querySelector("button")?.focus();
});

$("banner-close").addEventListener("click", () => {
  $("banner").hidden = true;
});

guarded(async () => {
  await adopt(await api("GET", "/api/state"));
  await loadLog();
  setUpPlayer();
  if (isWalk()) enterPlay();
  else render();
  if (answeredCount(state.previous) > 0) announceVersion();
  followEvents();
});
