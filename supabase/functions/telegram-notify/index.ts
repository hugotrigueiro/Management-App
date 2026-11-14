// Envia os resumos de tarefas pelo Telegram.
// Modos:
//   { mode: "cron" }                 chamado pelo agendamento a cada 15 min; envia as regras no horário
//   { mode: "test", rule_id }        envio imediato de uma regra (usuário logado e membro do ambiente)
//   { mode: "hello" }                mensagem de teste para o chat privado de quem chamou
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const APP_URL = "https://hugotrigueiro.github.io/Management-App/";
const TZ = "America/Sao_Paulo";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- datas no fuso de São Paulo ---------- */
function nowLocal() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, hour: Number(get("hour")), weekday: new Date(date + "T12:00:00Z").getUTCDay() };
}
const addDays = (d: string, n: number) => {
  const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WD_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const MO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmt = (d: string) => { const x = new Date(d + "T12:00:00Z"); return `${WD[x.getUTCDay()]}, ${x.getUTCDate()} ${MO[x.getUTCMonth()]}`; };
const fmtLong = (d: string) => { const x = new Date(d + "T12:00:00Z"); return `${WD_FULL[x.getUTCDay()]}, ${x.getUTCDate()} ${MO[x.getUTCMonth()]}`; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- Telegram ---------- */
async function send(chatId: string, text: string) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN não configurado nos segredos do Supabase.");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) throw new Error(`Telegram recusou (${r.status}): ${body.description ?? "erro desconhecido"}`);
}

/* ---------- montagem do resumo ---------- */
type Rule = {
  id: string; workspace_id: string; kind: "daily" | "weekly"; enabled: boolean; hour: number;
  weekday: number | null; include_overdue: boolean; only_mine: boolean; last_sent_on: string | null;
};
type Recipient = { chat: string; userId: string | null };

async function loadContext(wsId: string) {
  const [{ data: ws }, { data: members }] = await Promise.all([
    admin.from("workspaces").select("id,name,kind,telegram_chat_id").eq("id", wsId).single(),
    admin.from("workspace_members").select("user_id, profiles(id,display_name,email,telegram_chat_id)").eq("workspace_id", wsId),
  ]);
  const { data: tasks } = await admin.from("tasks")
    .select("id,title,due_date,project,client,priority,task_assignees(user_id)")
    .eq("workspace_id", wsId).eq("done", false).not("due_date", "is", null).order("due_date");
  const names = new Map<string, string>();
  for (const m of members ?? []) {
    const p = (m as any).profiles;
    names.set(m.user_id, ((p?.display_name || p?.email || "") as string).split(" ")[0]);
  }
  return { ws: ws!, members: members ?? [], tasks: (tasks ?? []) as any[], names };
}

function recipientsFor(ctx: Awaited<ReturnType<typeof loadContext>>): Recipient[] {
  if (ctx.ws.telegram_chat_id) return [{ chat: ctx.ws.telegram_chat_id, userId: null }];
  return ctx.members
    .map((m: any) => ({ chat: m.profiles?.telegram_chat_id as string | null, userId: m.user_id as string }))
    .filter((r) => !!r.chat) as Recipient[];
}

function line(t: any, ctx: any, showDate: boolean, today: string) {
  const who = (t.task_assignees ?? []).map((a: any) => ctx.names.get(a.user_id)).filter(Boolean);
  const bits: string[] = [];
  if (t.priority === 1) bits.push("🔴");
  else if (t.priority === 2) bits.push("🟠");
  let s = `• ${bits.length ? bits.join("") + " " : ""}${esc(t.title)}`;
  const meta: string[] = [];
  if (showDate && t.due_date) meta.push(t.due_date < today ? `venceu ${fmt(t.due_date)}` : fmt(t.due_date));
  if (t.project) meta.push(esc(t.project));
  if (ctx.ws.kind === "trabalho" && t.client) meta.push(esc(t.client));
  if (who.length) meta.push(esc(who.join(", ")));
  if (meta.length) s += ` <i>(${meta.join(" · ")})</i>`;
  return s;
}

function capped(lines: string[], max = 25) {
  return lines.length > max ? [...lines.slice(0, max), `<i>…e mais ${lines.length - max}</i>`] : lines;
}

function buildMessage(rule: Rule, ctx: any, today: string, forUser: string | null) {
  let tasks = ctx.tasks;
  if (rule.only_mine && forUser) tasks = tasks.filter((t: any) => (t.task_assignees ?? []).some((a: any) => a.user_id === forUser));
  const overdue = rule.include_overdue ? tasks.filter((t: any) => t.due_date < today) : [];
  const out: string[] = [];
  if (rule.kind === "daily") {
    const todays = tasks.filter((t: any) => t.due_date === today);
    out.push(`📋 <b>${esc(ctx.ws.name)}</b> · tarefas de hoje`, `<i>${fmtLong(today)}</i>`, "");
    if (!todays.length && !overdue.length) out.push("Nada pendente para hoje. ✅");
    if (todays.length) out.push(`<b>Hoje (${todays.length})</b>`, ...capped(todays.map((t: any) => line(t, ctx, false, today))), "");
    if (overdue.length) out.push(`<b>Atrasadas (${overdue.length})</b>`, ...capped(overdue.map((t: any) => line(t, ctx, true, today)), 15), "");
  } else {
    const start = addDays(today, 1), end = addDays(today, 7);
    const week = tasks.filter((t: any) => t.due_date >= start && t.due_date <= end);
    out.push(`🗓️ <b>${esc(ctx.ws.name)}</b> · próximos 7 dias`, `<i>${fmt(start)} a ${fmt(end)}</i>`, "");
    if (!week.length) out.push("Nenhuma tarefa com prazo nos próximos 7 dias.");
    const byDay = new Map<string, any[]>();
    for (const t of week) { if (!byDay.has(t.due_date)) byDay.set(t.due_date, []); byDay.get(t.due_date)!.push(t); }
    let shown = 0;
    for (const [d, list] of byDay) {
      if (shown >= 40) { out.push(`<i>…e mais ${week.length - shown}</i>`); break; }
      out.push(`<b>${fmtLong(d)}</b>`, ...list.map((t: any) => line(t, ctx, false, today)), "");
      shown += list.length;
    }
    if (overdue.length) out.push(`⚠️ Além disso, <b>${overdue.length}</b> ${overdue.length === 1 ? "tarefa atrasada" : "tarefas atrasadas"}.`, "");
  }
  out.push(`<a href="${APP_URL}">Abrir o app</a>`);
  return out.join("\n").slice(0, 4000);
}

async function runRule(rule: Rule, today: string) {
  const ctx = await loadContext(rule.workspace_id);
  const recipients = recipientsFor(ctx);
  if (!recipients.length) return { rule: rule.id, sent: 0, note: "sem destino: configure o grupo do ambiente ou o chat ID das pessoas" };
  let sent = 0; const errors: string[] = [];
  for (const r of recipients) {
    try { await send(r.chat, buildMessage(rule, ctx, today, r.userId)); sent++; }
    catch (e) { errors.push((e as Error).message); }
  }
  return { rule: rule.id, sent, errors };
}

/* ---------- autenticação de quem chama (modos manuais) ---------- */
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
  const { date: today, hour, weekday } = nowLocal();

  try {
    if (body.mode === "cron") {
      const { data: rules } = await admin.from("notification_rules").select("*").eq("enabled", true);
      const results = [];
      for (const rule of (rules ?? []) as Rule[]) {
        if (rule.last_sent_on === today) continue;
        if (rule.hour > hour) continue;
        if (rule.kind === "weekly" && rule.weekday !== weekday) continue;
        const res = await runRule(rule, today);
        if (res.sent > 0) await admin.from("notification_rules").update({ last_sent_on: today }).eq("id", rule.id);
        results.push(res);
      }
      return json({ ok: true, today, hour, weekday, results });
    }

    const uid = await callerId(req);
    if (!uid) return json({ ok: false, error: "Faça login para usar esta função." }, 401);

    if (body.mode === "test") {
      const { data: rule } = await admin.from("notification_rules").select("*").eq("id", body.rule_id).single();
      if (!rule) return json({ ok: false, error: "Regra não encontrada." }, 404);
      const { data: m } = await admin.from("workspace_members").select("user_id").eq("workspace_id", rule.workspace_id).eq("user_id", uid).maybeSingle();
      if (!m) return json({ ok: false, error: "Você não participa deste ambiente." }, 403);
      const res = await runRule(rule as Rule, today);
      return json({ ok: res.sent > 0, ...res });
    }

    if (body.mode === "hello") {
      const { data: p } = await admin.from("profiles").select("display_name,telegram_chat_id").eq("id", uid).single();
      if (!p?.telegram_chat_id) return json({ ok: false, error: "Salve o seu chat ID no perfil primeiro." }, 400);
      await send(p.telegram_chat_id, `✅ Tudo certo, ${esc((p.display_name || "").split(" ")[0] || "por aqui")}! O app de tarefas vai te mandar as notificações neste chat.\n\n<a href="${APP_URL}">Abrir o app</a>`);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Modo inválido." }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
