// Lê a planilha de finanças de um ambiente e devolve as abas usadas no dashboard.
// Só membros do ambiente que tem a planilha configurada (tabela finance_sources) conseguem ler.
// Corpo: { workspace_id }
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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
  cached = { token: body.access_token, exp: Date.now() + 3500_000 };
  return body.access_token;
}

const RANGES = { dados: "Dados!A1:N", metas: "Metas!A1:F", patrimonio: "'Patrimônio'!A1:J", financiamento: "Financiamento!A1:D" };

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

    const token = await googleToken();
    const qs = Object.values(RANGES).map((r) => "ranges=" + encodeURIComponent(r)).join("&");
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.spreadsheet_id}/values:batchGet?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const out = await r.json();
    if (!r.ok) {
      const msg = out.error?.message || r.status;
      if (r.status === 403 || r.status === 404) return json({ ok: false, error: `Sem acesso à planilha de finanças. Compartilhe com a conta de serviço como Leitor. (${msg})` }, 502);
      return json({ ok: false, error: `Erro ao ler a planilha: ${msg}` }, 502);
    }
    const keys = Object.keys(RANGES);
    const result: Record<string, string[][]> = {};
    (out.valueRanges ?? []).forEach((vr: any, i: number) => { result[keys[i]] = vr.values ?? []; });
    return json({ ok: true, fetched_at: new Date().toISOString(), ...result });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
