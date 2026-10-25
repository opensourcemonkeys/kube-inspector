// toolbox change-history UI. Plain DOM, no build step. Every value from the
// API goes in through textContent, never innerHTML: object names, user agents
// and patch values are all attacker-controllable strings.
"use strict";

const TOKEN_KEY = "toolbox-token";
const state = { tab: "changes", cursor: "", items: [], activeId: "" };

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function askToken() {
  return new Promise((resolve) => {
    const dlg = $("#token-dialog");
    const input = $("#token-input");
    input.value = "";
    dlg.addEventListener("close", () => {
      try { localStorage.setItem(TOKEN_KEY, input.value.trim()); } catch { /* private mode */ }
      resolve();
    }, { once: true });
    dlg.showModal();
  });
}

// Relative URLs on purpose: the UI also works behind the API server's service
// proxy, where it lives under /api/v1/namespaces/<ns>/services/<svc>/proxy/.
async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  const url = "api/v1/" + path + (qs.toString() ? "?" + qs : "");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { "X-Toolbox-Token": token() } });
    if (res.status === 401 && attempt === 0) { await askToken(); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  throw new Error("unauthorized");
}

function filters() {
  const f = Object.fromEntries(new FormData($("#filters")));
  return f;
}

function fmtTime(s) {
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function verbLamp(v) { return el("span", { class: `lamp verb-${v}` }, v); }

function actorCell(c) {
  if (c.actor && c.actor.username) {
    return el("span", {}, c.actor.username,
      c.actor.impersonatedBy ? el("span", { class: "muted" }, ` (by ${c.actor.impersonatedBy})`) : null);
  }
  return el("span", { class: "manager", title: "Only the field manager is known" }, c.fieldManager ? `(${c.fieldManager})` : "unknown");
}

function objectLabel(c) {
  return el("span", {}, el("span", { class: "muted" }, c.kind + " "), c.name);
}

function setMessage(text) {
  $("#list").replaceChildren(el("div", { class: "empty" }, text));
}

// ---- Changes ---------------------------------------------------------------

async function loadChanges(append) {
  if (!append) { state.cursor = ""; state.items = []; }
  try {
    const res = await api("changes", { ...filters(), limit: 100, cursor: state.cursor });
    state.items = state.items.concat(res.items);
    state.cursor = res.nextCursor || "";
    renderChanges();
  } catch (e) {
    setMessage("Could not load changes: " + e.message);
  }
}

function renderChanges() {
  if (state.items.length === 0) { setMessage("No changes match these filters."); return; }
  const rows = state.items.map((c) => {
    const tr = el("tr", { tabindex: "0", onclick: () => openChange(c.eventId), onkeydown: (e) => { if (e.key === "Enter") openChange(c.eventId); } },
      el("td", { class: "time" }, fmtTime(c.time)),
      el("td", {}, verbLamp(c.verb)),
      el("td", {}, objectLabel(c)),
      el("td", {}, c.namespace || el("span", { class: "muted" }, "—")),
      el("td", {}, actorCell(c)),
      el("td", { class: "mono" }, (c.actor && c.actor.sourceIPs || []).join(", ")),
      el("td", { class: "attr" }, c.attribution),
      el("td", { class: "paths", title: (c.changedPaths || []).join("\n") }, (c.changedPaths || []).slice(0, 3).join("  ")));
    if (c.eventId === state.activeId) tr.classList.add("active");
    tr.dataset.id = c.eventId;
    return tr;
  });
  const table = el("table", {},
    el("thead", {}, el("tr", {}, ["Time", "Verb", "Object", "Namespace", "User", "Source IP", "Via", "Changed"].map((h) => el("th", {}, h)))),
    el("tbody", {}, rows));
  const more = state.cursor ? el("button", { class: "plain more", onclick: () => loadChanges(true) }, "Load more") : null;
  $("#list").replaceChildren(table, more || "");
}

async function openChange(id) {
  state.activeId = id;
  document.querySelectorAll("tbody tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.id === id));
  const pane = $("#detail");
  pane.hidden = false;
  pane.replaceChildren(el("div", { class: "muted" }, "Loading…"));
  try {
    renderDetail(await api("changes/" + id));
  } catch (e) {
    pane.replaceChildren(el("div", { class: "muted" }, "Could not load: " + e.message));
  }
}

function pretty(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

// The stored patch is invertible: each replace/remove is preceded by a "test"
// op holding the old value, which is what lets us show old → new.
function renderOps(patch) {
  let ops = [];
  try { ops = JSON.parse(patch || "[]"); } catch { /* shown raw below */ }
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === "test") continue;
    const prev = i > 0 && ops[i - 1].op === "test" && ops[i - 1].path === op.path ? ops[i - 1] : null;
    out.push(el("div", { class: "op" },
      el("div", { class: "path" }, `${op.op} ${op.path}`),
      prev ? el("div", { class: "old" }, pretty(prev.value)) : null,
      op.op !== "remove" ? el("div", { class: "new" }, pretty(op.value)) : null));
  }
  return out.length ? out : [el("div", { class: "muted" }, "No field changes.")];
}

function renderDetail(c) {
  const a = c.actor || {};
  const facts = [
    ["Time", fmtTime(c.time)],
    ["Verb", verbLamp(c.verb)],
    ["Object", `${c.group ? c.group + "/" : ""}${c.apiVersion} ${c.kind}`],
    ["Namespace", c.namespace || "—"],
    ["UID", c.objectUid],
    ["Resource version", c.resourceVersion || "—"],
    ["User", a.username || "—"],
    ["Impersonated by", a.impersonatedBy || null],
    ["Groups", (a.groups || []).join(", ") || null],
    ["Source IPs", (a.sourceIPs || []).join(", ") || null],
    ["User agent", a.userAgent || null],
    ["Field manager", c.fieldManager || null],
    ["Attributed via", c.attribution],
    ["Audit ID", a.auditId || null],
  ].filter(([, v]) => v != null);

  const dl = el("dl", { class: "facts" }, facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  const objects = el("details", {},
    el("summary", {}, "Before / after"),
    c.before ? [el("h3", {}, "Before"), el("pre", { class: "json" }, pretty(JSON.parse(c.before)))] : null,
    c.after ? [el("h3", {}, "After"), el("pre", { class: "json" }, pretty(JSON.parse(c.after)))] : null);

  $("#detail").replaceChildren(
    el("button", { class: "plain close", onclick: closeDetail, "aria-label": "Close" }, "Close"),
    el("h2", {}, c.name),
    dl,
    el("h3", {}, "Changes"),
    el("div", { class: "ops" }, renderOps(c.patch)),
    objects);
}

function closeDetail() {
  state.activeId = "";
  $("#detail").hidden = true;
  document.querySelectorAll("tbody tr.active").forEach((tr) => tr.classList.remove("active"));
}

// ---- Rejected attempts ------------------------------------------------------

async function loadAttempts() {
  try {
    const f = filters();
    const res = await api("attempts", { namespace: f.namespace, resource: f.resource, name: f.name, user: f.user, since: f.since, limit: 200 });
    if (!res.items.length) { setMessage("No rejected requests. (This list needs the audit webhook.)"); return; }
    const rows = res.items.map((r) => el("tr", {},
      el("td", { class: "time" }, fmtTime(r.time)),
      el("td", {}, el("span", { class: "lamp code-err" }, `${r.responseCode} ${r.responseReason || ""}`)),
      el("td", {}, r.verb),
      el("td", {}, el("span", { class: "muted" }, r.resource + (r.subresource ? "/" + r.subresource : "") + " "), r.name || "—"),
      el("td", {}, r.namespace || "—"),
      el("td", {}, r.username),
      el("td", { class: "mono" }, (r.sourceIPs || []).join(", ")),
      el("td", { class: "paths", title: r.responseMessage || "" }, r.responseMessage || "")));
    $("#list").replaceChildren(el("table", {},
      el("thead", {}, el("tr", {}, ["Time", "Response", "Verb", "Object", "Namespace", "User", "Source IP", "Message"].map((h) => el("th", {}, h)))),
      el("tbody", {}, rows)));
  } catch (e) {
    setMessage("Could not load attempts: " + e.message);
  }
}

// ---- Users -----------------------------------------------------------------

async function loadUsers() {
  try {
    const res = await api("users", { since: filters().since || "720h" });
    if (!res.items.length) { setMessage("No attributed changes yet."); return; }
    const rows = res.items.map((u) => el("tr", { onclick: () => { $("#filters").user.value = u.username; selectTab("changes"); } },
      el("td", {}, u.username),
      el("td", {}, u.changes),
      el("td", { class: "time" }, fmtTime(u.lastSeen)),
      el("td", { class: "mono" }, (u.sourceIPs || []).join(", ")),
      el("td", { class: "paths", title: (u.userAgents || []).join("\n") }, (u.userAgents || []).join(", "))));
    $("#list").replaceChildren(el("table", {},
      el("thead", {}, el("tr", {}, ["User", "Changes", "Last seen", "Source IPs", "User agents"].map((h) => el("th", {}, h)))),
      el("tbody", {}, rows)));
  } catch (e) {
    setMessage("Could not load users: " + e.message);
  }
}

// ---- Wiring ----------------------------------------------------------------

function load() {
  closeDetail();
  if (state.tab === "changes") return loadChanges(false);
  if (state.tab === "attempts") return loadAttempts();
  return loadUsers();
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  load();
}

document.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

let debounce;
$("#filters").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(load, 300); });
$("#filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

(async () => {
  try {
    const info = await api("info");
    $("#cluster").textContent = info.cluster;
  } catch { /* the list shows the error */ }
  load();
})();
