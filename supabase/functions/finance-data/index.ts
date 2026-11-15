// Finanças da família: lê a planilha, responde perguntas com o Claude e adiciona lançamentos.
// Só membros do ambiente que tem a planilha configurada (tabela finance_sources) têm acesso.
// Modos:
//   { mode: "get", workspace_id }                      -> abas Dados, Metas, Patrimônio, Financiamento
//   { mode: "chat", workspace_id, messages }           -> { reply, proposal? } (proposal = lançamentos sugeridos)
//   { mode: "add", workspace_id, entries }             -> grava os lançamentos confirmados na aba Dados
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "";
const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const TZ = "America/Sao_Paulo";
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- Google ---------- */
const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let cached: { token: string; exp: number } | null = null;
async function googleToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!SA_JSON) throw new Error("Segredo GOOGLE_SERVICE_ACCOUNT_JSON não configurado no Supabase.");
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = (sa.private_key as string).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Google recusou a conta de serviço: ${body.error_description || body.error || r.status}`);
  cached = { token: body.access_token, exp: Date.now() + 3500_000 };
  return body.access_token;
}
async function sheetsFetch(path: string, init: RequestInit = {}) {
  const token = await googleToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const out = await r.json();
  if (!r.ok) {
    const msg = out.error?.message || r.status;
    if (r.status === 403 || r.status === 404) throw new Error(`Sem acesso à planilha de finanças. Compartilhe com a conta de serviço. (${msg})`);
    throw new Error(`Erro na planilha: ${msg}`);
  }
  return out;
}

const RANGES = { dados: "Dados!A1:N", metas: "Metas!A1:F", patrimonio: "'Patrimônio'!A1:J", financiamento: "Financiamento!A1:D" };
type Sheets = Record<keyof typeof RANGES, string[][]>;
async function readAll(spreadsheetId: string): Promise<Sheets> {
  const qs = Object.values(RANGES).map((r) => "ranges=" + encodeURIComponent(r)).join("&");
  const out = await sheetsFetch(`${spreadsheetId}/values:batchGet?${qs}`);
  const keys = Object.keys(RANGES) as (keyof typeof RANGES)[];
  const res = {} as Sheets;
  keys.forEach((k, i) => (res[k] = out.valueRanges?.[i]?.values ?? []));
  return res;
}

/* ---------- conversão ---------- */
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const WD = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function parseBRL(raw: string) {
  let s = String(raw ?? "").trim(); if (!s) return 0;
  const neg = s.startsWith("-");
  s = s.replace(/^-/, "").replace(/R\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s); return isNaN(n) ? 0 : neg ? -n : n;
}
const fmt = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cleanCat = (s: string) => String(s || "").replace(/^[^\p{L}(]+/u, "").trim();
function objects(values: string[][]) {
  if (!values.length) return [];
  const head = values[0].map((h) => String(h).trim());
  return values.slice(1).filter((r) => r.some((x) => String(x).trim())).map((r) => {
    const o: Record<string, string> = {}; head.forEach((h, i) => (o[h] = String(r[i] ?? "").trim())); return o;
  });
}
const ymKey = (br: string) => { const p = br.split("/"); return p.length === 3 ? `${p[2]}-${p[1].padStart(2, "0")}` : ""; };

function options(rows: Record<string, string>[]) {
  const uniq = (k: string, filter?: (r: Record<string, string>) => boolean) =>
    [...new Set(rows.filter((r) => !filter || filter(r)).map((r) => r[k]).filter(Boolean))].sort((a, b) => cleanCat(a).localeCompare(cleanCat(b), "pt-BR"));
  return {
    titulares: uniq("TITULAR"), tipos: uniq("TIPO"), contas: uniq("CONTA"), tiposConta: uniq("TIPO CONTA"),
    catGastos: uniq("CATEGORIA", (r) => r["TIPO"] === "Gastos"), catRendas: uniq("CATEGORIA", (r) => r["TIPO"] === "Rendas"),
    categorias: uniq("CATEGORIA"), recorrencias: uniq("RECORRENCIA"),
  };
}

function financeContext(s: Sheets) {
  const rows = objects(s.dados);
  const tx = rows.filter((r) => r["DATA"] && r["VALOR"]);
  const byMonth: Record<string, { g: number; r: number; cats: Record<string, number> }> = {};
  for (const r of tx) {
    const k = ymKey(r["DATA"]); if (!k) continue;
    const v = parseBRL(r["VALOR"]);
    const m = (byMonth[k] ||= { g: 0, r: 0, cats: {} });
    if (r["TIPO"] === "Gastos") { m.g += Math.abs(v); const c = cleanCat(r["CATEGORIA"]) || "Outros"; m.cats[c] = (m.cats[c] || 0) + Math.abs(v); }
    else if (r["TIPO"] === "Rendas") m.r += v;
  }
  const months = Object.keys(byMonth).sort();
  const resumo = months.map((k) => {
    const m = byMonth[k];
    const cats = Object.entries(m.cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${fmt(v)}`).join("; ");
    return `${k}: gastos ${fmt(m.g)} | rendas ${fmt(m.r)} | saldo ${fmt(m.r - m.g)} | por categoria: ${cats}`;
  }).join("\n");
  const linhas = tx.map((r) => [r["ID"], r["DATA"], r["TITULAR"], r["CONTA"], r["TIPO"], cleanCat(r["CATEGORIA"]), r["ESTABELECIMENTO"], r["RECORRENCIA"], r["DESCRIÇÃO"], fmt(parseBRL(r["VALOR"]))].join(" | ")).join("\n");
  const metas = objects(s.metas).filter((r) => months.slice(-3).includes(ymKey(r["DATA"])))
    .map((r) => `${ymKey(r["DATA"])} | ${cleanCat(r["CATEGORIA"])} | meta ${fmt(parseBRL(r["VALOR"]))}`).join("\n");
  const pat = objects(s.patrimonio);
  const latest = [...new Set(pat.map((r) => r["ANOMES"]).filter(Boolean))].sort().slice(-3);
  const patLinhas = pat.filter((r) => latest.includes(r["ANOMES"]) && (r["MOVIMENTACAO"] === "Saldo" || r["MOVIMENTACAO"] === "Valor"))
    .map((r) => [r["ANOMES"], r["TIPO"], r["CATEGORIA"], r["LIQUIDEZ"], r["DESCRICAO"], r["INVESTIDOR"], fmt(parseBRL(r["VALOR"]))].join(" | ")).join("\n");
  const fin = objects(s.financiamento).map((r) => `${r["DATA"]} | saldo devedor ${fmt(parseBRL(r["SALDO DEVEDOR"]))} | previsto ${fmt(parseBRL(r["SALDO PREV"]))}`).join("\n");
  return { rows, text:
`RESUMO MENSAL (valores em R$):
${resumo}

METAS DOS ÚLTIMOS MESES:
${metas || "(sem metas)"}

PATRIMÔNIO (saldos dos últimos meses; ANOMES | tipo | categoria | liquidez | descrição | investidor | valor):
${patLinhas || "(sem dados)"}

FINANCIAMENTO:
${fin || "(sem dados)"}

TODOS OS LANÇAMENTOS (ID | data | titular | conta | tipo | categoria | estabelecimento | recorrência | descrição | valor; gastos são negativos):
${linhas}` };
}

/* ---------- lançamentos ---------- */
type Entry = { data: string; titular: string; tipo_conta?: string; conta: string; tipo: string; categoria: string; estabelecimento?: string; recorrencia?: string; descricao?: string; valor: number };
function normalizeEntry(e: any, opts: ReturnType<typeof options>): { entry?: Entry; label?: string; problem?: string } {
  const data = String(e?.data ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return { problem: `Data inválida: ${data || "(vazia)"}` };
  const valor = Number(String(e?.valor ?? "").replace(",", "."));
  if (!isFinite(valor) || valor === 0) return { problem: "Valor inválido." };
  const tipo = String(e?.tipo ?? "Gastos").trim();
  const pick = (v: string, list: string[]) => !v ? "" : list.find((x) => x.toLowerCase() === v.toLowerCase()) ?? list.find((x) => cleanCat(x).toLowerCase() === cleanCat(v).toLowerCase()) ?? null;
  const rawCat = String(e?.categoria ?? "").trim(), rawConta = String(e?.conta ?? "").trim(), rawTit = String(e?.titular ?? "").trim();
  const categoria = pick(rawCat, opts.categorias), conta = pick(rawConta, opts.contas), titular = pick(rawTit, opts.titulares);
  if (!categoria) return { problem: categoria === null ? `A categoria "${rawCat}" não existe na planilha.` : "Falta a categoria." };
  if (!conta) return { problem: conta === null ? `A conta "${rawConta}" não existe na planilha.` : "Falta a conta." };
  if (!titular) return { problem: titular === null ? `"${rawTit}" não é titular na planilha.` : "Falta o titular." };
  const signed = tipo === "Gastos" ? -Math.abs(valor) : tipo === "Rendas" ? Math.abs(valor) : valor;
  const entry: Entry = {
    data, titular, conta, tipo, categoria, tipo_conta: String(e?.tipo_conta ?? "").trim(),
    estabelecimento: String(e?.estabelecimento ?? "").trim(), recorrencia: String(e?.recorrencia ?? "Avulso").trim() || "Avulso",
    descricao: String(e?.descricao ?? "").trim(), valor: Math.round(signed * 100) / 100,
  };
  const d = `${data.slice(8, 10)}/${data.slice(5, 7)}`;
  return { entry, label: `${d} · ${tipo} · ${cleanCat(categoria)}${entry.estabelecimento ? " · " + entry.estabelecimento : ""}${entry.descricao ? ` (${entry.descricao})` : ""} · R$ ${fmt(entry.valor)} · ${titular}, ${conta}` };
}

async function addEntries(spreadsheetId: string, raw: any[]) {
  const s = await readAll(spreadsheetId);
  const rows = objects(s.dados);
  const opts = options(rows);
  const contaTipo: Record<string, string> = {};
  for (const r of rows) if (r["CONTA"] && r["TIPO CONTA"]) contaTipo[r["CONTA"]] = r["TIPO CONTA"];
  let nextId = Math.max(0, ...rows.map((r) => parseInt(r["ID"], 10)).filter((n) => !isNaN(n))) + 1;
  const values: (string | number)[][] = [], problems: string[] = [];
  for (const e of raw.slice(0, 50)) {
    const { entry, problem } = normalizeEntry(e, opts);
    if (!entry) { problems.push(problem!); continue; }
    const br = `${entry.data.slice(8, 10)}/${entry.data.slice(5, 7)}/${entry.data.slice(0, 4)}`;
    values.push([nextId++, br, entry.titular, entry.tipo_conta || contaTipo[entry.conta] || "", entry.conta, entry.tipo, "", entry.categoria, "",
      entry.estabelecimento ?? "", entry.recorrencia ?? "Avulso", entry.descricao ?? "", "", entry.valor]);
  }
  if (!values.length) return { ok: false, added: 0, problems, error: problems[0] || "Nada para adicionar." };
  await sheetsFetch(`${spreadsheetId}/values/${encodeURIComponent("Dados!A:N")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST", body: JSON.stringify({ values }),
  });
  return { ok: true, added: values.length, ids: values.map((v) => v[0]), problems };
}

/* ---------- chat ---------- */
const TOOL = {
  name: "propor_lancamentos",
  description: "Propõe novos lançamentos na aba Dados da planilha. Nada é gravado até o usuário confirmar no app.",
  input_schema: {
    type: "object",
    properties: {
      lancamentos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            data: { type: "string", description: "AAAA-MM-DD" },
            titular: { type: "string" }, conta: { type: "string" }, tipo_conta: { type: "string" },
            tipo: { type: "string", description: "Gastos ou Rendas (ou outro tipo já usado na planilha)" },
            categoria: { type: "string", description: "Uma categoria já existente, com o emoji como está na planilha" },
            estabelecimento: { type: "string" }, recorrencia: { type: "string", description: "Avulso ou Recorrente" },
            descricao: { type: "string" }, valor: { type: "number", description: "Valor positivo; o sinal é aplicado pelo tipo" },
          },
          required: ["data", "titular", "conta", "tipo", "categoria", "valor"],
        },
      },
    },
    required: ["lancamentos"],
  },
};

async function chat(spreadsheetId: string, messages: { role: string; content: string }[], userName: string) {
  if (!API_KEY) throw new Error("Segredo ANTHROPIC_API_KEY não configurado no Supabase.");
  const s = await readAll(spreadsheetId);
  const ctx = financeContext(s);
  const opts = options(ctx.rows);
  const today = todayLocal();
  const wd = WD[new Date(today + "T12:00:00Z").getUTCDay()];
  const system = `Você é o assistente de finanças da família, dentro do app pessoal. Quem está falando com você: ${userName}.
Hoje é ${wd}, ${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}.

Como responder:
- Português do Brasil, direto. Valores em reais no formato R$ 1.234,56. Nunca use travessão (—).
- Baseie-se só nos dados abaixo. Faça as contas com cuidado; quando somar muitos itens, diga o critério usado. Se faltar informação, diga.
- Para registrar gastos ou rendas novos, chame a ferramenta propor_lancamentos. Nada é gravado até o usuário confirmar no app, então não diga que já registrou.
- Use apenas titulares, contas e categorias que já existem. Se não der para inferir algum campo obrigatório, pergunte antes de propor.
- Você não edita nem apaga lançamentos existentes; para isso o usuário deve mexer direto na planilha.

Valores já usados na planilha:
Titulares: ${opts.titulares.join(", ")}
Contas: ${opts.contas.join(", ")}
Tipos: ${opts.tipos.join(", ")}
Categorias de gastos: ${opts.catGastos.join(", ")}
Categorias de rendas: ${opts.catRendas.join(", ")}
Recorrência: ${opts.recorrencias.join(", ")}

${ctx.text}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], tools: [TOOL], messages }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Claude respondeu com erro: ${body.error?.message || r.status}`);
  const text = (body.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  const use = (body.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL.name);
  if (!use) return { reply: text || "Não consegui responder agora." };
  const entries: Entry[] = [], labels: string[] = [], problems: string[] = [];
  for (const e of use.input?.lancamentos ?? []) {
    const n = normalizeEntry(e, opts);
    if (n.entry) { entries.push(n.entry); labels.push(n.label!); } else problems.push(n.problem!);
  }
  return {
    reply: text || "Preparei estes lançamentos:",
    proposal: entries.length ? { kind: "finance", actions: entries.map((e, i) => ({ entry: e, label: labels[i] })) } : null,
    problems,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ ok: false, error: "Faça login para ver as finanças." }, 401);
    const { data: m } = await admin.from("workspace_members").select("user_id").eq("workspace_id", body.workspace_id).eq("user_id", uid).maybeSingle();
    if (!m) return json({ ok: false, error: "Você não tem acesso a estas finanças." }, 403);
    const { data: src } = await admin.from("finance_sources").select("spreadsheet_id").eq("workspace_id", body.workspace_id).maybeSingle();
    if (!src) return json({ ok: false, error: "Nenhuma planilha de finanças configurada." }, 404);
    const mode = body.mode ?? "get";

    if (mode === "get") {
      const s = await readAll(src.spreadsheet_id);
      return json({ ok: true, fetched_at: new Date().toISOString(), ...s, options: options(objects(s.dados)) });
    }
    if (mode === "add") {
      if (!Array.isArray(body.entries) || !body.entries.length) return json({ ok: false, error: "Nada para adicionar." }, 400);
      const res = await addEntries(src.spreadsheet_id, body.entries);
      return json(res, res.ok ? 200 : 400);
    }
    if (mode === "chat") {
      const msgs = (Array.isArray(body.messages) ? body.messages : [])
        .filter((x: any) => (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim())
        .slice(-16).map((x: any) => ({ role: x.role, content: x.content.slice(0, 8000) }));
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      for (let i = msgs.length - 1; i > 0; i--) if (msgs[i].role === msgs[i - 1].role) { msgs[i - 1].content += "\n\n" + msgs[i].content; msgs.splice(i, 1); }
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ ok: false, error: "Mensagem vazia." }, 400);
      const { data: prof } = await admin.from("profiles").select("display_name,email").eq("id", uid).maybeSingle();
      return json({ ok: true, ...(await chat(src.spreadsheet_id, msgs, prof?.display_name || prof?.email || "membro da família")) });
    }
    return json({ ok: false, error: "Modo inválido." }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
