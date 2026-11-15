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

// Monta os dados no formato do painel "Finanças Hugo & Bárbara" (fin/painel.html) a partir das abas lidas ao vivo.
export function buildFIN(raw) {
  const dataIso = (v) => { const d = parseBRDate(v); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null; };
  const num = (v) => Math.round(parseBRL(v) * 100) / 100;
  const txt = (v) => String(v ?? "").trim();
  const grid = (values) => {
    const head = (values[0] || []).map((h) => txt(h)); const idx = {};
    head.forEach((h, i) => { if (h) idx[h] = i; });
    return { idx, rows: values.slice(1) };
  };
  const D = grid(raw.dados || []), iD = D.idx;
  const linhas = D.rows.filter((r) => r && txt(r[iD["ID"]]) && txt(r[iD["DATA"]]));
  const unicos = (col) => [...new Set(linhas.map((r) => txt(r[iD[col]])).filter(Boolean))].sort();
  const dims = {
    titular: unicos("TITULAR"), tipo: unicos("TIPO"), categoria: unicos("CATEGORIA"), conta: unicos("CONTA"),
    tipoConta: unicos("TIPO CONTA"), estabelecimento: unicos("ESTABELECIMENTO"), recorrencia: unicos("RECORRENCIA"), macro: unicos("MACRO-CATEGORIA")
  };
  const pos = {};
  for (const k of Object.keys(dims)) { pos[k] = {}; dims[k].forEach((v, i) => (pos[k][v] = i)); }
  const ix = (k, v) => { const i = pos[k][txt(v)]; return i === undefined ? -1 : i; };
  const tx = linhas.map((r) => [dataIso(r[iD["DATA"]]), ix("titular", r[iD["TITULAR"]]), ix("tipo", r[iD["TIPO"]]),
    ix("categoria", r[iD["CATEGORIA"]]), num(r[iD["VALOR"]]), ix("conta", r[iD["CONTA"]]), ix("tipoConta", r[iD["TIPO CONTA"]]),
    ix("estabelecimento", r[iD["ESTABELECIMENTO"]]), ix("recorrencia", r[iD["RECORRENCIA"]]), ix("macro", r[iD["MACRO-CATEGORIA"]]),
    Number(txt(r[iD["ID"]])), txt(r[iD["DESCRIÇÃO"]])]).filter((t) => t[0]);
  const M = grid(raw.metas || []), iM = M.idx;
  const metas = M.rows.filter((r) => r && txt(r[iM["DATA"]]) && txt(r[iM["CATEGORIA"]]))
    .map((r) => [dataIso(r[iM["DATA"]]), txt(r[iM["CATEGORIA"]]), num(r[iM["VALOR"]]), Number(txt(r[iM["QUANTIDADE MESES"]])) || 0, num(r[iM["VALOR ACUMULADO"]])])
    .filter((m) => m[0]);
  const P = grid(raw.patrimonio || []), iP = P.idx;
  const patrimonio = P.rows.filter((r) => r && txt(r[iP["DATA"]]))
    .map((r) => [dataIso(r[iP["DATA"]]), txt(r[iP["TIPO"]]), txt(r[iP["LIQUIDEZ"]]), txt(r[iP["MOVIMENTACAO"]]), txt(r[iP["CATEGORIA"]]),
      txt(r[iP["DESCRICAO"]]), txt(r[iP["INVESTIDOR"]]), num(r[iP["VALOR"]]), txt(r[iP["ANOMES"]])])
    .filter((r) => r[0]);
  return {
    dims, tx, metas, patrimonio,
    txCols: ["data", "titular", "tipo", "categoria", "valor", "conta", "tipoConta", "estabelecimento", "recorrencia", "macro", "id", "descricao"],
    metaCols: ["data", "categoria", "valor", "qtdMeses", "acumulado"],
    patCols: ["data", "tipo", "liquidez", "movimentacao", "categoria", "descricao", "investidor", "valor", "anomes"]
  };
}
