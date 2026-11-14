// Consolida tarefas a partir de uma planilha do Google.
// - Cria no app as linhas que ainda não existem.
// - Conclui no app as tarefas marcadas como concluídas na planilha.
// Não reabre, não apaga e não sobrescreve edições feitas no app.
// Modos: { mode: "cron" } para todas as planilhas ativas; { mode: "run", workspace_id } pelo botão do app.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "";
const TZ = "America/Sao_Paulo";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- Google: token de acesso com a conta de serviço ---------- */
const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function googleToken(): Promise<string> {
  if (!SA_JSON) throw new Error("Segredo GOOGLE_SERVICE_ACCOUNT_JSON não configurado no Supabase.");
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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
  return body.access_token;
}
async function readSheet(spreadsheetId: string, sheetName: string): Promise<string[][]> {
  const token = await googleToken();
  const range = encodeURIComponent(`${sheetName}!A1:G5000`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json();
  if (!r.ok) {
    const msg = body.error?.message || r.status;
    if (r.status === 403 || r.status === 404) throw new Error(`Sem acesso à planilha. Compartilhe com a conta de serviço como Leitor. (${msg})`);
    throw new Error(`Erro ao ler a planilha: ${msg}`);
  }
  return body.values ?? [];
}

/* ---------- regras de conversão ---------- */
const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
// "DD/MM" ou "DD/MM/AAAA". Sem ano: assume a data entre 9 meses atrás e 3 meses à frente de hoje.
function validIso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
function parseDate(s: string, today: string): string | null {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (m[3]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return validIso(y, mo, d); }
  const ty = Number(today.slice(0, 4));
  const t0 = new Date(today + "T12:00:00Z").getTime(), DAY = 86400000;
  let y = ty;
  const at = (yy: number) => new Date(Date.UTC(yy, mo - 1, d, 12)).getTime();
  if (at(y) > t0 + 90 * DAY) y -= 1;
  else if (at(y) < t0 - 270 * DAY) y += 1;
  return validIso(y, mo, d);
}
const isDone = (v: string) => /^(true|verdadeiro|sim|x|1|✓|✔)$/i.test((v ?? "").trim());

async function syncWorkspace(src: { workspace_id: string; spreadsheet_id: string; sheet_name: string }) {
  const started = new Date().toISOString();
  const today = todayLocal();
  try {
    const values = await readSheet(src.spreadsheet_id, src.sheet_name);
    const [header, ...rows] = values;
    const idx = (name: string, fallback: number) => {
      const i = (header ?? []).findIndex((h) => norm(h) === norm(name));
      return i >= 0 ? i : fallback;
    };
    const C = { done: idx("Concluído", 0), prio: idx("Prioridade", 1), date: idx("Data", 2), project: idx("Projeto", 3), client: idx("Cliente", 4), title: idx("Tarefa", 5), obs: idx("Obs", 6) };

    const { data: ws } = await admin.from("workspaces").select("id,kind").eq("id", src.workspace_id).single();
    const { data: owner } = await admin.from("workspace_members").select("user_id").eq("workspace_id", src.workspace_id).eq("role", "owner").limit(1).maybeSingle();
    const existing = new Map<string, { id: string; done: boolean }>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("tasks").select("id,source_key,done").eq("workspace_id", src.workspace_id)
        .not("source_key", "is", null).range(from, from + 999);
      if (error) throw error;
      for (const t of data ?? []) existing.set(t.source_key, { id: t.id, done: t.done });
      if (!data || data.length < 1000) break;
    }

    const seen = new Map<string, number>();
    const inserts: Record<string, unknown>[] = [];
    const toComplete: string[] = [];
    let skipped = 0;
    for (const r of rows) {
      const title = (r[C.title] ?? "").trim();
      if (!title) { skipped++; continue; }
      const project = (r[C.project] ?? "").trim(), client = (r[C.client] ?? "").trim();
      const base = `${norm(title)}|${norm(client)}|${norm(project)}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const key = `${base}#${n}`;
      const done = isDone(r[C.done]);
      const ex = existing.get(key);
      if (ex) { if (done && !ex.done) toComplete.push(ex.id); continue; }
      const notes = [(r[C.obs] ?? "").replace(/\r\n?/g, "\n").trim(), (r[C.prio] ?? "").trim() ? `Prioridade na planilha: ${(r[C.prio] ?? "").trim()}` : ""].filter(Boolean).join("\n");
      inserts.push({
        workspace_id: src.workspace_id, title: title.slice(0, 300), notes, project, client: ws?.kind === "trabalho" ? client : "",
        due_date: parseDate(r[C.date], today), done, source: "sheet", source_key: key,
        created_by: owner?.user_id ?? null, updated_by: owner?.user_id ?? null,
      });
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const { error } = await admin.from("tasks").insert(inserts.slice(i, i + 200));
      if (error) throw error;
    }
    for (let i = 0; i < toComplete.length; i += 100) {
      const { error } = await admin.from("tasks").update({ done: true }).in("id", toComplete.slice(i, i + 100));
      if (error) throw error;
    }
    const result = { ok: true, created: inserts.length, completed: toComplete.length, rows: rows.length - skipped, at: started };
    await admin.from("sheet_sources").update({ last_run_at: started, last_result: result }).eq("workspace_id", src.workspace_id);
    return result;
  } catch (e) {
    const result = { ok: false, error: (e as Error).message, at: started };
    await admin.from("sheet_sources").update({ last_run_at: started, last_result: result }).eq("workspace_id", src.workspace_id);
    return result;
  }
}

async function callerId(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data?.user?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }
  try {
    if (body.mode === "cron") {
      const { data: sources } = await admin.from("sheet_sources").select("*").eq("enabled", true);
      const results: any[] = [];
      for (const s of sources ?? []) results.push({ workspace_id: s.workspace_id, ...(await syncWorkspace(s)) });
      return json({ ok: true, results });
    }
    if (body.mode === "run") {
      const uid = await callerId(req);
      if (!uid) return json({ ok: false, error: "Faça login para sincronizar." }, 401);
      const { data: m } = await admin.from("workspace_members").select("user_id").eq("workspace_id", body.workspace_id).eq("user_id", uid).maybeSingle();
      if (!m) return json({ ok: false, error: "Você não participa deste ambiente." }, 403);
      const { data: src } = await admin.from("sheet_sources").select("*").eq("workspace_id", body.workspace_id).maybeSingle();
      if (!src) return json({ ok: false, error: "Este ambiente não tem planilha configurada." }, 404);
      const res = await syncWorkspace(src);
      return json(res, res.ok ? 200 : 500);
    }
    return json({ ok: false, error: "Modo inválido." }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
