import {
  beatAt,
  beatStart,
  buildScript,
  chunkOf,
  commitOf,
  diagramAt,
  hasDiagrams,
  hasNarration,
  introOf,
  lineKey,
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
/** unit id -> (change index -> index of the commit that owns the line) */
let owners = new Map();
/** "commit:unit" -> change indices the reader clicked, to anchor a comment to them */
const picks = new Map();
/** Unsent textarea contents survive re-renders, keyed like the boxes. */
const drafts = new Map();
const openBoxes = new Set();
const editing = new Set();

async function api(method, path, body) {
  const res = await fetch(`${sessionPrefix}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
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
  $("status").textContent = error ? error.message : "";
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

function describeChanges(changes) {
  return changes === null ? "whole hunk" : `lines ${changes.join(", ")}`;
}

function commentView(comment) {
  const key = `edit:${comment.id}`;
  if (editing.has(comment.id)) {
    const area = el("textarea", {
      oninput: () => drafts.set(key, area.value),
    });
    area.value = drafts.get(key) ?? comment.body;
    return el(
      "div",
      { class: "comment" },
      area,
      el(
        "div",
        { class: "row box" },
        el("button", {
          class: "primary",
          text: "Save",
          onclick: () =>
            guarded(async () => {
              await api("PUT", `/api/comments/${comment.id}`, { ...comment, body: area.value });
              editing.delete(comment.id);
              drafts.delete(key);
              await reloadComments();
            }),
        }),
        el("button", {
          text: "Cancel",
          onclick: () => {
            editing.delete(comment.id);
            drafts.delete(key);
            render();
          },
        }),
      ),
    );
  }
  const where =
    comment.anchor.kind === "hunk" ? ` · ${describeChanges(comment.anchor.changes)}` : "";
  return el(
    "div",
    { class: "comment" },
    el("div", { class: "meta" }, `${comment.id}${where}`),
    el("div", { class: "text", text: comment.body }),
    el(
      "div",
      { class: "meta" },
      el("button", {
        class: "link",
        text: "edit",
        onclick: () => {
          editing.add(comment.id);
          render();
        },
      }),
      el("button", {
        class: "link",
        text: "delete",
        onclick: () =>
          guarded(async () => {
            await api("DELETE", `/api/comments/${comment.id}`);
            await reloadComments();
          }),
      }),
    ),
  );
}

/**
 * A collapsed button that opens into a textarea. `makeAnchor` runs at save time so a
 * hunk comment picks up whichever lines are selected then.
 */
function commentBox({ key, label, placeholder, makeAnchor, context, onSaved }) {
  if (!openBoxes.has(key)) {
    return el("button", {
      text: typeof label === "function" ? label() : label,
      onclick: () => {
        openBoxes.add(key);
        render();
      },
    });
  }
  const area = el("textarea", { placeholder, oninput: () => drafts.set(key, area.value) });
  area.value = drafts.get(key) ?? "";
  const close = () => {
    openBoxes.delete(key);
    drafts.delete(key);
  };
  return el(
    "div",
    { class: "box" },
    area,
    el(
      "div",
      { class: "row" },
      el("button", {
        class: "primary",
        text: "Comment",
        onclick: () =>
          guarded(async () => {
            const body = area.value.trim();
            if (!body) return;
            await api("POST", "/api/comments", { anchor: makeAnchor(), context, body });
            close();
            onSaved?.();
            await reloadComments();
          }),
      }),
      el("button", {
        text: "Cancel",
        onclick: () => {
          close();
          render();
        },
      }),
    ),
  );
}

function describeFileUnit(unit) {
  const change = unit.before === null ? "added" : unit.after === null ? "deleted" : "changed";
  return `${unit.reason} file ${change}`;
}

/** One line of a hunk. Only the commit's own change lines can be picked for a comment. */
function diffLine(unit, index, mine, pickKey) {
  const line = unit.body[index];
  const key = lineKey(unit.id, index);
  const text = el("span", { class: "text", text: line.text.replace(/\n$/, "") });
  if (!mine) {
    return el(
      "div",
      { class: "dl", "data-line": key },
      el("span", { class: "gutter" }),
      el("span", { class: "op", text: " " }),
      text,
    );
  }
  const picked = picks.get(pickKey)?.has(line.change) ?? false;
  const classes = ["dl", line.op === "+" ? "add" : "del", "mine"];
  if (picked) classes.push("picked");
  return el(
    "div",
    {
      class: classes.join(" "),
      "data-line": key,
      title: "Click to select this line for a comment",
      onclick: () => {
        const set = picks.get(pickKey) ?? new Set();
        if (!set.delete(line.change)) set.add(line.change);
        picks.set(pickKey, set);
        render();
      },
    },
    el("span", { class: "gutter", text: String(line.change) }),
    el("span", { class: "op", text: line.op }),
    text,
  );
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

function unitComments(unit, commit) {
  const anchor = { kind: "hunk", unit: unit.id, commit: commit.index, changes: null };
  const pickKey = `${commit.index}:${unit.id}`;
  const existing = commentsAt(anchor);
  const picked = () => [...(picks.get(pickKey) ?? [])].sort((a, b) => a - b);
  return el(
    "div",
    { class: "comments" },
    ...existing.map(commentView),
    el(
      "div",
      { class: "controls" },
      commentBox({
        key: `box:${pickKey}`,
        label: () => {
          const n = picked().length;
          return n > 0 ? `Comment on ${n} selected line${n === 1 ? "" : "s"}` : "Comment";
        },
        placeholder: "What about this change?",
        makeAnchor: () => ({ ...anchor, changes: picked().length > 0 ? picked() : null }),
        context: { commitMessage: commit.message, path: unit.path },
        onSaved: () => picks.delete(pickKey),
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
  const pickKey = `${commit.index}:${unit.id}`;
  const ref = commit.refs.find((r) => r.unit === unit.id);
  const head = el("div", { class: "unit-head", title: unit.id });
  let content;
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
    content = el(
      "div",
      { class: "diff" },
      ...rows.map((row) =>
        row.kind === "fold"
          ? foldRow(row.lines, row.commit)
          : diffLine(unit, row.line, row.mine, pickKey),
      ),
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
    staticNarration(ref?.narration?.trim()),
    content,
    unitComments(unit, commit),
  );
}

function renderList() {
  const list = $("commits");
  list.replaceChildren(
    ...state.commits.map((commit, i) => {
      const count = state.comments.filter(
        (c) => c.anchor.kind !== "plan" && c.anchor.commit === commit.index,
      ).length;
      return el(
        "li",
        {
          class: i === selected ? "selected" : undefined,
          onclick: () => select(i),
        },
        el("span", { class: "index", text: String(i + 1) }),
        el("span", { class: "title", text: firstLine(commit.message) }),
        player.view === "play" && i === selected
          ? el("span", { class: "mark", "aria-label": "playing", text: "▶" })
          : watched.has(i)
            ? el("span", { class: "mark", "aria-label": "watched", text: "✓" })
            : null,
        count > 0 ? el("span", { class: "badge", text: String(count) }) : null,
      );
    }),
  );
  list.children[selected]?.scrollIntoView({ block: "nearest" });
}

function renderPlanNote() {
  const anchor = { kind: "plan" };
  const walk = isWalk();
  $("plan-note").replaceChildren(
    el("strong", { text: walk ? "General comment" : "Plan note" }),
    ...commentsAt(anchor).map(commentView),
    commentBox({
      key: "box:plan",
      label: walk ? "Add a general comment" : "Add a note on the whole plan",
      placeholder: walk
        ? "Anything about the change as a whole"
        : "Anything about the plan as a whole",
      makeAnchor: () => anchor,
      context: { commitMessage: "", path: null },
    }),
  );
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
      ...commentsAt(messageAnchor).map(commentView),
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
              makeAnchor: () => messageAnchor,
              context,
            }),
            commentBox({
              key: `box:position:${commit.index}`,
              label: "This belongs elsewhere",
              placeholder: "Where should this go, and why?",
              makeAnchor: () => positionAnchor,
              context,
            }),
          ),
      ...commentsAt(positionAnchor).map(commentView),
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
}

function render() {
  renderList();
  renderPlanNote();
  renderMain();
}

function select(index) {
  const next = Math.max(0, Math.min(state.commits.length - 1, index));
  if (player.view === "play") {
    seek(beatStart(steps, introOf(beats, next)));
    return;
  }
  selected = next;
  render();
  $("main").scrollTop = 0;
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

/** Draws the diagram for what is on screen into the side panel, or hides the panel. */
async function renderDiagram() {
  const panel = $("diagram");
  const beat = player.view === "play" ? beats[beatAt(steps, player.position)] : undefined;
  const shown = diagramAt(state.commits[selected], beat);
  panel.hidden = shown === null;
  if (shown === null || shown.source === drawn) return;
  drawn = shown.source;
  const unit = shown.unit === null ? null : unitsById.get(shown.unit);
  $("diagram-from").textContent = unit ? unit.path : "this commit";
  const body = $("diagram-body");
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
      el("p", { class: "diagram-error", text: "Mermaid could not draw this diagram:" }),
      el("pre", { class: "diagram-error", text: error?.message ?? String(error) }),
    );
  }
}

function applyPlayback() {
  const main = $("main");
  if (hasDiagrams(state.commits)) renderDiagram();
  for (const node of main.querySelectorAll(".ph, .countdown")) node.remove();
  card.remove();
  renderStage();
  if (player.view !== "play") {
    for (const node of main.querySelectorAll("[data-line], .unit")) {
      node.classList.remove("pending", "struck", "in-chunk");
    }
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
  if (step.kind !== "say" || silent()) return sleep(step.ms, generation);
  const [read, heard] = await Promise.all([
    sleep(step.ms, generation),
    speak(step.text, generation).then((ok) => ok && sleep(step.tail, generation)),
  ]);
  return read && heard && generation === player.generation;
}

async function playLoop(generation) {
  while (player.position < steps.length) {
    if (!(await sleep(0, generation))) return;
    if (!(await perform(steps[player.position], generation))) return;
    player.position += 1;
    present();
  }
  player.playing = false;
  renderList();
  updatePlayer();
}

/** Moves to a step and starts a fresh loop, which waits while paused. */
function seek(position) {
  synth?.cancel();
  player.position = Math.max(0, Math.min(steps.length, position));
  player.generation += 1;
  present();
  playLoop(player.generation);
}

function play() {
  if (player.view !== "play") enterPlay();
  if (player.position >= steps.length) seek(0);
  player.playing = true;
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
  if (player.view !== "play") return select(selected + 1);
  toBeat(introOf(beats, selected + 1));
}

/** Restarts the commit; a second press within 1.5s goes to the previous one. */
function previousCommit() {
  if (player.view !== "play") return select(selected - 1);
  const now = performance.now();
  const intro = introOf(beats, selected);
  const again = now - restartedAt < 1500 || currentBeat() === intro;
  restartedAt = now;
  toBeat(again ? introOf(beats, selected - 1) : intro);
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

function setDiagramOpen(open) {
  $("diagram-toggle").setAttribute("aria-expanded", String(open));
  $("diagram").classList.toggle("collapsed", !open);
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

function setUpPlayer() {
  beats = buildScript(state.commits, state.units);
  narrated = hasNarration(state.commits);
  setSpeed(parseSpeed(stored("speed")));
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
  for (const id of ["voice-label", "mute"]) $(id).hidden = !narrated;
  synth?.addEventListener("voiceschanged", loadVoices);
  loadVoices();
  $("play").addEventListener("click", () => (player.playing ? pause() : play()));
  $("prev-commit").addEventListener("click", previousCommit);
  $("next-commit").addEventListener("click", nextCommit);
  $("prev-beat").addEventListener("click", () => stepBeat(-1));
  $("next-beat").addEventListener("click", () => stepBeat(1));
  $("keys-button").addEventListener("click", toggleKeys);
  $("mute").addEventListener("click", toggleMute);
  $("diagram-toggle").addEventListener("click", () => {
    const open = $("diagram-toggle").getAttribute("aria-expanded") !== "true";
    setDiagramOpen(open);
    store("diagram", String(open));
  });
  setDiagramOpen(stored("diagram") !== "false");
  $("view-toggle").addEventListener("click", () => {
    if (player.view === "play") enterBrowse();
    else play();
    // Space should now drive playback, not this button.
    stage.querySelector("h2")?.focus({ preventScroll: true });
  });
  updatePlayer();
}

function hasUnsentText() {
  return [...drafts.values()].some((text) => text.trim() !== "");
}

async function endReview() {
  if (
    hasUnsentText() &&
    !window.confirm("Some comment boxes have text you have not sent. End anyway?")
  ) {
    return;
  }
  await api("POST", "/api/end");
  player.generation += 1;
  synth?.cancel();
  const done = $("done");
  const saved = `reviews/v${state.version}.json`;
  done.replaceChildren(
    isWalk()
      ? el(
          "p",
          {},
          `Code review saved to ${saved}. The author can run `,
          el("code", { text: "follow-me feedback" }),
          " to read it.",
        )
      : el(
          "p",
          {},
          `Review saved to ${saved}. Run `,
          el("code", { text: "follow-me feedback" }),
          " or hand the session to your agent.",
        ),
    el("p", {}, el("a", { href: "/", text: "All sessions" })),
  );
  done.hidden = false;
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
  m: toggleMute,
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
window.addEventListener("focus", () => renderSwitcher());
renderSwitcher();

guarded(async () => {
  state = await api("GET", "/api/state");
  indexOwnership();
  const walk = isWalk();
  document.title = walk ? "follow-me code review" : "follow-me review";
  $("summary").textContent = walk
    ? `${state.anchor.branch} · Code review`
    : `${state.anchor.branch} · Review of plan v${state.version}`;
  $("end").textContent = walk ? "Finish code review" : "End review";
  setUpPlayer();
  if (walk) enterPlay();
  else render();
});
