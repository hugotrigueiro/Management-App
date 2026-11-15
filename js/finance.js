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
const chartBox = (id, tall) => `<div class="fin-chart${tall ? " tall" : ""}" id="${id}"></div>`;

function pal() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { s1: "#5b9cf0", s2: "#e8743f", s3: "#2bbf8a", s4: "#e0a526", s5: "#e06f9b", s6: "#3fbf6a", s8: "#ef7a7a", good: "#3fbf6a", bad: "#ef7a7a", muted: "#9aa3b4" }
    : { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100", s5: "#e87ba4", s6: "#23845a", s8: "#d03b3b", good: "#23845a", bad: "#d03b3b", muted: "#8a92a0" };
}

/* ---------- gráficos em SVG (sem biblioteca externa) ---------- */
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}
function compact(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi"
    : a >= 1e3 ? (a / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil"
    : a.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  return (n < 0 ? "-" : "") + s;
}
function niceStep(range, count) {
  const raw = range / count; const p = 10 ** Math.floor(Math.log10(raw || 1)); const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function legendHtml(series) {
  return `<div class="fin-legend">${series.map((s) => `<span><i style="background:${s.color}${s.dashed ? ";height:2px;border-radius:0" : ""}"></i>${esc(s.label)}</span>`).join("")}</div>`;
}
function tooltip(box) {
  let t = box.querySelector(".fin-tip");
  if (!t) { t = document.createElement("div"); t.className = "fin-tip"; box.append(t); }
  return t;
}
// Gráfico de colunas e/ou linhas. cfg: { labels, series: [{ label, color, values, type: "bar"|"line", dashed, colors }], stacked, legend }
function drawXY(box, cfg) {
  box.innerHTML = "";
  const showLegend = cfg.legend !== false && cfg.series.length > 1;
  if (showLegend) box.insertAdjacentHTML("beforeend", legendHtml(cfg.series));
  const W = Math.max(280, box.clientWidth || 600);
  const H = Math.max(160, (box.clientHeight || 250) - (showLegend ? 26 : 0));
  const n = cfg.labels.length;
  if (!n) { box.innerHTML = `<p class="fin-empty">Sem dados.</p>`; return; }
  const bars = cfg.series.filter((s) => (s.type || "bar") === "bar"), lines = cfg.series.filter((s) => s.type === "line");
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (cfg.stacked) {
      let pos = 0, neg = 0; for (const s of bars) { const v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    } else for (const s of bars) { hi = Math.max(hi, s.values[i] || 0); lo = Math.min(lo, s.values[i] || 0); }
    for (const s of lines) { const v = s.values[i]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, bars.length ? Math.min(0, v) : v); } }
  }
  if (!bars.length && lines.length) { // linhas: não precisa começar no zero
    const vals = lines.flatMap((s) => s.values.filter((v) => v != null));
    lo = Math.min(...vals); hi = Math.max(...vals); const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
  }
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, 4);
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  const padL = 58, padR = 8, padT = 8, padB = 24;
  const pw = W - padL - padR, ph = H - padT - padB;
  const y = (v) => padT + ph - ((v - yMin) / (yMax - yMin)) * ph;
  const bw = pw / n;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "fin-svg", role: "img" });
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    svgEl("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: Math.abs(v) < step / 1e6 ? "axis0" : "grid" }, svg);
    const t = svgEl("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg); t.textContent = compact(v);
  }
  const every = Math.max(1, Math.ceil((n * 46) / pw));
  cfg.labels.forEach((l, i) => {
    if (i % every) return;
    const t = svgEl("text", { x: padL + bw * i + bw / 2, y: H - 6, "text-anchor": "middle", class: "tick" }, svg); t.textContent = l;
  });
  const groupW = Math.min(bw * 0.72, 46 * (cfg.stacked ? 1 : bars.length));
  const one = cfg.stacked ? groupW : groupW / Math.max(1, bars.length);
  for (let i = 0; i < n; i++) {
    const x0 = padL + bw * i + (bw - groupW) / 2;
    let pos = 0, neg = 0;
    bars.forEach((s, j) => {
      const v = s.values[i] || 0; if (!v) return;
      let a, b;
      if (cfg.stacked) { if (v >= 0) { a = pos; b = pos + v; pos = b; } else { a = neg; b = neg + v; neg = b; } }
      else { a = 0; b = v; }
      const top = y(Math.max(a, b)), h = Math.max(1, Math.abs(y(a) - y(b)));
      svgEl("rect", { x: cfg.stacked ? x0 : x0 + one * j, y: top, width: Math.max(2, one - (cfg.stacked ? 0 : 2)), height: h, rx: 3, fill: (s.colors && s.colors[i]) || s.color }, svg);
    });
  }
  for (const s of lines) {
    const pts = s.values.map((v, i) => (v == null ? null : [padL + bw * i + bw / 2, y(v)])).filter(Boolean);
    svgEl("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: s.color, "stroke-width": s.dashed ? 1.5 : 2.2, "stroke-dasharray": s.dashed ? "6 4" : null, "stroke-linejoin": "round" }, svg);
    if (!s.dashed && pts.length <= 40) for (const [cx, cy] of pts) svgEl("circle", { cx, cy, r: 2.8, fill: s.color }, svg);
  }
  const hl = svgEl("rect", { x: 0, y: padT, width: bw, height: ph, class: "hover-band", visibility: "hidden" }, svg);
  svg.prepend(hl);
  const tip = tooltip(box);
  box.append(svg); box.append(tip);
  const show = (evt) => {
    const r = svg.getBoundingClientRect();
    const sx = ((evt.clientX - r.left) / r.width) * W;
    const i = Math.floor((sx - padL) / bw);
    if (i < 0 || i >= n) { hide(); return; }
    hl.setAttribute("x", padL + bw * i); hl.setAttribute("visibility", "visible");
    tip.innerHTML = `<strong>${esc(cfg.labels[i])}</strong>` + cfg.series.map((s) => `<div><i style="background:${(s.colors && s.colors[i]) || s.color}"></i>${esc(s.label)}: ${fmtBRL(s.values[i] || 0)}</div>`).join("");
    tip.style.display = "block";
    const bx = box.getBoundingClientRect();
    let left = evt.clientX - bx.left + 12; if (left + tip.offsetWidth > bx.width) left = evt.clientX - bx.left - tip.offsetWidth - 12;
    tip.style.left = Math.max(0, left) + "px"; tip.style.top = Math.max(0, evt.clientY - bx.top - tip.offsetHeight - 8) + "px";
  };
  const hide = () => { tip.style.display = "none"; hl.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", hide);
}
// Rosca com legenda. items: [{ label, value }]
function drawDonut(box, items, colors) {
  box.innerHTML = "";
  const data = items.filter((d) => d.value > 0);
  const total = sum(data.map((d) => d.value));
  if (!total) { box.innerHTML = `<p class="fin-empty">Sem dados.</p>`; return; }
  const size = 170, r = 64, sw = 26, c = 2 * Math.PI * r;
  const wrap = document.createElement("div"); wrap.className = "fin-donut";
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" });
  let off = 0;
  data.forEach((d, i) => {
    const len = (d.value / total) * c;
    const arc = svgEl("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: colors[i % colors.length], "stroke-width": sw,
      "stroke-dasharray": `${Math.max(0, len - 1.5)} ${c}`, "stroke-dashoffset": -off, transform: `rotate(-90 ${size / 2} ${size / 2})` }, svg);
    const tt = svgEl("title", {}, arc); tt.textContent = `${d.label}: ${fmtBRL(d.value)} (${fmtPct(d.value / total)})`;
    off += len;
  });
  const t1 = svgEl("text", { x: size / 2, y: size / 2 - 2, "text-anchor": "middle", class: "donut-total" }, svg); t1.textContent = compact(total);
  const t2 = svgEl("text", { x: size / 2, y: size / 2 + 15, "text-anchor": "middle", class: "tick" }, svg); t2.textContent = "total";
  wrap.append(svg);
  wrap.insertAdjacentHTML("beforeend", `<ul class="fin-donut-legend">${data.map((d, i) =>
    `<li><i style="background:${colors[i % colors.length]}"></i><span>${esc(d.label)}</span><b>${fmtBRL(d.value)}</b><em>${fmtPct(d.value / total)}</em></li>`).join("")}</ul>`);
  box.append(wrap);
}
// Barras horizontais de gasto x meta por categoria (HTML puro)
function metaBars(rows) {
  const list = rows.filter((r) => r.total || r.meta);
  if (!list.length) return `<p class="fin-empty">Sem gastos neste mês.</p>`;
  const max = Math.max(...list.map((r) => Math.max(r.total, r.meta)), 1);
  return `<div class="fin-metabars">${list.map((r) => {
    const over = r.meta && r.total > r.meta;
    return `<div class="mb-row"><div class="mb-label">${esc(r.label)}</div>
      <div class="mb-track"><i class="${over ? "over" : ""}" style="width:${(r.total / max) * 100}%"></i>${r.meta ? `<b style="left:${(r.meta / max) * 100}%" title="Meta ${fmtBRL(r.meta)}"></b>` : ""}</div>
      <div class="mb-val${over ? " over" : ""}">${fmtBRL(r.total)}${r.meta ? `<small> de ${fmtBRL(r.meta)}</small>` : ""}</div></div>`;
  }).join("")}</div>`;
}

function renderMes(S, mk) {
  const a = aggMonth(S, mk);
  const metaT = sum(a.catRows.map((r) => r.meta));
  const tk = a.trans;
  return `<div class="fin-kpis">` +
    kpi("Gastos", fmtBRL(a.totalG), "bad", metaT ? a.totalG / metaT : undefined, metaT ? [fmtPct(a.totalG / metaT), "meta " + fmtBRL(metaT)] : null) +
    kpi("Rendas", fmtBRL(a.totalR)) + kpi("Retorno", fmtBRL(a.retorno), a.retorno >= 0 ? "good" : "bad") + `</div>` +
    card("Gastos x meta por categoria", metaBars(a.catRows), "(a marca é a meta)") +
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
    kpi("Retorno", fmtBRL(a.retorno), a.retorno >= 0 ? "good" : "bad") + kpi("Ticket médio (gastos)", fmtBRL(a.totalG / (a.qtdG || 1))) + `</div>` +
    card("Rendas x gastos por mês", chartBox("fc-rg")) + card("Retorno por mês", chartBox("fc-ret"), "(rendas menos gastos)") +
    card("Gastos por recorrência", chartBox("fc-rec")) +
    `<div class="fin-2">${card("Gastos por categoria", tbl(a.catG, true), "(período todo)")}${card("Gastos por estabelecimento", tbl(a.estG, true), "(top 10)")}</div>` +
    `<div class="fin-2">${card("Rendas por categoria", tbl(a.catR))}${card("Rendas por origem", tbl(a.estR), "(top 10)")}</div>`;
  const after = () => {
    const p = pal(), labels = a.monthly.map((m) => m.label);
    drawXY(document.getElementById("fc-rg"), { labels, series: [
      { label: "Gastos", color: p.s8, values: a.monthly.map((m) => m.gastos) },
      { label: "Rendas", color: p.s6, values: a.monthly.map((m) => m.rendas) }] });
    drawXY(document.getElementById("fc-ret"), { labels, legend: false, series: [
      { label: "Retorno", color: p.good, values: a.monthly.map((m) => m.retorno), colors: a.monthly.map((m) => (m.retorno >= 0 ? p.good : p.bad)) }] });
    drawXY(document.getElementById("fc-rec"), { labels, stacked: true, series: [
      { label: "Avulso", color: p.s1, values: a.monthly.map((m) => m.avulso) },
      { label: "Recorrente", color: p.s3, values: a.monthly.map((m) => m.recorrente) }] });
  };
  return [html, after];
}
function renderPatrimonio(S) {
  const a = aggPatrimonio(S);
  if (!a.monthly.length) return ["<p class=\"fin-empty\">Sem dados de patrimônio.</p>", null];
  const html = `<div class="fin-kpis">` + kpi("Ativos", fmtBRL(a.ativos), "good") + kpi("Passivos", fmtBRL(-a.passivos), "bad") +
    kpi("Patrimônio líquido", fmtBRL(a.liquido)) + kpi("Investimentos", fmtBRL(a.investimentos)) + kpi("Imóveis (líquido)", fmtBRL(a.imoveis)) + `</div>` +
    card("Patrimônio por mês", chartBox("fc-pat")) +
    `<div class="fin-2">${card("Ativos por categoria", `<div id="fc-pcat"></div>`)}${card("Ativos por liquidez", `<div id="fc-pliq"></div>`)}</div>`;
  const after = () => {
    const p = pal(), colors = [p.s1, p.s2, p.s3, p.s4, p.s5, p.s6];
    drawXY(document.getElementById("fc-pat"), { labels: a.monthly.map((m) => m.label), series: [
      { label: "Ativo", color: p.s6, values: a.monthly.map((m) => m.ativo) },
      { label: "Passivo", color: p.s8, values: a.monthly.map((m) => m.passivo) },
      { label: "Líquido", color: p.s1, type: "line", values: a.monthly.map((m) => m.ativo - m.passivo) }] });
    drawDonut(document.getElementById("fc-pcat"), a.pieCat, colors);
    drawDonut(document.getElementById("fc-pliq"), a.pieLiq, colors);
  };
  return [html, after];
}
function renderFinanciamento(S) {
  const rows = S.financiamento;
  if (!rows.length) return ["<p class=\"fin-empty\">Sem dados de financiamento.</p>", null];
  const first = rows[0], last = rows[rows.length - 1];
  const inicial = first.prev || first.devedor, pct = inicial ? last.devedor / inicial : 0;
  const html = `<div class="fin-kpis">` + kpi("Saldo devedor", fmtBRL(last.devedor), "", pct, [fmtPct(pct), fmtBRL(inicial)]) +
    kpi("Diferença para o previsto", fmtBRL(last.prev - last.devedor), last.prev - last.devedor >= 0 ? "good" : "bad") + `</div>` +
    card("Saldo devedor por mês", chartBox("fc-fin", true)) +
    card("Histórico", tableHtml([{ t: "Data" }, { t: "Saldo previsto", num: 1 }, { t: "Saldo devedor", num: 1 }, { t: "Diferença", num: 1 }],
      rows.slice().reverse().map((r) => `<tr><td>${r.date.toLocaleDateString("pt-BR")}</td><td class="num">${fmtBRL(r.prev)}</td><td class="num">${fmtBRL(r.devedor)}</td><td class="num ${numClass(r.prev - r.devedor)}">${fmtBRL(r.prev - r.devedor)}</td></tr>`)));
  const after = () => {
    const p = pal();
    drawXY(document.getElementById("fc-fin"), { labels: rows.map((r) => `${MONTHS[r.date.getMonth()]}/${String(r.date.getFullYear()).slice(2)}`), series: [
      { label: "Saldo devedor", color: p.s8, type: "line", values: rows.map((r) => r.devedor) },
      { label: "Saldo previsto", color: p.muted, type: "line", dashed: true, values: rows.map((r) => r.prev) }] });
  };
  return [html, after];
}

const TABS = [["mes", "Mês atual"], ["geral", "Visão geral"], ["patrimonio", "Patrimônio"], ["financiamento", "Financiamento"]];
let LAST = null, resizeTimer = null, lastWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!LAST || !LAST.after || !LAST.root.offsetParent) return;
    const w = LAST.root.clientWidth; if (Math.abs(w - lastWidth) < 8) return;
    lastWidth = w; LAST.after();
  }, 200);
});

// Monta o dashboard dentro de "root". "state" é o resultado de buildState; "ui" guarda aba e mês escolhidos.
export function renderFinance(root, state, ui) {
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
  LAST = { root, after };
  lastWidth = root.clientWidth;
  if (after) {
    try { after(); }
    catch (e) { console.error(e); root.querySelectorAll(".fin-chart").forEach((c) => (c.innerHTML = `<p class="fin-empty">Não consegui desenhar o gráfico.</p>`)); }
  }
}
