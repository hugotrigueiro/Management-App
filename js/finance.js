// Dashboard de finanças da família (portado do artefato "Finanças da Família").
// Recebe as abas da planilha (Dados, Metas, Patrimônio, Financiamento) e desenha as quatro visões.

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const PCT = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtBRL = (n) => (n == null || isNaN(n) ? "-" : BRL.format(n));
const fmtPct = (n) => (n == null || isNaN(n) || !isFinite(n) ? "-" : PCT.format(n));
const numClass = (n) => (n < 0 ? "neg" : n > 0 ? "pos" : "");
const sum = (a) => a.reduce((x, y) => x + y, 0);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function parseBRL(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return 0;
  const neg = s.startsWith("-");
  s = s.replace(/^-/, "").replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : neg ? -n : n;
}
function parseBRDate(raw) {
  const p = String(raw ?? "").trim().split("/");
  if (p.length !== 3) return null;
  const d = +p[0], m = +p[1], y = +p[2];
  return d && m && y ? new Date(y < 100 ? 2000 + y : y, m - 1, d) : null;
}
const monthKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (k) => { const [y, m] = k.split("-"); return `${MONTHS[+m - 1]}/${y.slice(2)}`; };
const anomesLabel = (s) => `${MONTHS[+String(s).slice(4, 6) - 1]}/${String(s).slice(2, 4)}`;
const cleanCat = (s) => String(s || "").replace(/^[^\p{L}(]+/u, "").trim();

function toObjects(values) {
  if (!values || !values.length) return [];
  const head = values[0].map((h) => String(h).trim());
  return values.slice(1).filter((r) => r.some((x) => String(x).trim() !== "")).map((r) => {
    const o = {}; head.forEach((h, i) => (o[h] = String(r[i] ?? "").trim())); return o;
  });
}

export function buildState(raw) {
  const rows = toObjects(raw.dados);
  const labelMap = {};
  for (const r of rows) { const c = cleanCat(r["CATEGORIA"]); if (c && !labelMap[c]) labelMap[c] = r["CATEGORIA"]; }
  const labelFor = (c) => labelMap[c] || c || "Outros";
  const transactions = [];
  rows.forEach((r, i) => {
    const tipo = r["TIPO"];
    if (tipo !== "Gastos" && tipo !== "Rendas") return;
    const date = parseBRDate(r["DATA"]);
    if (!date) return;
    const cat = cleanCat(r["CATEGORIA"]) || "Outros";
    transactions.push({
      id: r["ID"] || i, date, monthKey: monthKeyOf(date), titular: r["TITULAR"] || "", conta: r["CONTA"] || "", tipo,
      cat, catLabel: labelFor(cat), est: r["ESTABELECIMENTO"] || "-", rec: r["RECORRENCIA"] || "",
      desc: r["DESCRIÇÃO"] || r["DESCRICAO"] || "", valor: parseBRL(r["VALOR"])
    });
  });
  const months = [...new Set(transactions.map((t) => t.monthKey))].sort();
  const histByCat = {};
  for (const t of transactions) if (t.tipo === "Gastos") histByCat[t.cat] = (histByCat[t.cat] || 0) + Math.abs(t.valor);
  const metas = {};
  for (const r of toObjects(raw.metas)) {
    const d = parseBRDate(r["DATA"]);
    if (d) metas[monthKeyOf(d) + "|" + cleanCat(r["CATEGORIA"])] = parseBRL(r["VALOR"]);
  }
  const patrimonio = toObjects(raw.patrimonio).map((r) => ({
    tipo: r["TIPO"], liquidez: r["LIQUIDEZ"] || "Não informado", mov: r["MOVIMENTACAO"],
    categoria: r["CATEGORIA"] || "Outros", valor: parseBRL(r["VALOR"]), anomes: r["ANOMES"]
  })).filter((r) => r.anomes);
  const financiamento = toObjects(raw.financiamento).map((r) => ({
    date: parseBRDate(r["DATA"]), devedor: parseBRL(r["SALDO DEVEDOR"]), prev: parseBRL(r["SALDO PREV"])
  })).filter((r) => r.date).sort((a, b) => a.date - b.date);
  return { transactions, months, monthsCount: months.length || 1, histByCat, metas, patrimonio, financiamento, labelFor };
}

function groupSum(rows, key) {
  const acc = {};
  for (const r of rows) { const k = key(r); (acc[k] ||= { qtd: 0, total: 0 }); acc[k].qtd++; acc[k].total += Math.abs(r.valor); }
  return acc;
}
function aggMonth(S, mk) {
  const g = S.transactions.filter((t) => t.tipo === "Gastos" && t.monthKey === mk);
  const r = S.transactions.filter((t) => t.tipo === "Rendas" && t.monthKey === mk);
  const totalG = sum(g.map((t) => Math.abs(t.valor))), totalR = sum(r.map((t) => t.valor));
  const byCat = groupSum(g, (t) => t.cat);
  const cats = new Set([...Object.keys(byCat), ...Object.keys(S.metas).filter((k) => k.startsWith(mk + "|")).map((k) => k.split("|")[1])]);
  const catRows = [...cats].map((c) => {
    const v = byCat[c] || { qtd: 0, total: 0 }; const meta = S.metas[mk + "|" + c] || 0;
    return { label: S.labelFor(c), qtd: v.qtd, total: v.total, ticket: v.qtd ? v.total / v.qtd : 0, pct: totalG ? v.total / totalG : 0, meta, delta: meta - v.total, media: (S.histByCat[c] || 0) / S.monthsCount };
  }).sort((a, b) => b.total - a.total);
  const byEst = groupSum(g, (t) => t.est);
  const estRows = Object.entries(byEst).map(([k, v]) => ({ label: k, qtd: v.qtd, total: v.total, ticket: v.total / v.qtd, pct: totalG ? v.total / totalG : 0 })).sort((a, b) => b.total - a.total);
  return { totalG, totalR, retorno: totalR - totalG, catRows, estRows, trans: g.concat(r).sort((a, b) => b.date - a.date), qtdG: g.length };
}
function aggGeral(S) {
  const g = S.transactions.filter((t) => t.tipo === "Gastos"), r = S.transactions.filter((t) => t.tipo === "Rendas");
  const totalG = sum(g.map((t) => Math.abs(t.valor))), totalR = sum(r.map((t) => t.valor));
  const table = (rows, total, key, limit) => {
    const arr = Object.entries(groupSum(rows, key)).map(([k, v]) => ({ label: key === catKey ? S.labelFor(k) : k, qtd: v.qtd, total: v.total, pct: total ? v.total / total : 0 })).sort((a, b) => b.total - a.total);
    return limit ? arr.slice(0, limit) : arr;
  };
  const catKey = (t) => t.cat, estKey = (t) => t.est;
  const monthly = S.months.map((mk) => {
    const gm = g.filter((t) => t.monthKey === mk), rm = r.filter((t) => t.monthKey === mk);
    const gT = sum(gm.map((t) => Math.abs(t.valor))), rT = sum(rm.map((t) => t.valor));
    const avulso = sum(gm.filter((t) => t.rec === "Avulso" || !t.rec).map((t) => Math.abs(t.valor)));
    return { label: monthLabel(mk), gastos: gT, rendas: rT, retorno: rT - gT, avulso, recorrente: gT - avulso };
  });
  return {
    totalG, totalR, retorno: totalR - totalG, qtdG: g.length, monthly,
    catG: table(g, totalG, catKey), estG: table(g, totalG, estKey, 10), catR: table(r, totalR, catKey), estR: table(r, totalR, estKey, 10)
  };
}
const SALDO = { Saldo: 1, Valor: 1 };
function aggPatrimonio(S) {
  const rows = S.patrimonio;
  const list = [...new Set(rows.map((r) => r.anomes))].sort();
  const latest = list[list.length - 1];
  const ativo = (am, cat) => sum(rows.filter((r) => r.anomes === am && r.tipo === "Ativo" && SALDO[r.mov] && (!cat || r.categoria === cat)).map((r) => r.valor));
  const passivo = (am, cat) => sum(rows.filter((r) => r.anomes === am && r.tipo === "Passivo" && r.mov === "Saldo" && (!cat || r.categoria === cat)).map((r) => r.valor));
  const ativos = ativo(latest), pass = passivo(latest);
  const latestRows = rows.filter((r) => r.anomes === latest && r.tipo === "Ativo" && SALDO[r.mov]);
  const pie = (key) => { const by = {}; for (const r of latestRows) by[key(r)] = (by[key(r)] || 0) + r.valor; return Object.entries(by).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
  return {
    latest, ativos, passivos: Math.abs(pass), liquido: ativos + pass,
    imoveis: ativo(latest, "Imóveis") + passivo(latest, "Imóveis"), investimentos: ativos - ativo(latest, "Imóveis"),
    monthly: list.map((am) => ({ label: anomesLabel(am), ativo: ativo(am), passivo: Math.abs(passivo(am)) })),
    pieCat: pie((r) => r.categoria), pieLiq: pie((r) => r.liquidez)
  };
}

/* ---------- desenho ---------- */
const kpi = (label, value, cls, bar, note) =>
  `<div class="fin-kpi"><div class="lbl">${esc(label)}</div><div class="val ${cls || ""}">${value}</div>` +
  (bar !== undefined ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, bar * 100))}%"></i></div>` : "") +
  (note ? `<div class="bar-note"><span>${note[0]}</span><span>${note[1]}</span></div>` : "") + "</div>";
const card = (title, inner, hint) => `<div class="fin-card"><h3>${esc(title)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ""}</h3>${inner}</div>`;
const tableHtml = (cols, rows, foot, wide) =>
  `<div class="fin-table"><table class="${wide ? "wide" : ""}"><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.t)}</th>`).join("")}</tr></thead>` +
  `<tbody>${rows.join("") || `<tr><td colspan="${cols.length}" class="empty-row">Sem dados</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table></div>`;
const chartBox = (id, tall) => `<div class="fin-chart${tall ? " tall" : ""}"><canvas id="${id}"></canvas></div>`;

let CHARTS = {};
function destroyCharts() { for (const c of Object.values(CHARTS)) c.destroy(); CHARTS = {}; }
function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function pal() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { s1: "#3987e5", s2: "#d95926", s3: "#199e70", s4: "#c98500", s5: "#d55181", s6: "#2fa84f", s8: "#e66767", good: "#2fa84f", bad: "#e66767", grid: "#2b3240", muted: "#9aa3b4", text: "#e9ecf2" }
    : { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100", s5: "#e87ba4", s6: "#23845a", s8: "#d03b3b", good: "#23845a", bad: "#d03b3b", grid: "#e4e6ea", muted: "#5f6878", text: "#18202e" };
}
function chartOpts(p, o = {}) {
  const money = { grid: { color: p.grid }, ticks: { color: p.muted, font: { size: 10 }, callback: (v) => fmtBRL(v) } };
  return {
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: {
      legend: o.legend === false ? { display: false } : { position: "top", labels: { color: p.text, boxWidth: 12, font: { size: 11 } } },
      tooltip: { backgroundColor: "#20201eee", padding: 10, cornerRadius: 8, callbacks: { label: o.label || ((c) => `${c.dataset.label}: ${fmtBRL(c.raw)}`) } }
    },
    scales: o.noScales ? undefined : { x: { stacked: !!o.stacked, grid: { display: false }, ticks: { color: p.muted, font: { size: 10 } } }, y: { stacked: !!o.stacked, ...money } }
  };
}
function chart(id, cfg) { const el = document.getElementById(id); if (el && window.Chart) CHARTS[id] = new window.Chart(el, cfg); }

function renderMes(S, mk) {
  const a = aggMonth(S, mk);
  const metaT = sum(a.catRows.map((r) => r.meta));
  const tk = a.trans;
  return `<div class="fin-kpis">` +
    kpi("Gastos", fmtBRL(a.totalG), "bad", metaT ? a.totalG / metaT : undefined, metaT ? [fmtPct(a.totalG / metaT), "meta " + fmtBRL(metaT)] : null) +
    kpi("Rendas", fmtBRL(a.totalR)) + kpi("Retorno", fmtBRL(a.retorno), a.retorno >= 0 ? "good" : "bad") + `</div>` +
    card("Gastos por categoria e metas", tableHtml(
      [{ t: "Categoria" }, { t: "Qtd", num: 1 }, { t: "Média mensal", num: 1 }, { t: "Ticket médio", num: 1 }, { t: "% gastos", num: 1 }, { t: "Gastos", num: 1 }, { t: "Meta", num: 1 }, { t: "Restante", num: 1 }],
      a.catRows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.qtd}</td><td class="num">${fmtBRL(-r.media)}</td><td class="num">${r.qtd ? fmtBRL(-r.ticket) : "-"}</td><td class="num">${fmtPct(r.pct)}</td><td class="num neg">${fmtBRL(-r.total)}</td><td class="num">${fmtBRL(r.meta)}</td><td class="num ${numClass(r.delta)}">${fmtBRL(r.delta)}</td></tr>`),
      `<tr><td>Total</td><td class="num">${a.qtdG}</td><td></td><td></td><td class="num">100%</td><td class="num neg">${fmtBRL(-a.totalG)}</td><td class="num">${fmtBRL(metaT)}</td><td class="num ${numClass(metaT - a.totalG)}">${fmtBRL(metaT - a.totalG)}</td></tr>`, true)) +
    card("Gastos por estabelecimento", tableHtml(
      [{ t: "Estabelecimento" }, { t: "Qtd", num: 1 }, { t: "Ticket médio", num: 1 }, { t: "%", num: 1 }, { t: "Valor", num: 1 }],
      a.estRows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.qtd}</td><td class="num">${fmtBRL(-r.ticket)}</td><td class="num">${fmtPct(r.pct)}</td><td class="num neg">${fmtBRL(-r.total)}</td></tr>`),
      `<tr><td>Total</td><td class="num">${a.qtdG}</td><td></td><td class="num">100%</td><td class="num neg">${fmtBRL(-a.totalG)}</td></tr>`)) +
    card("Transações do mês", tableHtml(
      [{ t: "Data" }, { t: "Quem" }, { t: "Categoria" }, { t: "Estabelecimento" }, { t: "Descrição" }, { t: "Valor", num: 1 }],
      tk.map((t) => `<tr><td>${t.date.toLocaleDateString("pt-BR")}</td><td>${esc(t.titular)}</td><td>${esc(t.catLabel)}</td><td>${esc(t.est)}</td><td class="desc">${esc(t.desc)}</td><td class="num ${numClass(t.valor)}">${fmtBRL(t.valor)}</td></tr>`), null, true));
}
function renderGeral(S) {
  const a = aggGeral(S);
  const tbl = (rows, neg) => tableHtml([{ t: "Nome" }, { t: "Qtd", num: 1 }, { t: "%", num: 1 }, { t: "Valor", num: 1 }],
    rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.qtd}</td><td class="num">${fmtPct(r.pct)}</td><td class="num ${neg ? "neg" : ""}">${fmtBRL(neg ? -r.total : r.total)}</td></tr>`),
    `<tr><td>Total</td><td class="num">${sum(rows.map((r) => r.qtd))}</td><td></td><td class="num">${fmtBRL((neg ? -1 : 1) * sum(rows.map((r) => r.total)))}</td></tr>`);
  const html = `<div class="fin-kpis">` + kpi("Total gastos", fmtBRL(a.totalG), "bad") + kpi("Total rendas", fmtBRL(a.totalR)) +
    kpi("Retorno", fmtBRL(a.retorno), a.retorno >= 0 ? "good" : "bad") + kpi("Ticket médio (gastos)", fmtBRL(-a.totalG / (a.qtdG || 1))) + `</div>` +
    card("Rendas x gastos por mês", chartBox("fc-rg")) + card("Retorno por mês", chartBox("fc-ret"), "(rendas menos gastos)") +
    card("Gastos por recorrência", chartBox("fc-rec")) +
    `<div class="fin-2">${card("Gastos por categoria", tbl(a.catG, true), "(período todo)")}${card("Gastos por estabelecimento", tbl(a.estG, true), "(top 10)")}</div>` +
    `<div class="fin-2">${card("Rendas por categoria", tbl(a.catR))}${card("Rendas por origem", tbl(a.estR), "(top 10)")}</div>`;
  const after = () => {
    const p = pal(), labels = a.monthly.map((m) => m.label);
    chart("fc-rg", { type: "bar", data: { labels, datasets: [
      { label: "Gastos", data: a.monthly.map((m) => m.gastos), backgroundColor: p.s8, borderRadius: 4, maxBarThickness: 34 },
      { label: "Rendas", data: a.monthly.map((m) => m.rendas), backgroundColor: p.s6, borderRadius: 4, maxBarThickness: 34 }] }, options: chartOpts(p) });
    chart("fc-ret", { type: "bar", data: { labels, datasets: [{ label: "Retorno", data: a.monthly.map((m) => m.retorno), backgroundColor: a.monthly.map((m) => (m.retorno >= 0 ? p.good : p.bad)), borderRadius: 4, maxBarThickness: 34 }] }, options: chartOpts(p, { legend: false }) });
    chart("fc-rec", { type: "bar", data: { labels, datasets: [
      { label: "Avulso", data: a.monthly.map((m) => m.avulso), backgroundColor: p.s1, borderRadius: 3, maxBarThickness: 34 },
      { label: "Recorrente", data: a.monthly.map((m) => m.recorrente), backgroundColor: p.s3, borderRadius: 3, maxBarThickness: 34 }] }, options: chartOpts(p, { stacked: true }) });
  };
  return [html, after];
}
function renderPatrimonio(S) {
  const a = aggPatrimonio(S);
  if (!a.monthly.length) return ["<p class=\"fin-empty\">Sem dados de patrimônio.</p>", null];
  const html = `<div class="fin-kpis">` + kpi("Ativos", fmtBRL(a.ativos), "good") + kpi("Passivos", fmtBRL(-a.passivos), "bad") +
    kpi("Patrimônio líquido", fmtBRL(a.liquido)) + kpi("Investimentos", fmtBRL(a.investimentos)) + kpi("Imóveis (líquido)", fmtBRL(a.imoveis)) + `</div>` +
    card("Patrimônio por mês", chartBox("fc-pat")) +
    `<div class="fin-2">${card("Ativos por categoria", chartBox("fc-pcat"))}${card("Ativos por liquidez", chartBox("fc-pliq"))}</div>`;
  const after = () => {
    const p = pal(), colors = [p.s1, p.s2, p.s3, p.s4, p.s5];
    chart("fc-pat", { type: "bar", data: { labels: a.monthly.map((m) => m.label), datasets: [
      { label: "Ativo", data: a.monthly.map((m) => m.ativo), backgroundColor: p.s6, borderRadius: 4, maxBarThickness: 30 },
      { label: "Passivo", data: a.monthly.map((m) => m.passivo), backgroundColor: p.s8, borderRadius: 4, maxBarThickness: 30 }] }, options: chartOpts(p) });
    for (const [id, data] of [["fc-pcat", a.pieCat], ["fc-pliq", a.pieLiq]]) {
      const total = sum(data.map((d) => d.value));
      chart(id, { type: "doughnut", data: { labels: data.map((d) => d.label), datasets: [{ data: data.map((d) => d.value), backgroundColor: colors, borderColor: cssv("--surface"), borderWidth: 2 }] },
        options: chartOpts(p, { noScales: true, label: (c) => `${c.label}: ${fmtBRL(c.raw)} (${fmtPct(c.raw / total)})` }) });
    }
  };
  return [html, after];
}
function renderFinanciamento(S) {
  const rows = S.financiamento;
  if (!rows.length) return ["<p class=\"fin-empty\">Sem dados de financiamento.</p>", null];
  const first = rows[0], last = rows[rows.length - 1];
  const inicial = first.prev || first.devedor, pct = inicial ? last.devedor / inicial : 0;
  const html = `<div class="fin-kpis">` + kpi("Saldo devedor", fmtBRL(last.devedor), "", pct, [fmtPct(pct), fmtBRL(inicial)]) +
    kpi("Amortizado a mais que o previsto", fmtBRL(last.prev - last.devedor), last.prev - last.devedor >= 0 ? "good" : "bad") + `</div>` +
    card("Saldo devedor por mês", chartBox("fc-fin", true)) +
    card("Histórico", tableHtml([{ t: "Data" }, { t: "Saldo previsto", num: 1 }, { t: "Saldo devedor", num: 1 }, { t: "Diferença", num: 1 }],
      rows.slice().reverse().map((r) => `<tr><td>${r.date.toLocaleDateString("pt-BR")}</td><td class="num">${fmtBRL(r.prev)}</td><td class="num">${fmtBRL(r.devedor)}</td><td class="num ${numClass(r.prev - r.devedor)}">${fmtBRL(r.prev - r.devedor)}</td></tr>`)));
  const after = () => {
    const p = pal();
    chart("fc-fin", { type: "line", data: { labels: rows.map((r) => r.date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })), datasets: [
      { label: "Saldo devedor", data: rows.map((r) => r.devedor), borderColor: p.s8, backgroundColor: p.s8, tension: .25, pointRadius: 3, borderWidth: 2 },
      { label: "Saldo previsto", data: rows.map((r) => r.prev), borderColor: p.muted, borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }] }, options: chartOpts(p) });
  };
  return [html, after];
}

const TABS = [["mes", "Mês atual"], ["geral", "Visão geral"], ["patrimonio", "Patrimônio"], ["financiamento", "Financiamento"]];
let chartLoader = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (!chartLoader) chartLoader = new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js";
    s.onload = ok; s.onerror = () => { chartLoader = null; ko(new Error("Não consegui carregar os gráficos.")); };
    document.head.append(s);
  });
  return chartLoader;
}

// Monta o dashboard dentro de "root". "state" é o resultado de buildState; "ui" guarda aba e mês escolhidos.
export async function renderFinance(root, state, ui) {
  destroyCharts();
  if (!ui.tab) ui.tab = "mes";
  if (!ui.month || !state.months.includes(ui.month)) ui.month = state.months[state.months.length - 1];
  const tabs = `<div class="fin-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${t}</button>`).join("")}</div>`;
  let body = "", after = null;
  if (ui.tab === "mes") {
    body = `<div class="fin-period"><label for="fin-month">Mês</label><select id="fin-month">${state.months.slice().reverse().map((m) => `<option value="${m}"${m === ui.month ? " selected" : ""}>${monthLabel(m)}</option>`).join("")}</select></div>` +
      (ui.month ? renderMes(state, ui.month) : `<p class="fin-empty">Sem transações.</p>`);
  } else {
    [body, after] = ui.tab === "geral" ? renderGeral(state) : ui.tab === "patrimonio" ? renderPatrimonio(state) : renderFinanciamento(state);
  }
  root.innerHTML = tabs + `<div class="fin-panel">${body}</div>`;
  root.querySelectorAll(".fin-tabs button").forEach((b) => b.addEventListener("click", () => { ui.tab = b.dataset.tab; renderFinance(root, state, ui); }));
  const sel = root.querySelector("#fin-month");
  if (sel) sel.addEventListener("change", () => { ui.month = sel.value; renderFinance(root, state, ui); });
  if (after) {
    try { await loadChartJs(); after(); }
    catch (e) { root.querySelectorAll(".fin-chart").forEach((c) => (c.innerHTML = `<p class="fin-empty">${esc(e.message)}</p>`)); }
  }
}
