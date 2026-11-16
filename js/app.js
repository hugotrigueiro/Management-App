import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { buildState as buildFinance, buildFIN } from "./finance.js?v=18";

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
  editing: null, pick: [], editingWs: null,
  selecting: false, sel: new Set(), visibleIds: [], bulkPick: [],
  checklist: new Map(), draft: [], repDays: [], toggled: new Set(), armed: null, rules: [], sources: [], ai: new Map(), aiBusy: false,
  mod: store("t.mod") || "tasks", finSources: [], fin: { state: null, ui: {}, loading: false, at: null, error: null }
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

function repeatLabel(t) {
  if (!t.repeat_freq) return "";
  const n = t.repeat_interval || 1;
  if (t.repeat_freq === "daily") return n === 1 ? "Todo dia" : `A cada ${n} dias`;
  if (t.repeat_freq === "weekly") {
    const base = n === 1 ? "Toda semana" : `A cada ${n} semanas`;
    const days = [...(t.repeat_weekdays || [])].sort((a, b) => a - b).map((d) => WD[d]);
    return days.length ? `${base} (${days.join(", ")})` : base;
  }
  const base = n === 1 ? "Todo mês" : `A cada ${n} meses`;
  return t.repeat_monthday ? `${base}, dia ${t.repeat_monthday}` : base;
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
  const pr = S.profiles.get(id);
  const n = (pr && (pr.display_name || pr.email)) || "?";
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
      const [profiles, workspaces, members, tasks, assignees, items, rules, sources, finSources] = await Promise.all([
        fetchAll("profiles", "id,email,display_name,avatar_url,telegram_chat_id"),
        fetchAll("workspaces", "*", "sort_order"),
        fetchAll("workspace_members", "workspace_id,user_id,role"),
        fetchAll("tasks", "*", "id"),
        fetchAll("task_assignees", "task_id,user_id"),
        fetchAll("task_checklist_items", "id,task_id,text,done,position", "position"),
        fetchAll("notification_rules", "*", "created_at"),
        fetchAll("sheet_sources", "*"),
        fetchAll("finance_sources", "workspace_id,title")
      ]);
      S.rules = rules; S.sources = sources; S.finSources = finSources;
      const cl = new Map();
      for (const it of items) { if (!cl.has(it.task_id)) cl.set(it.task_id, []); cl.get(it.task_id).push(it); }
      S.checklist = cl;
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
      applyMod();
      if (!$("ov-ws").hidden && S.editingWs) renderMembers();
      if (!$("ov-notif").hidden) renderNotif();
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
  for (const table of ["tasks", "task_assignees", "task_checklist_items", "workspaces", "workspace_members", "profiles", "notification_rules", "sheet_sources", "finance_sources"]) {
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

// Uma tarefa passa nos filtros atuais? "except" ignora um filtro (usado para montar as opções desse filtro).
function matches(t, ws, except) {
  const t0 = today(), wk = addDays(7), q = S.q.trim().toLowerCase();
  if (S.status === "open" ? t.done : !t.done) return false;
  if (except !== "project" && S.project && t.project.trim().toLowerCase() !== S.project.toLowerCase()) return false;
  if (except !== "client" && isWork(ws) && S.client && t.client.trim().toLowerCase() !== S.client.toLowerCase()) return false;
  if (except !== "assignee" && S.assignee) {
    const as = assigneesOf(t.id);
    if (S.assignee === "me" && !as.includes(S.uid)) return false;
    if (S.assignee === "none" && as.length) return false;
    if (!["me", "none"].includes(S.assignee) && !as.includes(S.assignee)) return false;
  }
  if (except !== "prio" && (S.prio === "0" ? t.priority : S.prio && String(t.priority) !== S.prio)) return false;
  if (except !== "due" && S.status === "open" && S.due) {
    const d = t.due_date || "";
    if (S.due === "late" && !(d && d < t0)) return false;
    if (S.due === "today" && d !== t0) return false;
    if (S.due === "tomorrow" && d !== addDays(1)) return false;
    if (S.due === "lateToday" && !(d && d <= t0)) return false;
    if (S.due === "week" && !(d && d > t0 && d <= wk)) return false;
    if (S.due === "none" && d) return false;
  }
  if (q && ![t.title, t.description, t.notes, t.project, t.client].join(" ").toLowerCase().includes(q)) return false;
  return true;
}
// Opções com contagem, só do que existe nas tarefas que passam pelos outros filtros.
function countBy(tasks, keyFn) {
  const m = new Map();
  for (const t of tasks) for (const raw of [].concat(keyFn(t))) {
    const v = (raw || "").trim(); if (!v) continue;
    const k = v.toLowerCase();
    if (!m.has(k)) m.set(k, { label: v, n: 0 }); m.get(k).n++;
  }
  return m;
}
function optionsWithCount(m, current) {
  const cur = (current || "").toLowerCase();
  const out = [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, "pt-BR"))
    .map(([k, o]) => [k === cur ? current : o.label, `${o.label} (${o.n})`]);
  if (current && !m.has(current.toLowerCase())) out.unshift([current, `${current} (0)`]);
  return out;
}

function renderFilters() {
  const ws = currentWs(); const all = ws ? tasksIn(ws.id) : [];
  const pool = (except) => all.filter((t) => matches(t, ws, except));
  S.project = fillSelect($("fproject"), "Todos os projetos", optionsWithCount(countBy(pool("project"), (t) => t.project), S.project), S.project);
  $("fclient").hidden = !isWork(ws);
  S.client = fillSelect($("fclient"), "Todos os clientes", optionsWithCount(countBy(pool("client"), (t) => t.client), S.client), S.client);
  const ap = pool("assignee");
  const byPerson = new Map(); let none = 0;
  for (const t of ap) { const as = assigneesOf(t.id); if (!as.length) none++; for (const id of as) byPerson.set(id, (byPerson.get(id) || 0) + 1); }
  const people = [...byPerson.keys()].filter((id) => id !== S.uid).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "pt-BR"));
  const aOpts = [];
  if (byPerson.has(S.uid) || S.assignee === "me") aOpts.push(["me", `Minhas tarefas (${byPerson.get(S.uid) || 0})`]);
  for (const id of people) aOpts.push([id, `${nameOf(id)} (${byPerson.get(id)})`]);
  if (S.assignee && !["me", "none"].includes(S.assignee) && !byPerson.has(S.assignee)) aOpts.push([S.assignee, `${nameOf(S.assignee)} (0)`]);
  if (none || S.assignee === "none") aOpts.push(["none", `Sem responsável (${none})`]);
  S.assignee = fillSelect($("fassignee"), "Todos os responsáveis", aOpts, S.assignee);
  $("fdue").hidden = S.status !== "open"; $("fdue").value = S.due; $("fdue").classList.toggle("on", !!S.due);
  $("fprio").value = S.prio; $("fprio").classList.toggle("on", !!S.prio);
  $("fview").value = S.view;
  [...$("fview").options].forEach((o) => { if (o.value === "client") o.hidden = !isWork(ws); });
  if (S.view === "client" && !isWork(ws)) { S.view = "date"; $("fview").value = "date"; }
  $("fsort").textContent = S.sort === "asc" ? "Data ↑ mais antiga" : "Data ↓ mais recente";
  $("st-open").setAttribute("aria-pressed", String(S.status === "open"));
  $("st-done").setAttribute("aria-pressed", String(S.status === "done"));
  $("wsedit").hidden = !ws;
  $("btn-ai").hidden = !ws;
  $("btn-sync").hidden = !(ws && S.sources.some((x) => x.workspace_id === ws.id && x.enabled));
  const active = [S.project, S.client, S.assignee, S.status === "open" ? S.due : "", S.prio].filter(Boolean).length;
  $("filters-count").hidden = !active; $("filters-count").textContent = String(active);
  $("fclear").hidden = !active;
  $("qa-title").placeholder = ws ? `Adicionar tarefa em ${ws.name} e apertar Enter` : "Adicionar tarefa";
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function taskCard(t, ws) {
  const t0 = today();
  const late = !t.done && t.due_date && t.due_date < t0;
  const dateCls = "tag" + (late ? " late" : !t.done && t.due_date === t0 ? " today" : "");
  const as = assigneesOf(t.id);
  const sel = S.selecting && S.sel.has(t.id);
  const check = h("button", { type: "button", class: "check",
    "aria-label": S.selecting ? (sel ? "Desmarcar" : "Selecionar") : t.done ? "Reabrir tarefa" : "Concluir tarefa",
    onclick: () => (S.selecting ? toggleSel(t.id) : toggleDone(t)) });
  check.innerHTML = CHECK_SVG;
  return h("div", { class: "task" + (t.done ? " done" : "") + (late ? " is-late" : "") + (S.selecting ? " selecting" : "") + (sel ? " selected" : "") + (S.armed === t.id ? " armed" : "") }, [
    check,
    h("button", { type: "button", class: "body", onclick: () => (S.selecting ? toggleSel(t.id) : openTask(t)) }, [
      h("span", { class: "title", text: t.title }),
      t.description ? h("span", { class: "desc", text: t.description }) : null,
      h("div", { class: "meta" }, [
        t.priority && t.priority <= 2 ? h("span", { class: `tag p${t.priority}`, text: PRIO[t.priority] }) : null,
        t.priority > 2 ? h("span", { class: "tag", text: PRIO[t.priority] }) : null,
        t.due_date ? h("span", { class: dateCls, text: fmtDate(t.due_date) }) : null,
        t.project ? h("span", { class: "tag", text: t.project }) : null,
        isWork(ws) && t.client ? h("span", { class: "tag client", text: t.client }) : null,
        t.repeat_freq ? h("span", { class: "tag", title: "Tarefa recorrente", text: "↻ " + repeatLabel(t) }) : null,
        (() => { const it = S.checklist.get(t.id) || []; if (!it.length) return null; const d = it.filter((x) => x.done).length;
          return h("span", { class: "tag prog" + (d === it.length ? " complete" : ""), role: "button", tabindex: "0",
            title: subsOpen(t) ? "Esconder subtarefas" : "Mostrar subtarefas", text: `☑ ${d}/${it.length} ${subsOpen(t) ? "▴" : "▾"}`,
            onclick: (e) => { e.stopPropagation(); S.toggled.has(t.id) ? S.toggled.delete(t.id) : S.toggled.add(t.id); render(); } }); })(),
        t.notes ? h("span", { class: "tag note", text: "Observações" }) : null,
        t.done && t.done_at ? h("span", { class: "tag", text: "Concluída " + fmtDate(ymd(new Date(t.done_at))).toLowerCase() }) : null,
        as.length ? h("span", { class: "avs" }, [...as.slice(0, 3).map(avatar), h("span", { text: as.map((id) => nameOf(id, true)).join(", ") })]) : null
      ])
    ]),
    subsOpen(t) ? h("div", { class: "subs" }, (S.checklist.get(t.id) || []).map((it) => {
      const cb = h("input", { type: "checkbox", "aria-label": it.text }); cb.checked = it.done;
      cb.addEventListener("change", () => toggleSub(it, cb.checked));
      return h("label", { class: "sub" + (it.done ? " done" : "") }, [cb, h("span", { text: it.text })]);
    })) : null
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
  renderChips(); renderFilters(); $("fab").hidden = S.selecting;

  const q = S.q.trim().toLowerCase(); const t0 = today(); const wk = addDays(7);
  const all = tasksIn(ws.id);
  const list = all.filter((t) => matches(t, ws));

  if (S.status === "open") {
    const openAll = all.filter((t) => !t.done);
    const lateN = openAll.filter((t) => t.due_date && t.due_date < t0).length;
    const todayN = openAll.filter((t) => t.due_date === t0).length;
    main.append(h("div", { class: "summary" }, [
      h("span", { class: "pill", text: `${openAll.length} ${openAll.length === 1 ? "aberta" : "abertas"}` }),
      lateN ? h("button", { type: "button", class: "pill late", "aria-pressed": String(S.due === "late"), text: `${lateN} ${lateN === 1 ? "atrasada" : "atrasadas"}`, onclick: () => { S.due = S.due === "late" ? "" : "late"; render(); } }) : null,
      todayN ? h("button", { type: "button", class: "pill today", "aria-pressed": String(S.due === "today"), text: `${todayN} para hoje`, onclick: () => { S.due = S.due === "today" ? "" : "today"; render(); } }) : null,
      S.due ? h("button", { type: "button", class: "pill", text: "Limpar prazo ✕", onclick: () => { S.due = ""; render(); } }) : null,
      syncInfo(ws)
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
  S.visibleIds = list.map((t) => t.id);
  renderBulkbar();

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
  $("f-repeat").value = (t && t.repeat_freq) || "";
  $("f-rep-int").value = (t && t.repeat_interval) || 1;
  $("f-rep-mday").value = (t && t.repeat_monthday) || "";
  $("f-rep-until").value = (t && t.repeat_until) || "";
  S.repDays = t && t.repeat_weekdays ? [...t.repeat_weekdays] : [];
  syncRepeat();
  S.draft = t ? (S.checklist.get(t.id) || []).map((x) => ({ ...x })) : [];
  $("f-check-add").value = "";
  renderChecklist();
  const adv = !!(t && (t.description || t.notes));
  $("f-advanced").hidden = !adv; $("f-more").setAttribute("aria-expanded", String(adv));
  $("f-more").textContent = adv ? "Menos opções" : "Mais opções";
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

/* ---- Recorrência no formulário ---- */
function baseDate() { const v = $("f-due").value; if (!v) return new Date(); const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d); }
function syncRepeat() {
  const f = $("f-repeat").value;
  $("f-repeat-opts").hidden = !f;
  if (!f) return;
  const n = Math.max(1, Number($("f-rep-int").value) || 1);
  $("f-rep-unit").textContent = f === "daily" ? (n === 1 ? "dia" : "dias") : f === "weekly" ? (n === 1 ? "semana" : "semanas") : (n === 1 ? "mês" : "meses");
  $("f-rep-days").hidden = f !== "weekly";
  $("f-rep-mday-wrap").hidden = f !== "monthly";
  if (f === "weekly" && !S.repDays.length) S.repDays = [baseDate().getDay()];
  if (f === "monthly" && !$("f-rep-mday").value) $("f-rep-mday").value = baseDate().getDate();
  $("f-rep-days").replaceChildren(...["D", "S", "T", "Q", "Q", "S", "S"].map((l, i) => h("button", {
    type: "button", "aria-pressed": String(S.repDays.includes(i)), "aria-label": WD[i], text: l,
    onclick: () => { S.repDays = S.repDays.includes(i) ? S.repDays.filter((x) => x !== i) : [...S.repDays, i]; if (!S.repDays.length) S.repDays = [i]; syncRepeat(); }
  })));
  $("f-rep-hint").textContent = "Ao concluir, a próxima ocorrência é criada sozinha, com o checklist zerado e os mesmos responsáveis.";
}
function repeatFields() {
  const f = $("f-repeat").value;
  if (!f) return { repeat_freq: null, repeat_interval: 1, repeat_weekdays: [], repeat_monthday: null, repeat_until: null };
  const md = Number($("f-rep-mday").value);
  return {
    repeat_freq: f,
    repeat_interval: Math.min(365, Math.max(1, Number($("f-rep-int").value) || 1)),
    repeat_weekdays: f === "weekly" ? [...S.repDays].sort((a, b) => a - b) : [],
    repeat_monthday: f === "monthly" && md >= 1 && md <= 31 ? md : null,
    repeat_until: $("f-rep-until").value || null
  };
}
$("f-repeat").addEventListener("change", syncRepeat);
$("f-rep-int").addEventListener("input", syncRepeat);

/* ---- Checklist no formulário ---- */
async function clDb(op) { try { const { error } = await op; if (error) throw error; } catch (e) { fail(e); } }
function renderChecklist() {
  const box = $("f-checklist");
  const done = S.draft.filter((x) => x.done).length;
  const n = S.draft.length;
  $("f-check-count").textContent = n ? `${done} de ${n} feitas` : "nenhuma ainda";
  $("f-check-bar").hidden = !n;
  $("f-check-fill").style.width = n ? `${Math.round((done / n) * 100)}%` : "0";
  if (n) $("f-done").checked = done === n;
  box.replaceChildren(...S.draft.map((item) => {
    const cb = h("input", { type: "checkbox", "aria-label": "Item feito" }); cb.checked = item.done;
    cb.addEventListener("change", () => {
      item.done = cb.checked; renderChecklist();
      if (item.id) clDb(sb.from("task_checklist_items").update({ done: item.done }).eq("id", item.id));
    });
    const txt = h("input", { type: "text", maxlength: "300", "aria-label": "Texto do item" }); txt.value = item.text;
    txt.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); txt.blur(); } });
    txt.addEventListener("change", () => {
      const v = txt.value.trim();
      if (!v) { removeItem(item); return; }
      item.text = v;
      if (item.id) clDb(sb.from("task_checklist_items").update({ text: v }).eq("id", item.id));
    });
    return h("div", { class: "citem" + (item.done ? " done" : "") }, [cb, txt,
      h("button", { type: "button", class: "rm", "aria-label": "Remover item", text: "×", onclick: () => removeItem(item) })]);
  }));
}
function removeItem(item) {
  S.draft = S.draft.filter((x) => x !== item); renderChecklist();
  if (item.id) clDb(sb.from("task_checklist_items").delete().eq("id", item.id));
}
$("f-done").addEventListener("change", (e) => {
  if (e.target.checked && S.draft.length) { S.draft.forEach((x) => (x.done = true)); renderChecklist(); }
});
$("f-check-add-btn").addEventListener("click", addSubtask);
$("f-check-add").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSubtask(); } });
async function addSubtask() {
  const input = $("f-check-add");
  const v = input.value.trim(); if (!v) { input.focus(); return; }
  input.value = ""; input.focus();
  const item = { id: null, text: v, done: false, position: S.draft.length };
  S.draft.push(item); renderChecklist();
  if (S.editing) {
    const { data, error } = await sb.from("task_checklist_items").insert({ task_id: S.editing.id, text: v, position: item.position }).select("id").single();
    if (error) fail(error); else item.id = data.id;
  }
}

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
    done: S.editing ? $("f-done").checked : false,
    ...repeatFields()
  };
  if (row.repeat_freq && !row.due_date) row.due_date = today();
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
      if (S.draft.length) {
        const { error: e2 } = await sb.from("task_checklist_items").insert(S.draft.map((x, i) => ({ task_id: id, text: x.text, done: x.done, position: i })));
        if (e2) throw e2;
      }
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

function subsOpen(t) {
  const it = S.checklist.get(t.id) || [];
  if (!it.length || S.selecting) return false;
  const byDefault = !t.done; // abertas mostram as subtarefas; concluídas escondem
  return S.toggled.has(t.id) ? !byDefault : byDefault;
}
async function toggleSub(it, done) {
  it.done = done;
  const list = S.checklist.get(it.task_id) || [];
  const t = S.tasks.find((x) => x.id === it.task_id);
  if (t && list.length) t.done = list.every((x) => x.done);
  render();
  const { error } = await sb.from("task_checklist_items").update({ done }).eq("id", it.id);
  if (error) { fail(error); loadAll(); return; }
  if (t && t.done) toast(`Concluída: ${t.title}`);
}
let armTimer;
const toggling = new Set();
async function toggleDone(t) {
  const pending = (S.checklist.get(t.id) || []).filter((x) => !x.done).length;
  if (!t.done && pending && S.armed !== t.id) {
    S.armed = t.id; render();
    toast(`Faltam ${pending} ${pending === 1 ? "subtarefa" : "subtarefas"}. Toque de novo para concluir tudo.`);
    clearTimeout(armTimer); armTimer = setTimeout(() => { S.armed = null; render(); }, 4000);
    return;
  }
  S.armed = null;
  if (toggling.has(t.id)) return; toggling.add(t.id);
  t.done = !t.done; t.done_at = t.done ? new Date().toISOString() : null; render();
  const { error } = await sb.from("tasks").update({ done: t.done }).eq("id", t.id);
  toggling.delete(t.id);
  if (error) { t.done = !t.done; render(); return fail(error); }
  if (t.done) toast(`Concluída: ${t.title}`);
}

$("f-more").addEventListener("click", () => {
  const open = $("f-advanced").hidden;
  $("f-advanced").hidden = !open; $("f-more").setAttribute("aria-expanded", String(open));
  $("f-more").textContent = open ? "Menos opções" : "Mais opções";
});

/* ================= Adição rápida ================= */
$("quickadd").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const title = $("qa-title").value.trim(); const ws = currentWs();
  if (!title || !ws) return;
  const row = {
    workspace_id: ws.id, title,
    due_date: $("qa-due").value || (S.due === "today" ? today() : null),
    project: S.project || "", client: isWork(ws) ? S.client || "" : "",
    priority: S.prio && S.prio !== "0" ? Number(S.prio) : null
  };
  $("qa-title").disabled = true;
  try {
    const { data, error } = await sb.from("tasks").insert(row).select("id").single();
    if (error) throw error;
    const who = S.assignee && !["me", "none"].includes(S.assignee) ? S.assignee : S.assignee === "none" ? null : S.uid;
    if (who) await sb.from("task_assignees").insert({ task_id: data.id, user_id: who });
    $("qa-title").value = ""; $("qa-due").value = "";
    if (S.status !== "open") S.status = "open";
    await loadAll();
  } catch (e) { fail(e); } finally { $("qa-title").disabled = false; $("qa-title").focus(); }
});

/* ================= Seleção e edição em massa ================= */
function toggleSel(id) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); render(); }
function setSelecting(on) {
  S.selecting = on; if (!on) S.sel.clear();
  $("btn-select").setAttribute("aria-pressed", String(on));
  $("btn-select").textContent = on ? "Sair da seleção" : "Selecionar";
  render();
}
function renderBulkbar() {
  // remove da seleção o que não existe mais
  for (const id of [...S.sel]) if (!S.tasks.some((t) => t.id === id)) S.sel.delete(id);
  $("bulkbar").hidden = !S.selecting;
  const n = S.sel.size;
  $("bulk-count").textContent = `${n} ${n === 1 ? "selecionada" : "selecionadas"}`;
  const allVisible = S.visibleIds.length && S.visibleIds.every((id) => S.sel.has(id));
  $("bulk-all").textContent = allVisible ? "Desmarcar visíveis" : `Selecionar todas visíveis (${S.visibleIds.length})`;
  for (const id of ["bulk-done", "bulk-edit", "bulk-del"]) $(id).disabled = !n;
  $("bulk-del").classList.remove("armed"); $("bulk-del").textContent = "Excluir";
}
const chunks = (arr, n = 100) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function bulkUpdate(patch) {
  for (const ids of chunks([...S.sel])) {
    const { error } = await sb.from("tasks").update(patch).in("id", ids);
    if (error) throw error;
  }
}
$("btn-select").addEventListener("click", () => setSelecting(!S.selecting));
$("bulk-cancel").addEventListener("click", () => setSelecting(false));
$("bulk-all").addEventListener("click", () => {
  const allVisible = S.visibleIds.every((id) => S.sel.has(id));
  for (const id of S.visibleIds) allVisible ? S.sel.delete(id) : S.sel.add(id);
  render();
});
$("bulk-done").addEventListener("click", async () => {
  const n = S.sel.size;
  try { await bulkUpdate({ done: true }); toast(`${n} tarefas concluídas.`); setSelecting(false); await loadAll(); } catch (e) { fail(e); }
});
$("bulk-del").addEventListener("click", async () => {
  const b = $("bulk-del"); const n = S.sel.size;
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = `Excluir ${n}?`; return; }
  try {
    for (const ids of chunks([...S.sel])) { const { error } = await sb.from("tasks").delete().in("id", ids); if (error) throw error; }
    toast(`${n} tarefas excluídas.`); setSelecting(false); await loadAll();
  } catch (e) { fail(e); }
});
function renderBulkPicker() {
  const mode = $("b-as-mode").value; const box = $("b-assignees");
  box.hidden = !mode;
  const wsIds = new Set([...S.sel].map((id) => (S.tasks.find((t) => t.id === id) || {}).workspace_id));
  const target = $("b-ws").value;
  if (target) { wsIds.clear(); wsIds.add(target); }
  const people = [...new Set(S.members.filter((m) => wsIds.has(m.workspace_id)).map((m) => m.user_id))];
  S.bulkPick = S.bulkPick.filter((id) => people.includes(id));
  box.replaceChildren(...people.map((id) => {
    const on = S.bulkPick.includes(id);
    return h("button", { type: "button", class: "person", "aria-pressed": String(on), onclick: () => {
      S.bulkPick = on ? S.bulkPick.filter((x) => x !== id) : [...S.bulkPick, id]; renderBulkPicker();
    } }, [avatar(id), h("span", { text: nameOf(id, true) })]);
  }));
}
$("bulk-edit").addEventListener("click", () => {
  const n = S.sel.size;
  $("bf-title").textContent = `Editar ${n} ${n === 1 ? "tarefa" : "tarefas"}`;
  for (const id of ["b-due-mode", "b-prio", "b-done", "b-project", "b-client", "b-as-mode"]) $(id).value = "";
  $("b-due").value = ""; $("b-due-wrap").hidden = true;
  $("b-ws").replaceChildren(h("option", { value: "", text: "Não mover" }), ...S.workspaces.map((w) => h("option", { value: w.id, text: w.name })));
  $("b-client-wrap").hidden = !S.workspaces.some((w) => isWork(w));
  S.bulkPick = []; renderBulkPicker();
  $("dl-project").replaceChildren(...uniq(S.tasks.map((t) => t.project)).map((v) => h("option", { value: v })));
  $("dl-client").replaceChildren(...uniq(S.tasks.map((t) => t.client)).map((v) => h("option", { value: v })));
  $("ov-bulk").hidden = false;
});
$("b-due-mode").addEventListener("change", (e) => { $("b-due-wrap").hidden = e.target.value !== "set"; if (e.target.value === "set") $("b-due").focus(); });
$("b-as-mode").addEventListener("change", renderBulkPicker);
$("b-ws").addEventListener("change", renderBulkPicker);
$("b-cancel").addEventListener("click", () => ($("ov-bulk").hidden = true));
$("bulkform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const patch = {};
  const dm = $("b-due-mode").value;
  if (dm === "set") { if (!$("b-due").value) { toast("Escolha a nova data."); return; } patch.due_date = $("b-due").value; }
  if (dm === "clear") patch.due_date = null;
  if ($("b-prio").value) patch.priority = $("b-prio").value === "0" ? null : Number($("b-prio").value);
  if ($("b-done").value) patch.done = $("b-done").value === "1";
  if ($("b-project").value.trim()) patch.project = $("b-project").value.trim();
  if ($("b-client").value.trim()) patch.client = $("b-client").value.trim();
  if ($("b-ws").value) patch.workspace_id = $("b-ws").value;
  const asMode = $("b-as-mode").value;
  if (!Object.keys(patch).length && !asMode) { toast("Nenhuma alteração escolhida."); return; }
  if (asMode && asMode !== "replace" && !S.bulkPick.length) { toast("Escolha pelo menos uma pessoa."); return; }
  const btn = $("b-save"); btn.disabled = true;
  const ids = [...S.sel];
  try {
    if (Object.keys(patch).length) await bulkUpdate(patch);
    if (patch.workspace_id) {
      // responsáveis que não participam do novo ambiente saem da tarefa
      const allowed = membersOf(patch.workspace_id).map((m) => m.user_id);
      for (const part of chunks(ids)) {
        const { error } = await sb.from("task_assignees").delete().in("task_id", part).not("user_id", "in", `(${allowed.join(",") || "00000000-0000-0000-0000-000000000000"})`);
        if (error) throw error;
      }
    }
    if (asMode === "replace" || asMode === "remove") {
      for (const part of chunks(ids)) {
        let q = sb.from("task_assignees").delete().in("task_id", part);
        if (asMode === "remove") q = q.in("user_id", S.bulkPick);
        const { error } = await q; if (error) throw error;
      }
    }
    if ((asMode === "replace" || asMode === "add") && S.bulkPick.length) {
      const rows = ids.flatMap((task_id) => S.bulkPick.map((user_id) => ({ task_id, user_id })));
      for (const part of chunks(rows, 200)) {
        const { error } = await sb.from("task_assignees").upsert(part, { onConflict: "task_id,user_id", ignoreDuplicates: true });
        if (error) throw error;
      }
    }
    $("ov-bulk").hidden = true;
    toast(`${ids.length} tarefas atualizadas.`);
    setSelecting(false); await loadAll();
  } catch (e) { fail(e); } finally { btn.disabled = false; }
});

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

/* ================= Sincronização com planilha ================= */
function syncInfo(ws) {
  const src = S.sources.find((x) => x.workspace_id === ws.id);
  if (!src || !src.last_run_at) return src ? h("span", { class: "syncinfo", text: "Planilha: sincroniza todo dia às 19h30" }) : null;
  const r = src.last_result || {};
  const when = `${fmtDate(ymd(new Date(src.last_run_at))).toLowerCase()} às ${fmtStamp(src.last_run_at).split(", ")[1]}`;
  if (!r.ok) return h("span", { class: "syncinfo err", title: r.error || "", text: `Planilha: erro na última sincronização (${when})` });
  return h("span", { class: "syncinfo", text: `Planilha: ${when} · ${r.created} ${r.created === 1 ? "nova" : "novas"}, ${r.completed} ${r.completed === 1 ? "concluída" : "concluídas"}` });
}
$("btn-sync").addEventListener("click", async () => {
  const ws = currentWs(); const b = $("btn-sync");
  if (!ws || b.classList.contains("spinning")) return;
  b.classList.add("spinning"); b.disabled = true;
  try {
    const { data, error } = await sb.functions.invoke("sheet-sync", { body: { mode: "run", workspace_id: ws.id } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* sem corpo */ }
      throw new Error(msg);
    }
    toast(data.created || data.completed
      ? `Planilha sincronizada: ${data.created} ${data.created === 1 ? "nova" : "novas"}, ${data.completed} ${data.completed === 1 ? "concluída" : "concluídas"}.`
      : "Planilha sincronizada. Nada novo.");
    await loadAll();
  } catch (e) { toast("Não sincronizou: " + e.message); await loadAll(); }
  finally { b.classList.remove("spinning"); b.disabled = false; }
});

/* ================= Seções: Tarefas / Finanças ================= */
const MOD_TITLES = { tasks: "Tarefas", fin: "Finanças" };
function applyMod() {
  const hasFin = S.finSources.length > 0;
  if (!hasFin) S.mod = "tasks";
  document.body.classList.toggle("no-fin", !hasFin);
  document.body.classList.toggle("mod-fin", S.mod === "fin");
  for (const b of $("modnav").querySelectorAll("button")) {
    if (b.dataset.mod === S.mod) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  $("mod-title").textContent = MOD_TITLES[S.mod];
  document.title = `Management App - ${MOD_TITLES[S.mod]}`;
  if (S.mod === "fin" && !S.fin.state && !S.fin.loading && !S.fin.error) loadFinance();
}
$("modnav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mod]");
  if (!b || b.dataset.mod === S.mod) return;
  S.mod = b.dataset.mod; store("t.mod", S.mod);
  if (S.mod === "fin") S.fin.error = null;
  applyMod(); window.scrollTo(0, 0);
});
function finStatus(text, err) { const el = $("fin-status"); el.textContent = text; el.classList.toggle("err", !!err); }
async function loadFinance() {
  const src = S.finSources[0];
  if (!src || S.fin.loading) return;
  S.fin.loading = true; S.fin.error = null;
  const btn = $("fin-refresh"); btn.classList.add("spinning"); btn.disabled = true;
  finStatus(S.fin.state ? "Atualizando…" : "Carregando a planilha de finanças…");
  try {
    const { data, error } = await sb.functions.invoke("finance-data", { body: { workspace_id: src.workspace_id } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* sem corpo */ }
      throw new Error(msg);
    }
    if (!data || data.ok === false) throw new Error((data && data.error) || "Resposta vazia.");
    S.fin.state = buildFinance(data); S.fin.options = data.options || null; S.fin.at = new Date(data.fetched_at || Date.now());
    const hh = `${String(S.fin.at.getHours()).padStart(2, "0")}:${String(S.fin.at.getMinutes()).padStart(2, "0")}`;
    finStatus(`${src.title} · atualizado às ${hh}`);
    mountPainel(buildFIN(data), data.fetched_at);
  } catch (e) {
    S.fin.error = e.message;
    finStatus("Não consegui carregar as finanças: " + e.message, true);
  } finally { S.fin.loading = false; btn.classList.remove("spinning"); btn.disabled = false; }
}
$("fin-refresh").addEventListener("click", () => loadFinance());

// O painel de finanças é uma página própria (fin/painel.html) dentro de um iframe da mesma origem.
// Se já está aberto, só troca os dados: os filtros escolhidos continuam.
function mountPainel(fin, quando) {
  window.__FIN__ = fin;
  const old = $("fin-frame");
  if (old && old.contentWindow && old.contentWindow.__aplicarDados) { old.contentWindow.__aplicarDados(fin, quando); return; }
  const fr = h("iframe", { id: "fin-frame", src: "fin/painel.html?v=18", title: "Painel de finanças", scrolling: "no" });
  fr.addEventListener("load", () => {
    const doc = fr.contentDocument; if (!doc) return;
    const fit = () => { fr.style.height = doc.documentElement.scrollHeight + "px"; };
    fit(); new ResizeObserver(fit).observe(doc.body);
    if (fr.contentWindow.__aplicarDados) fr.contentWindow.__aplicarDados(fin, quando);
  });
  $("fin-root").replaceChildren(fr);
}

/* ---------- Novo lançamento ---------- */
const L = { tipo: "Gastos", catTouched: false };
const parseMoney = (v) => {
  let s = String(v || "").trim().replace(/[R$\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s); return isFinite(n) ? n : NaN;
};
function fillOpts(sel, list, current) {
  sel.replaceChildren(...list.map((v) => h("option", { value: v, text: v })));
  if (current && list.includes(current)) sel.value = current;
}
function lancCats() {
  const o = S.fin.options;
  return L.tipo === "Rendas" ? o.catRendas : o.catGastos;
}
function setLancTipo(t) {
  L.tipo = t;
  for (const b of document.querySelectorAll(".l-tipo button")) b.setAttribute("aria-pressed", String(b.dataset.tipo === t));
  fillOpts($("l-cat"), lancCats(), $("l-cat").value);
}
function lastTx(pred) {
  const tx = (S.fin.state && S.fin.state.transactions) || [];
  for (let i = tx.length - 1; i >= 0; i--) if (pred(tx[i])) return tx[i];
  return null;
}
function openLanc() {
  const o = S.fin.options;
  if (!o) { toast("Espere os dados da planilha carregarem."); return; }
  L.catTouched = false;
  const myFirst = ((S.me && (S.me.display_name || S.me.email)) || "").split(/[ @]/)[0].toLowerCase();
  const me = o.titulares.find((t) => t.toLowerCase() === myFirst) || o.titulares[0];
  fillOpts($("l-tit"), o.titulares, me);
  const myLast = lastTx((t) => t.titular === me);
  fillOpts($("l-conta"), o.contas, myLast && myLast.conta);
  const recs = o.recorrencias.length ? o.recorrencias : ["Avulso", "Recorrente"];
  fillOpts($("l-rec"), recs, recs.includes("Avulso") ? "Avulso" : recs[0]);
  setLancTipo("Gastos");
  $("l-valor").value = ""; $("l-est").value = ""; $("l-desc").value = ""; $("l-data").value = today();
  const ests = [...new Set(((S.fin.state && S.fin.state.transactions) || []).map((t) => t.est).filter((e) => e && e !== "-"))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  $("l-est-list").replaceChildren(...ests.map((e) => h("option", { value: e })));
  $("ov-lanc").hidden = false;
  setTimeout(() => $("l-valor").focus(), 50);
}
document.querySelectorAll(".l-tipo button").forEach((b) => b.addEventListener("click", () => setLancTipo(b.dataset.tipo)));
$("l-cat").addEventListener("change", () => (L.catTouched = true));
$("l-tit").addEventListener("change", () => { const t = lastTx((x) => x.titular === $("l-tit").value); if (t) $("l-conta").value = t.conta; });
$("l-est").addEventListener("change", () => {
  const est = $("l-est").value.trim().toLowerCase(); if (!est) return;
  const t = lastTx((x) => x.est.toLowerCase() === est && x.tipo === L.tipo);
  if (t && !L.catTouched && lancCats().includes(t.catLabel)) $("l-cat").value = t.catLabel;
});
$("fin-fab").addEventListener("click", openLanc);
$("l-cancel").addEventListener("click", () => ($("ov-lanc").hidden = true));
$("lancform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const valor = parseMoney($("l-valor").value);
  if (!isFinite(valor) || valor <= 0) { toast("Informe um valor maior que zero."); $("l-valor").focus(); return; }
  const btn = $("l-save"); btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const entry = { data: $("l-data").value, tipo: L.tipo, valor, categoria: $("l-cat").value, titular: $("l-tit").value, conta: $("l-conta").value,
      estabelecimento: $("l-est").value.trim(), recorrencia: $("l-rec").value, descricao: $("l-desc").value.trim() };
    const res = await invokeAi({ mode: "add", workspace_id: S.finSources[0].workspace_id, entries: [entry] }, "finance-data");
    if (!res.added) throw new Error((res.problems && res.problems[0]) || "Nada foi salvo.");
    $("ov-lanc").hidden = true;
    toast(`${L.tipo === "Rendas" ? "Renda" : "Gasto"} de R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} salvo na planilha${res.row ? ` (aba Dados, linha ${res.row}, ID ${res.ids[0]})` : ""}.`);
    loadFinance();
  } catch (err) { toast("Não salvou: " + err.message); }
  finally { btn.disabled = false; btn.textContent = "Salvar na planilha"; }
});

/* ================= Assistente ================= */
const AI_SUGGEST_FIN = [
  "Quanto gastamos este mês e como está em relação às metas?",
  "Quais categorias mais cresceram nos últimos 3 meses?",
  "Onde dá para economizar?",
  "Registra um gasto de R$ 45 no iFood hoje"
];
const AI_SUGGEST = [
  "Quais são as prioridades para hoje e amanhã?",
  "Resuma o que está atrasado, agrupado por cliente.",
  "Monte uma sugestão de agenda para a semana.",
  "O que eu concluí nos últimos 7 dias?"
];
const aiFin = () => S.mod === "fin";
const aiKey = () => (aiFin() ? "fin" : currentWs().id);
const aiConv = () => { const k = aiKey(); if (!S.ai.has(k)) S.ai.set(k, []); return S.ai.get(k); };
function esc(t) { return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function mdLite(text) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/), hd = line.match(/^#{1,4}\s+(.*)/);
    const kind = ul ? "ul" : ol ? "ol" : null;
    if (list && list.kind !== kind) { out.push(`<${list.kind}>${list.items.join("")}</${list.kind}>`); list = null; }
    if (kind) { list = list || { kind, items: [] }; list.items.push(`<li>${inline((ul || ol)[1])}</li>`); continue; }
    if (hd) out.push(`<h4>${inline(hd[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<${list.kind}>${list.items.join("")}</${list.kind}>`);
  return out.join("");
}
function renderAi() {
  const log = $("ai-log"); log.replaceChildren();
  const conv = aiConv();
  if (!conv.length) {
    log.append(h("div", { class: "ai-empty" }, [
      h("p", { text: aiFin()
        ? "Pergunte sobre as finanças da família ou peça para registrar um gasto ou renda. Nada vai para a planilha sem você confirmar."
        : `Pergunte sobre as tarefas de ${currentWs().name} ou peça mudanças. Nada muda sem você confirmar.` }),
      ...(aiFin() ? AI_SUGGEST_FIN : AI_SUGGEST).map((q) => h("button", { type: "button", class: "pill", text: q, onclick: () => sendAi(q) }))
    ]));
  }
  conv.forEach((m, i) => {
    if (m.role === "user") { log.append(h("div", { class: "ai-msg user", text: m.content })); return; }
    const bubble = h("div", { class: "ai-msg bot" + (m.error ? " err" : "") });
    if (m.error) bubble.textContent = m.content; else bubble.innerHTML = mdLite(m.content);
    for (const p of m.problems || []) bubble.append(h("div", { class: "ai-note", text: p }));
    log.append(bubble);
    if (m.proposal) {
      const pr = m.proposal, closed = !!pr.status;
      log.append(h("div", { class: "ai-proposal" + (closed ? " closed" : "") }, [
        h("h5", { text: closed ? (pr.status === "applied" ? (pr.kind === "finance" ? "Salvo na planilha" : "Aplicado") : pr.status === "partial" ? "Aplicado em parte" : "Descartado") : pr.kind === "finance" ? `Lançamentos propostos (${pr.actions.length})` : `Mudanças propostas (${pr.actions.length})` }),
        h("ul", {}, pr.actions.map((a) => h("li", { text: a.label }))),
        ...(pr.errors || []).map((e) => h("div", { class: "ai-note", text: e })),
        closed ? null : h("div", { class: "row" }, [
          h("button", { type: "button", class: "btn secondary", text: "Descartar", onclick: () => { pr.status = "discarded"; conv.push({ role: "user", content: "(descartei as mudanças propostas)" }); renderAi(); } }),
          h("button", { type: "button", class: "btn", text: pr.kind === "finance" ? "Salvar na planilha" : "Confirmar", onclick: (e) => applyAi(pr, e.currentTarget) })
        ])
      ]));
    }
  });
  if (S.aiBusy) log.append(h("div", { class: "ai-typing", text: "Pensando…" }));
  log.scrollTop = log.scrollHeight;
  $("ai-send").disabled = S.aiBusy;
}
async function invokeAi(body, fn = "assistant") {
  const { data, error } = await sb.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* sem corpo */ }
    throw new Error(msg);
  }
  if (data && data.ok === false && data.error) throw new Error(data.error);
  return data;
}
async function sendAi(text) {
  text = (text || "").trim();
  if (!text || S.aiBusy) return;
  const fin = aiFin(), ws = currentWs(), conv = aiConv();
  conv.push({ role: "user", content: text });
  S.aiBusy = true; renderAi();
  try {
    const messages = conv.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.proposal ? `${m.content}\n[Propus: ${m.proposal.actions.map((a) => a.label).join("; ")}${m.proposal.status ? ` | ${m.proposal.status === "discarded" ? "descartado" : "aplicado"}` : ""}]` : m.content }));
    const data = fin
      ? await invokeAi({ mode: "chat", workspace_id: S.finSources[0].workspace_id, messages }, "finance-data")
      : await invokeAi({ mode: "chat", workspace_id: ws.id, messages });
    conv.push({ role: "assistant", content: data.reply || "", proposal: data.proposal || null, problems: data.problems || [] });
  } catch (e) {
    conv.push({ role: "assistant", error: true, content: "Não consegui responder: " + e.message });
  } finally { S.aiBusy = false; renderAi(); }
}
async function applyAi(pr, btn) {
  btn.disabled = true; btn.textContent = "Aplicando…";
  if (pr.kind === "finance") {
    try {
      const res = await invokeAi({ mode: "add", workspace_id: S.finSources[0].workspace_id, entries: pr.actions.map((a) => a.entry) }, "finance-data");
      pr.status = res.problems && res.problems.length ? "partial" : "applied"; pr.errors = res.problems || [];
      toast(`${res.added} ${res.added === 1 ? "lançamento salvo" : "lançamentos salvos"} na planilha${res.row ? ` (a partir da linha ${res.row} da aba Dados)` : ""}.`);
      loadFinance();
    } catch (e) { toast("Não salvou: " + e.message); btn.disabled = false; btn.textContent = "Salvar na planilha"; return; }
    renderAi(); return;
  }
  try {
    const res = await invokeAi({ mode: "apply", workspace_id: currentWs().id, actions: pr.actions });
    pr.status = res.errors && res.errors.length ? (res.applied ? "partial" : "discarded") : "applied";
    pr.errors = res.errors || [];
    toast(res.applied ? `${res.applied} ${res.applied === 1 ? "mudança aplicada" : "mudanças aplicadas"}.` : "Nenhuma mudança aplicada.");
    await loadAll();
  } catch (e) { toast("Não aplicou: " + e.message); btn.disabled = false; btn.textContent = "Confirmar"; return; }
  renderAi();
}
$("btn-ai").addEventListener("click", () => {
  $("ai-title").textContent = aiFin() ? "Assistente de finanças" : "Assistente";
  $("ov-ai").hidden = false; renderAi(); setTimeout(() => $("ai-text").focus(), 50);
});
$("ai-close").addEventListener("click", () => ($("ov-ai").hidden = true));
$("ai-clear").addEventListener("click", () => { S.ai.set(aiKey(), []); renderAi(); });
$("ai-form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("ai-text"); const v = t.value; t.value = ""; t.style.height = ""; sendAi(v); });
$("ai-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("ai-form").requestSubmit(); } });
$("ai-text").addEventListener("input", (e) => { const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; });

/* ================= Notificações ================= */
async function callNotify(body) {
  const { data, error } = await sb.functions.invoke("telegram-notify", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* sem corpo */ }
    throw new Error(msg);
  }
  return data;
}
const HOURS = Array.from({ length: 24 }, (_, i) => [String(i), `${String(i).padStart(2, "0")}h`]);
const WD_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function selectEl(options, value, onchange, disabled) {
  const el = h("select", { disabled, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h("option", { value: v, text: l })));
  el.value = String(value ?? ""); return el;
}
function destText(ws) {
  if (ws.telegram_chat_id) return `Grupo do Telegram (ID ${ws.telegram_chat_id}).`;
  const ms = membersOf(ws.id);
  const label = (id) => { const p = S.profiles.get(id); return nameOf(id) + (p && p.telegram_chat_id ? "" : " (sem chat ID no perfil)"); };
  if (ms.length === 1) return `Privado de ${label(ms[0].user_id)}.`;
  return `Privado de cada pessoa: ${ms.map((m) => label(m.user_id)).join(", ")}.`;
}
async function updateRule(r, patch) {
  Object.assign(r, patch); renderNotif();
  const { error } = await sb.from("notification_rules").update(patch).eq("id", r.id);
  if (error) { fail(error); loadAll(); }
}
function renderNotif() {
  const ws = currentWs(); if (!ws) return;
  const owner = isOwner(ws.id);
  $("nf-title").textContent = `Notificações · ${ws.name}`;
  $("nf-dest").textContent = destText(ws);
  $("nf-group").value = ws.telegram_chat_id || ""; $("nf-group").disabled = !owner;
  $("nf-group-save").hidden = !owner;
  $("nf-add").hidden = !owner;
  $("nf-hint").textContent = owner
    ? "Os horários são de Brasília. O resumo é enviado uma vez por dia, no horário escolhido (pode chegar até 15 minutos depois)."
    : "Só o dono do ambiente altera as notificações.";
  const rules = S.rules.filter((r) => r.workspace_id === ws.id);
  const box = $("nf-rules");
  if (!rules.length) { box.replaceChildren(h("p", { class: "nf-empty", text: "Nenhum resumo configurado ainda." })); return; }
  box.replaceChildren(...rules.map((r) => {
    const on = h("input", { type: "checkbox", disabled: !owner, "aria-label": "Ativo" }); on.checked = r.enabled;
    on.addEventListener("change", () => updateRule(r, { enabled: on.checked }));
    const overdue = h("input", { type: "checkbox", disabled: !owner }); overdue.checked = r.include_overdue;
    overdue.addEventListener("change", () => updateRule(r, { include_overdue: overdue.checked }));
    const mine = h("input", { type: "checkbox", disabled: !owner }); mine.checked = r.only_mine;
    mine.addEventListener("change", () => updateRule(r, { only_mine: mine.checked }));
    const del = h("button", { type: "button", class: "btn danger", text: "Excluir", hidden: !owner, onclick: async () => {
      if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Confirmar"; return; }
      const { error } = await sb.from("notification_rules").delete().eq("id", r.id);
      if (error) return fail(error);
      S.rules = S.rules.filter((x) => x !== r); renderNotif();
    } });
    const test = h("button", { type: "button", class: "btn secondary", text: "Enviar teste agora", onclick: async () => {
      test.disabled = true; test.textContent = "Enviando…";
      try {
        const res = await callNotify({ mode: "test", rule_id: r.id });
        if (res && res.sent) toast(`Enviado para ${res.sent} ${res.sent === 1 ? "destino" : "destinos"}.`);
        else toast((res && (res.note || (res.errors || [])[0])) || "Nada foi enviado.");
      } catch (e) { toast("Não enviou: " + e.message); }
      finally { test.disabled = false; test.textContent = "Enviar teste agora"; }
    } });
    return h("div", { class: "nf-rule" + (r.enabled ? "" : " off") }, [
      h("div", { class: "nf-row" }, [
        h("label", {}, [on, h("strong", { text: r.kind === "daily" ? "Resumo do dia" : "Resumo da semana" })]),
        h("span", { class: "grow" }),
        r.kind === "weekly" ? selectEl(WD_FULL.map((l, i) => [String(i), l]), r.weekday ?? 0, (v) => updateRule(r, { weekday: Number(v) }), !owner) : null,
        h("span", { text: "às" }),
        selectEl(HOURS, r.hour, (v) => updateRule(r, { hour: Number(v) }), !owner)
      ]),
      h("div", { class: "hint", text: r.kind === "daily" ? "Tarefas com data de hoje." : "Tarefas com data nos 7 dias seguintes ao envio, separadas por dia." }),
      h("div", { class: "nf-row" }, [
        h("label", {}, [overdue, h("span", { text: "Incluir atrasadas" })]),
        ws.telegram_chat_id ? null : h("label", {}, [mine, h("span", { text: "Cada pessoa recebe só as tarefas dela" })])
      ]),
      h("div", { class: "nf-row" }, [test, h("span", { class: "grow" }), del]),
      r.last_sent_on ? h("div", { class: "hint", text: `Último envio automático: ${fmtDate(r.last_sent_on).toLowerCase()}` }) : null
    ]);
  }));
}
async function addRule(kind) {
  const ws = currentWs(); if (!ws) return;
  const row = { workspace_id: ws.id, kind, hour: kind === "daily" ? 8 : 19, weekday: kind === "weekly" ? 0 : null };
  const { data, error } = await sb.from("notification_rules").insert(row).select("*").single();
  if (error) return fail(error);
  S.rules.push(data); renderNotif();
}
$("btn-notif").addEventListener("click", () => { renderNotif(); $("ov-notif").hidden = false; });
$("nf-close").addEventListener("click", () => ($("ov-notif").hidden = true));
$("nf-add-daily").addEventListener("click", () => addRule("daily"));
$("nf-add-weekly").addEventListener("click", () => addRule("weekly"));
$("nf-group-save").addEventListener("click", async () => {
  const ws = currentWs(); const v = $("nf-group").value.trim();
  if (v && !/^-?\d{4,20}$/.test(v)) { toast("O ID do grupo é um número, geralmente começa com -100."); return; }
  const { error } = await sb.from("workspaces").update({ telegram_chat_id: v || null }).eq("id", ws.id);
  if (error) return fail(error);
  ws.telegram_chat_id = v || null; renderNotif(); toast(v ? "Grupo salvo." : "Grupo removido.");
});

/* ================= Perfil ================= */
$("btn-me").addEventListener("click", () => {
  $("p-name").value = (S.me && S.me.display_name) || "";
  $("p-chat").value = (S.me && S.me.telegram_chat_id) || "";
  $("p-email").textContent = S.me ? `Conectado como ${S.me.email}` : "";
  $("ov-me").hidden = false;
});
$("p-cancel").addEventListener("click", () => ($("ov-me").hidden = true));
$("meform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const chat = $("p-chat").value.trim();
  if (chat && !/^-?\d{4,20}$/.test(chat)) { toast("O chat ID é só número."); return; }
  const { error } = await sb.from("profiles").update({ display_name: $("p-name").value.trim(), telegram_chat_id: chat || null }).eq("id", S.uid);
  if (error) return fail(error);
  $("ov-me").hidden = true; loadAll();
});
$("p-chat-test").addEventListener("click", async () => {
  const chat = $("p-chat").value.trim();
  if (!/^-?\d{4,20}$/.test(chat)) { toast("Digite o seu chat ID (só números)."); return; }
  const b = $("p-chat-test"); b.disabled = true;
  try {
    if (!S.me || S.me.telegram_chat_id !== chat) {
      const { error } = await sb.from("profiles").update({ telegram_chat_id: chat }).eq("id", S.uid);
      if (error) throw error;
      if (S.me) S.me.telegram_chat_id = chat;
    }
    await callNotify({ mode: "hello" });
    toast("Mensagem enviada. Confira o Telegram.");
  } catch (e) { toast("Não enviou: " + e.message); } finally { b.disabled = false; }
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
$("btn-filters").addEventListener("click", () => {
  const open = !$("filters").classList.contains("open");
  $("filters").classList.toggle("open", open); $("btn-filters").setAttribute("aria-expanded", String(open));
});
$("fclear").addEventListener("click", () => { S.project = S.client = S.assignee = S.due = S.prio = ""; render(); });
for (const [ov, close] of [["ov-task", closeTask], ["ov-ws", closeWs], ["ov-me", () => ($("ov-me").hidden = true)], ["ov-bulk", () => ($("ov-bulk").hidden = true)], ["ov-notif", () => ($("ov-notif").hidden = true)], ["ov-ai", () => ($("ov-ai").hidden = true)], ["ov-lanc", () => ($("ov-lanc").hidden = true)]]) {
  $(ov).addEventListener("click", (e) => { if (e.target === $(ov)) close(); });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("ov-task").hidden) closeTask(); else if (!$("ov-bulk").hidden) $("ov-bulk").hidden = true;
  else if (!$("ov-ws").hidden) closeWs(); else if (!$("ov-me").hidden) $("ov-me").hidden = true;
  else if (S.selecting) setSelecting(false);
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
