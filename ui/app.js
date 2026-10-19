const $ = (id) => document.getElementById(id);

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
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? `${method} ${path} failed with ${res.status}`);
  return payload;
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

function diffLine(unit, commit, line, pickKey) {
  const base = el("span", { class: "op", text: line.op });
  const text = el("span", { text: line.text.replace(/\n$/, "") });
  if (line.op === " ")
    return el("div", { class: "dl" }, el("span", { class: "gutter" }), base, text);

  const owner = owners.get(unit.id)?.get(line.change);
  const mine = owner === commit.index;
  const picked = picks.get(pickKey)?.has(line.change) ?? false;
  const classes = ["dl", line.op === "+" ? "add" : "del", mine ? "mine pickable" : "other"];
  if (picked) classes.push("picked");
  const node = el(
    "div",
    {
      class: classes.join(" "),
      title: mine ? "Click to select this line for a comment" : undefined,
      onclick: mine
        ? () => {
            const set = picks.get(pickKey) ?? new Set();
            if (!set.delete(line.change)) set.add(line.change);
            picks.set(pickKey, set);
            render();
          }
        : undefined,
    },
    el("span", { class: "gutter", text: String(line.change) }),
    base,
    text,
  );
  if (!mine && owner !== undefined)
    node.append(el("span", { class: "label", text: `→ commit ${owner + 1}` }));
  return node;
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

function unitView(unit, commit) {
  const pickKey = `${commit.index}:${unit.id}`;
  const head = el("div", { class: "unit-head" }, el("span", { text: unit.id }));
  let content;
  if (unit.kind === "hunk") {
    const mineCount = [...(owners.get(unit.id) ?? [])].filter(([, o]) => o === commit.index).length;
    head.append(
      el("span", { class: "spacer" }),
      el("span", { text: `takes ${mineCount} of ${unit.changeCount} changes` }),
    );
    content = el(
      "div",
      { class: "diff" },
      ...unit.body.map((line) => diffLine(unit, commit, line, pickKey)),
    );
  } else {
    const summary =
      unit.kind === "file" ? describeFileUnit(unit) : `mode change ${unit.from} → ${unit.to}`;
    content = el("div", { class: "card", text: `${summary}: ${unit.path}` });
  }
  return el("div", { class: "unit" }, head, content, unitComments(unit, commit));
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
        count > 0 ? el("span", { class: "badge", text: String(count) }) : null,
      );
    }),
  );
  list.children[selected]?.scrollIntoView({ block: "nearest" });
}

function renderPlanNote() {
  const anchor = { kind: "plan" };
  $("plan-note").replaceChildren(
    el("strong", { text: "Plan note" }),
    ...commentsAt(anchor).map(commentView),
    commentBox({
      key: "box:plan",
      label: "Add a note on the whole plan",
      placeholder: "Anything about the plan as a whole",
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
    el(
      "div",
      { class: "commit-head" },
      el("h2", { text: `Commit ${selected + 1} of ${state.commits.length}` }),
      el("div", { class: "message", text: commit.message }),
      ...commentsAt(messageAnchor).map(commentView),
      el(
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
}

function render() {
  renderList();
  renderPlanNote();
  renderMain();
}

function select(index) {
  selected = Math.max(0, Math.min(state.commits.length - 1, index));
  render();
  $("main").scrollTop = 0;
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
  const done = $("done");
  done.replaceChildren(
    el(
      "p",
      {},
      `Review saved to reviews/v${state.version}.json. Run `,
      el("code", { text: "follow-me feedback" }),
      " or hand the session to your agent.",
    ),
  );
  done.hidden = false;
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "j") select(selected + 1);
  if (event.key === "k") select(selected - 1);
});

$("end").addEventListener("click", () => guarded(endReview));

guarded(async () => {
  state = await api("GET", "/api/state");
  indexOwnership();
  $("summary").textContent = `${state.anchor.branch} · plan v${state.version}`;
  render();
});
