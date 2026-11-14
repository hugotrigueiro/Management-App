import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
});

/* ================= Estado ================= */
const S = {
  session: null, uid: null, me: null,
  profiles: new Map(), workspaces: [], members: [], tasks: [], assignees: new Map(),
  loaded: false,
  ws: store("t.ws"), status: "open", q: "", project: "", client: "", assignee: "", due: "", prio: "",
  view: store("t.view") || "date", sort: store("t.sort") || "asc",
  editing: null, pick: [], editingWs: null
};
const PRIO = { 1: "Urgente", 2: "Alta", 3: "Média", 4: "Baixa" };

/* ================= Utilidades ================= */
const $ = (id) => document.getElementById(id);
function h(tag, attrs, kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids || []) if (c) el.append(c);
  return el;
}
function store(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; }
}
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function fail(err, fallback) {
  console.error(err);
  const m = (err && (err.message || err.error_description)) || "";
  if (/permission|policy|row-level/i.test(m)) toast("Você não tem permissão para isso neste ambiente.");
  else if (/Só o dono/.test(m)) toast(m);
  else toast(fallback || "Não consegui salvar. Verifique a conexão e tente de novo.");
}
const uniq = (arr) => {
  const seen = new Set(); const out = [];
  for (let v of arr) { v = (v || "").trim(); const k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
  return out.sort((a, b) => a.localeCompare(b, "pt-BR"));
};

/* ================= Datas ================= */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => ymd(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
function fmtDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number); const dt = new Date(y, m - 1, d);
  if (s === today()) return "Hoje";
  if (s === addDays(1)) return "Amanhã";
  if (s === addDays(-1)) return "Ontem";
  let out = `${WD[dt.getDay()]}, ${d} ${MO[m - 1]}`;
  if (y !== new Date().getFullYear()) out += ` ${y}`;
  return out;
}
function fmtStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ================= Pessoas ================= */
function nameOf(id, short) {
  if (!id) return "alguém";
  if (id === S.uid) return short ? "Você" : "você";
  const p = S.profiles.get(id);
  const n = (p && (p.display_name || p.email)) || "";
  if (!n) return short ? "Usuário" : "alguém";
  return short ? n.split(" ")[0] : n;
}
function avatar(id) {
  const p = S.profiles.get(id);
  if (p && p.avatar_url) return h("img", { src: p.avatar_url, alt: "", referrerpolicy: "no-referrer" });
  const n = nameOf(id, true);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#6b7a99"/><text x="12" y="16" font-size="11" text-anchor="middle" fill="#fff" font-family="sans-serif">${(n[0] || "?").toUpperCase()}</text></svg>`;
  return h("img", { src: "data:image/svg+xml;utf8," + encodeURIComponent(svg), alt: "" });
}

/* ================= Derivados ================= */
const currentWs = () => S.workspaces.find((w) => w.id === S.ws) || null;
const isWork = (w) => w && w.kind === "trabalho";
const tasksIn = (wsId) => S.tasks.filter((t) => t.workspace_id === wsId);
const membersOf = (wsId) => S.members.filter((m) => m.workspace_id === wsId);
const myRole = (wsId) => (S.members.find((m) => m.workspace_id === wsId && m.user_id === S.uid) || {}).role;
const isOwner = (wsId) => myRole(wsId) === "owner";
const assigneesOf = (taskId) => S.assignees.get(taskId) || [];

/* ================= Carregamento ================= */
async function fetchAll(table, columns, order) {
  const out = []; const step = 1000;
  for (let from = 0; ; from += step) {
    let q = sb.from(table).select(columns).range(from, from + step - 1);
    if (order) q = q.order(order);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < step) break;
  }
  return out;
}
let loading = null, reloadTimer = null;
async function loadAll() {
  if (loading) { scheduleReload(); return loading; }
  loading = (async () => {
    try {
      const [profiles, workspaces, members, tasks, assignees] = await Promise.all([
        fetchAll("profiles", "id,email,display_name,avatar_url"),
        fetchAll("workspaces", "*", "sort_order"),
        fetchAll("workspace_members", "workspace_id,user_id,role"),
        fetchAll("tasks", "*", "id"),
        fetchAll("task_assignees", "task_id,user_id")
      ]);
      S.profiles = new Map(profiles.map((p) => [p.id, p]));
      S.me = S.profiles.get(S.uid) || S.me;
      S.workspaces = workspaces.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
      S.members = members;
      S.tasks = tasks;
      const map = new Map();
      for (const a of assignees) { if (!map.has(a.task_id)) map.set(a.task_id, []); map.get(a.task_id).push(a.user_id); }
      S.assignees = map;
      S.loaded = true;
      render();
      if (!$("ov-ws").hidden && S.editingWs) renderMembers();
    } catch (e) {
      console.error(e);
      if (!S.loaded) $("main").replaceChildren(h("div", { class: "notice" }, [h("strong", { text: "Não consegui carregar as tarefas." }), h("span", { text: "Verifique a conexão. Vou tentar de novo em instantes." })]));
      setTimeout(loadAll, 5000);
    } finally { loading = null; }
  })();
  return loading;
}
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 350); }

let channel = null;
function subscribe() {
  if (channel) return;
  channel = sb.channel("tudo");
  for (const table of ["tasks", "task_assignees", "workspaces", "workspace_members", "profiles"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleReload);
  }
  channel.subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.uid) scheduleReload(); });

/* ================= Render ================= */
function renderMe() {
  const p = S.me;
  $("me-name").textContent = p ? (p.display_name || p.email).split(" ")[0] : "";
  const img = avatar(S.uid); $("me-avatar").src = img.src;
}

function renderChips() {
  const box = $("wschips"); box.replaceChildren();
  for (const w of S.workspaces) {
    const open = tasksIn(w.id).filter((t) => !t.done).length;
    box.append(h("button", {
      type: "button", class: `chip ${w.kind}`, "aria-pressed": String(w.id === S.ws),
      onclick: () => { S.ws = w.id; S.project = S.client = S.assignee = ""; store("t.ws", w.id); render(); }
    }, [h("span", { class: "dot" }), h("span", { text: w.name }), h("span", { class: "count", text: String(open) })]));
  }
  box.append(h("button", { type: "button", class: "chip ghost", text: "+ Ambiente", onclick: () => openWs(null) }));
}

function fillSelect(sel, first, values, current) {
  sel.replaceChildren(h("option", { value: "", text: first }));
  for (const [v, label] of values) sel.append(h("option", { value: v, text: label }));
  sel.value = current;
  if (sel.value !== current) sel.value = "";
  sel.classList.toggle("on", !!sel.value);
  return sel.value;
}

function renderFilters() {
  const ws = currentWs(); const list = ws ? tasksIn(ws.id) : [];
  S.project = fillSelect($("fproject"), "Todos os projetos", uniq(list.map((t) => t.project)).map((p) => [p, p]), S.project);
  $("fclient").hidden = !isWork(ws);
  S.client = fillSelect($("fclient"), "Todos os clientes", uniq(list.map((t) => t.client)).map((c) => [c, c]), S.client);
  const people = ws ? membersOf(ws.id).map((m) => m.user_id).filter((id) => id !== S.uid) : [];
  S.assignee = fillSelect($("fassignee"), "Todos os responsáveis",
    [["me", "Minhas tarefas"], ...people.map((id) => [id, nameOf(id)]), ["none", "Sem responsável"]], S.assignee);
  $("fdue").hidden = S.status !== "open"; $("fdue").value = S.due; $("fdue").classList.toggle("on", !!S.due);
  $("fprio").value = S.prio; $("fprio").classList.toggle("on", !!S.prio);
  $("fview").value = S.view;
  [...$("fview").options].forEach((o) => { if (o.value === "client") o.hidden = !isWork(ws); });
  if (S.view === "client" && !isWork(ws)) { S.view = "date"; $("fview").value = "date"; }
  $("fsort").textContent = S.sort === "asc" ? "Data ↑ mais antiga" : "Data ↓ mais recente";
  $("st-open").setAttribute("aria-pressed", String(S.status === "open"));
  $("st-done").setAttribute("aria-pressed", String(S.status === "done"));
  $("wsedit").hidden = !ws;
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function taskCard(t, ws) {
  const t0 = today();
  const late = !t.done && t.due_date && t.due_date < t0;
  const dateCls = "tag" + (late ? " late" : !t.done && t.due_date === t0 ? " today" : "");
  const as = assigneesOf(t.id);
  const check = h("button", { type: "button", class: "check", "aria-label": t.done ? "Reabrir tarefa" : "Concluir tarefa", onclick: () => toggleDone(t) });
  check.innerHTML = CHECK_SVG;
  return h("div", { class: "task" + (t.done ? " done" : "") + (late ? " is-late" : "") }, [
    check,
    h("button", { type: "button", class: "body", onclick: () => openTask(t) }, [
      h("span", { class: "title", text: t.title }),
      t.description ? h("span", { class: "desc", text: t.description }) : null,
      h("div", { class: "meta" }, [
        t.priority && t.priority <= 2 ? h("span", { class: `tag p${t.priority}`, text: PRIO[t.priority] }) : null,
        t.priority > 2 ? h("span", { class: "tag", text: PRIO[t.priority] }) : null,
        t.due_date ? h("span", { class: dateCls, text: fmtDate(t.due_date) }) : null,
        t.project ? h("span", { class: "tag", text: t.project }) : null,
        isWork(ws) && t.client ? h("span", { class: "tag client", text: t.client }) : null,
        t.notes ? h("span", { class: "tag note", text: "Observações" }) : null,
        t.done && t.done_at ? h("span", { class: "tag", text: "Concluída " + fmtDate(ymd(new Date(t.done_at))).toLowerCase() }) : null,
        as.length ? h("span", { class: "avs" }, [...as.slice(0, 3).map(avatar), h("span", { text: as.map((id) => nameOf(id, true)).join(", ") })]) : null
      ])
    ])
  ]);
}

function section(label, items, ws, cls) {
  if (!items.length) return null;
  return h("section", { class: cls || "" }, [
    h("h2", {}, [label, h("span", { text: "· " + items.length })]),
    h("div", { class: "list" }, items.map((t) => taskCard(t, ws)))
  ]);
}

function render() {
  if (!S.loaded) return;
  renderMe();
  const main = $("main"); main.replaceChildren();
  if (!S.workspaces.length) {
    renderChips(); renderFilters(); $("fab").hidden = true;
    main.append(h("div", { class: "notice" }, [
      h("strong", { text: "Você ainda não participa de nenhum ambiente." }),
      h("span", { text: "Crie um ambiente, ou peça para alguém te convidar pelo seu email do Google." }),
      h("button", { type: "button", class: "btn", text: "Criar ambiente", onclick: () => openWs(null) })
    ]));
    return;
  }
  if (!currentWs()) S.ws = S.workspaces[0].id;
  const ws = currentWs();
  renderChips(); renderFilters(); $("fab").hidden = false;

  const q = S.q.trim().toLowerCase(); const t0 = today(); const wk = addDays(7);
  const all = tasksIn(ws.id);
  const list = all.filter((t) => {
    if (S.status === "open" ? t.done : !t.done) return false;
    if (S.project && t.project.trim().toLowerCase() !== S.project.toLowerCase()) return false;
    if (isWork(ws) && S.client && t.client.trim().toLowerCase() !== S.client.toLowerCase()) return false;
    const as = assigneesOf(t.id);
    if (S.assignee === "me" && !as.includes(S.uid)) return false;
    if (S.assignee === "none" && as.length) return false;
    if (S.assignee && !["me", "none"].includes(S.assignee) && !as.includes(S.assignee)) return false;
    if (S.prio === "0" ? t.priority : S.prio && String(t.priority) !== S.prio) return false;
    if (S.status === "open" && S.due) {
      const d = t.due_date || "";
      if (S.due === "late" && !(d && d < t0)) return false;
      if (S.due === "today" && d !== t0) return false;
      if (S.due === "lateToday" && !(d && d <= t0)) return false;
      if (S.due === "week" && !(d && d > t0 && d <= wk)) return false;
      if (S.due === "none" && d) return false;
    }
    if (q && ![t.title, t.description, t.notes, t.project, t.client].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });

  if (S.status === "open") {
    const openAll = all.filter((t) => !t.done);
    const lateN = openAll.filter((t) => t.due_date && t.due_date < t0).length;
    const todayN = openAll.filter((t) => t.due_date === t0).length;
    main.append(h("div", { class: "summary" }, [
      h("span", { class: "pill", text: `${openAll.length} ${openAll.length === 1 ? "aberta" : "abertas"}` }),
      lateN ? h("button", { type: "button", class: "pill late", "aria-pressed": String(S.due === "late"), text: `${lateN} ${lateN === 1 ? "atrasada" : "atrasadas"}`, onclick: () => { S.due = S.due === "late" ? "" : "late"; render(); } }) : null,
      todayN ? h("button", { type: "button", class: "pill today", "aria-pressed": String(S.due === "today"), text: `${todayN} para hoje`, onclick: () => { S.due = S.due === "today" ? "" : "today"; render(); } }) : null,
      S.due ? h("button", { type: "button", class: "pill", text: "Limpar prazo ✕", onclick: () => { S.due = ""; render(); } }) : null
    ]));
  }

  const key = S.status === "open" ? "due_date" : "done_at";
  const dir = S.sort === "desc" ? -1 : 1;
  list.sort((a, b) => {
    const x = a[key] || "", y = b[key] || "";
    if (!x !== !y) return x ? -1 : 1;
    return dir * x.localeCompare(y) || (a.priority || 9) - (b.priority || 9) || a.title.localeCompare(b.title, "pt-BR");
  });

  const groups = [];
  const lateCls = (items) => (S.status === "open" && items.some((t) => t.due_date && t.due_date < t0) ? "late" : "");
  const byField = (field, emptyLabel) => {
    const m = new Map();
    for (const t of list) { const k = (t[field] || "").trim() || emptyLabel; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    [...m.keys()].sort((a, b) => (a === emptyLabel) - (b === emptyLabel) || a.localeCompare(b, "pt-BR"))
      .forEach((k) => groups.push(section(k, m.get(k), ws, lateCls(m.get(k)))));
  };
  if (S.view === "project") byField("project", "Sem projeto");
  else if (S.view === "client") byField("client", "Sem cliente");
  else if (S.view === "priority") {
    for (const p of [1, 2, 3, 4, 0]) {
      const items = list.filter((t) => (t.priority || 0) === p);
      groups.push(section(p ? PRIO[p] : "Sem prioridade", items, ws, lateCls(items)));
    }
  } else if (S.status === "open") {
    const dated = [
      section("Atrasadas", list.filter((t) => t.due_date && t.due_date < t0), ws, "late"),
      section("Hoje", list.filter((t) => t.due_date === t0), ws),
      section("Próximos 7 dias", list.filter((t) => t.due_date && t.due_date > t0 && t.due_date <= wk), ws),
      section("Mais adiante", list.filter((t) => t.due_date && t.due_date > wk), ws)
    ];
    if (dir < 0) dated.reverse();
    groups.push(...dated, section("Sem data", list.filter((t) => !t.due_date), ws));
  } else groups.push(section("Concluídas", list, ws));
  groups.forEach((g) => g && main.append(g));

  if (!list.length) {
    const filtered = q || S.project || S.client || S.assignee || S.prio || (S.status === "open" && S.due);
    main.append(h("div", { class: "empty", text: filtered ? "Nenhuma tarefa com esses filtros." :
      S.status === "open" ? `Nada pendente em ${ws.name}. Toque em + para criar uma tarefa.` : "Nenhuma tarefa concluída ainda." }));
  }
}

/* ================= Tarefa ================= */
function fillWsSelect(sel) {
  $("f-ws").replaceChildren(...S.workspaces.map((w) => h("option", { value: w.id, text: w.name })));
  $("f-ws").value = sel;
}
function renderPicker() {
  const wsId = $("f-ws").value;
  const ids = membersOf(wsId).map((m) => m.user_id);
  S.pick = S.pick.filter((id) => ids.includes(id));
  $("f-assignees").replaceChildren(...ids.map((id) => {
    const on = S.pick.includes(id);
    return h("button", { type: "button", class: "person", "aria-pressed": String(on), onclick: () => {
      S.pick = on ? S.pick.filter((x) => x !== id) : [...S.pick, id]; renderPicker();
    } }, [avatar(id), h("span", { text: nameOf(id, true) })]);
  }));
}
function syncTaskForm() {
  const ws = S.workspaces.find((w) => w.id === $("f-ws").value);
  $("clientwrap").hidden = !isWork(ws);
  const list = tasksIn($("f-ws").value);
  $("dl-project").replaceChildren(...uniq(list.map((t) => t.project)).map((v) => h("option", { value: v })));
  $("dl-client").replaceChildren(...uniq(S.tasks.map((t) => t.client)).map((v) => h("option", { value: v })));
  renderPicker();
}
function openTask(t) {
  S.editing = t || null;
  $("tf-title").textContent = t ? "Editar tarefa" : "Nova tarefa";
  $("f-title").value = t ? t.title : "";
  $("f-desc").value = t ? t.description : "";
  $("f-due").value = t ? t.due_date || "" : "";
  $("f-prio").value = t && t.priority ? String(t.priority) : "";
  $("f-project").value = t ? t.project : S.project;
  $("f-client").value = t ? t.client : S.client;
  $("f-notes").value = t ? t.notes : "";
  $("f-done").checked = !!(t && t.done);
  $("donewrap").hidden = !t;
  S.pick = t ? [...assigneesOf(t.id)] : (S.assignee && !["me", "none"].includes(S.assignee) ? [S.assignee] : [S.uid]);
  fillWsSelect(t ? t.workspace_id : S.ws);
  syncTaskForm();
  const parts = [];
  if (t) {
    parts.push(`Criada por ${nameOf(t.created_by)} em ${fmtStamp(t.created_at)}`);
    if (t.updated_by && t.updated_at !== t.created_at) parts.push(`Editada por ${nameOf(t.updated_by)} em ${fmtStamp(t.updated_at)}`);
    if (t.done && t.done_at) parts.push(`Concluída em ${fmtStamp(t.done_at)}`);
  }
  $("f-stamp").textContent = parts.join(". ");
  $("f-del").hidden = !t; $("f-del").classList.remove("armed"); $("f-del").textContent = "Excluir";
  $("ov-task").hidden = false;
  if (!t) setTimeout(() => $("f-title").focus(), 60);
}
const closeTask = () => { $("ov-task").hidden = true; S.editing = null; };

$("taskform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const title = $("f-title").value.trim(); if (!title) return;
  const wsId = $("f-ws").value; const ws = S.workspaces.find((w) => w.id === wsId);
  const row = {
    workspace_id: wsId, title,
    description: $("f-desc").value.trim(),
    notes: $("f-notes").value.replace(/\s+$/, ""),
    due_date: $("f-due").value || null,
    priority: $("f-prio").value ? Number($("f-prio").value) : null,
    project: $("f-project").value.trim(),
    client: isWork(ws) ? $("f-client").value.trim() : "",
    done: S.editing ? $("f-done").checked : false
  };
  const btn = $("f-save"); btn.disabled = true;
  try {
    let id;
    if (S.editing) {
      id = S.editing.id;
      const { error } = await sb.from("tasks").update(row).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from("tasks").insert(row).select("id").single();
      if (error) throw error;
      id = data.id;
    }
    const before = S.editing ? assigneesOf(id) : [];
    const add = S.pick.filter((u) => !before.includes(u));
    const del = before.filter((u) => !S.pick.includes(u));
    if (del.length) { const { error } = await sb.from("task_assignees").delete().eq("task_id", id).in("user_id", del); if (error) throw error; }
    if (add.length) { const { error } = await sb.from("task_assignees").insert(add.map((user_id) => ({ task_id: id, user_id }))); if (error) throw error; }
    closeTask();
    if (wsId !== S.ws) { S.ws = wsId; store("t.ws", wsId); }
    await loadAll();
  } catch (e) { fail(e); } finally { btn.disabled = false; }
});
$("f-cancel").addEventListener("click", closeTask);
$("f-ws").addEventListener("change", syncTaskForm);
$("f-del").addEventListener("click", async () => {
  const b = $("f-del");
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmar exclusão"; return; }
  const { error } = await sb.from("tasks").delete().eq("id", S.editing.id);
  if (error) return fail(error);
  closeTask(); toast("Tarefa excluída."); loadAll();
});

const toggling = new Set();
async function toggleDone(t) {
  if (toggling.has(t.id)) return; toggling.add(t.id);
  t.done = !t.done; t.done_at = t.done ? new Date().toISOString() : null; render();
  const { error } = await sb.from("tasks").update({ done: t.done }).eq("id", t.id);
  toggling.delete(t.id);
  if (error) { t.done = !t.done; render(); return fail(error); }
  if (t.done) toast(`Concluída: ${t.title}`);
}

/* ================= Ambientes ================= */
let pendingInvites = [];
async function loadInvites(wsId) {
  pendingInvites = [];
  if (!isOwner(wsId)) return;
  const { data } = await sb.from("workspace_invites").select("email,role").eq("workspace_id", wsId);
  pendingInvites = data || [];
}
function renderMembers() {
  const w = S.editingWs; const box = $("w-members"); box.replaceChildren();
  if (!w) return;
  const owner = isOwner(w.id);
  for (const m of membersOf(w.id)) {
    const p = S.profiles.get(m.user_id) || {};
    const roleCtl = owner && m.user_id !== S.uid
      ? h("select", { "aria-label": "Papel", onchange: async (e) => {
          const { error } = await sb.from("workspace_members").update({ role: e.target.value }).eq("workspace_id", w.id).eq("user_id", m.user_id);
          if (error) fail(error); else loadAll();
        } }, [h("option", { value: "member", text: "Membro" }), h("option", { value: "owner", text: "Dono" })])
      : h("small", { text: m.role === "owner" ? "Dono" : "Membro" });
    if (roleCtl.tagName === "SELECT") roleCtl.value = m.role;
    const removeLabel = m.user_id === S.uid ? "Sair" : owner ? "Remover" : null;
    box.append(h("div", { class: "member" }, [
      avatar(m.user_id),
      h("div", { class: "who" }, [h("span", { text: nameOf(m.user_id) }), h("small", { text: p.email || "" })]),
      roleCtl,
      removeLabel ? h("button", { type: "button", text: removeLabel, onclick: async () => {
        const { error } = await sb.from("workspace_members").delete().eq("workspace_id", w.id).eq("user_id", m.user_id);
        if (error) return fail(error);
        if (m.user_id === S.uid) closeWs();
        loadAll();
      } }) : null
    ]));
  }
  for (const i of pendingInvites) {
    box.append(h("div", { class: "member" }, [
      avatar(null),
      h("div", { class: "who" }, [h("span", { text: i.email }), h("small", { text: "Convite pendente. Entra ao fazer o primeiro login." })]),
      h("button", { type: "button", text: "Cancelar", onclick: async () => {
        const { error } = await sb.from("workspace_invites").delete().eq("workspace_id", w.id).eq("email", i.email);
        if (error) return fail(error);
        await loadInvites(w.id); renderMembers();
      } })
    ]));
  }
  $("w-invite").parentElement.hidden = !owner;
  $("w-hint").textContent = owner ? "Use o email da conta Google da pessoa." : "Só o dono do ambiente adiciona ou remove pessoas.";
}
async function openWs(w) {
  S.editingWs = w || null;
  const owner = w ? isOwner(w.id) : true;
  $("wf-title").textContent = w ? (owner ? "Editar ambiente" : w.name) : "Novo ambiente";
  $("w-name").value = w ? w.name : "";
  $("w-pessoal").checked = !w || w.kind === "pessoal"; $("w-trabalho").checked = !!w && w.kind === "trabalho";
  for (const id of ["w-name", "w-pessoal", "w-trabalho"]) $(id).disabled = !owner;
  $("w-save").hidden = !owner;
  $("w-members-wrap").hidden = !w;
  $("w-del").hidden = !w || !owner; $("w-del").classList.remove("armed"); $("w-del").textContent = "Excluir ambiente";
  $("w-invite").value = "";
  $("ov-ws").hidden = false;
  if (w) { await loadInvites(w.id); renderMembers(); } else setTimeout(() => $("w-name").focus(), 60);
}
const closeWs = () => { $("ov-ws").hidden = true; S.editingWs = null; };
$("wsedit").addEventListener("click", () => { const w = currentWs(); if (w) openWs(w); });
$("w-cancel").addEventListener("click", closeWs);
$("wsform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("w-name").value.trim(); if (!name) return;
  const kind = $("w-trabalho").checked ? "trabalho" : "pessoal";
  const btn = $("w-save"); btn.disabled = true;
  try {
    if (S.editingWs) {
      const { error } = await sb.from("workspaces").update({ name, kind }).eq("id", S.editingWs.id);
      if (error) throw error;
      closeWs();
    } else {
      const order = S.workspaces.reduce((m, w) => Math.max(m, w.sort_order), 0) + 1;
      const { data, error } = await sb.from("workspaces").insert({ name, kind, sort_order: order, created_by: S.uid }).select("*").single();
      if (error) throw error;
      S.ws = data.id; store("t.ws", data.id);
      await loadAll();
      openWs(S.workspaces.find((w) => w.id === data.id) || null);
      toast("Ambiente criado. Convide quem vai participar.");
      return;
    }
    loadAll();
  } catch (e) { fail(e); } finally { btn.disabled = false; }
});
$("w-invite-btn").addEventListener("click", async () => {
  const email = $("w-invite").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Digite um email válido."); return; }
  const { data, error } = await sb.rpc("invite_member", { ws: S.editingWs.id, invite_email: email });
  if (error) return fail(error, "Não consegui convidar.");
  $("w-invite").value = "";
  toast(data === "member" ? "Pessoa adicionada ao ambiente." : "Convite salvo. A pessoa entra no ambiente quando fizer login.");
  await loadInvites(S.editingWs.id); await loadAll();
});
$("w-del").addEventListener("click", async () => {
  const b = $("w-del"); const w = S.editingWs;
  const n = tasksIn(w.id).length;
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = n ? `Excluir com ${n} tarefas?` : "Confirmar exclusão"; return; }
  const { error } = await sb.from("workspaces").delete().eq("id", w.id);
  if (error) return fail(error);
  closeWs(); S.ws = null; toast("Ambiente excluído."); loadAll();
});

/* ================= Perfil ================= */
$("btn-me").addEventListener("click", () => {
  $("p-name").value = (S.me && S.me.display_name) || "";
  $("p-email").textContent = S.me ? `Conectado como ${S.me.email}` : "";
  $("ov-me").hidden = false;
});
$("p-cancel").addEventListener("click", () => ($("ov-me").hidden = true));
$("meform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { error } = await sb.from("profiles").update({ display_name: $("p-name").value.trim() }).eq("id", S.uid);
  if (error) return fail(error);
  $("ov-me").hidden = true; loadAll();
});
$("p-logout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

/* ================= Filtros e atalhos ================= */
$("st-open").addEventListener("click", () => { S.status = "open"; render(); });
$("st-done").addEventListener("click", () => { S.status = "done"; render(); });
let qt; $("q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; render(); }, 120); });
$("fproject").addEventListener("change", (e) => { S.project = e.target.value; render(); });
$("fclient").addEventListener("change", (e) => { S.client = e.target.value; render(); });
$("fassignee").addEventListener("change", (e) => { S.assignee = e.target.value; render(); });
$("fdue").addEventListener("change", (e) => { S.due = e.target.value; render(); });
$("fprio").addEventListener("change", (e) => { S.prio = e.target.value; render(); });
$("fview").addEventListener("change", (e) => { S.view = e.target.value; store("t.view", S.view); render(); });
$("fsort").addEventListener("click", () => { S.sort = S.sort === "asc" ? "desc" : "asc"; store("t.sort", S.sort); render(); });
$("fab").addEventListener("click", () => openTask(null));
for (const [ov, close] of [["ov-task", closeTask], ["ov-ws", closeWs], ["ov-me", () => ($("ov-me").hidden = true)]]) {
  $(ov).addEventListener("click", (e) => { if (e.target === $(ov)) close(); });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("ov-task").hidden) closeTask(); else if (!$("ov-ws").hidden) closeWs(); else $("ov-me").hidden = true;
});

/* ================= Login ================= */
$("btn-google").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } }
  });
  if (error) $("login-msg").textContent = "Não consegui abrir o login do Google: " + error.message;
});

function showLogin() {
  S.session = null;
  $("app").hidden = true; $("fab").hidden = true; $("login").hidden = false;
  const params = new URLSearchParams(location.search + "&" + location.hash.slice(1));
  const err = params.get("error_description") || params.get("error");
  if (err) $("login-msg").textContent = "O login não foi concluído: " + err.replace(/\+/g, " ");
}
async function showApp(session) {
  if (S.session && S.uid === session.user.id) return;
  S.session = session; S.uid = session.user.id;
  $("login").hidden = true; $("app").hidden = false;
  if (!S.loaded) $("main").replaceChildren(h("div", { class: "notice" }, [h("strong", { text: "Carregando suas tarefas…" })]));
  await loadAll(); subscribe();
}

sb.auth.onAuthStateChange((event, session) => {
  if (session && (!S.uid || S.uid !== session.user.id)) showApp(session);
  else if (!session) { S.uid = null; showLogin(); }
});
const { data: { session } } = await sb.auth.getSession();
if (session) showApp(session); else showLogin();
