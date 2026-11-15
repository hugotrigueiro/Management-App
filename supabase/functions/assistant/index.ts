// Assistente do app: conversa com o Claude sobre as tarefas de um ambiente e propõe mudanças.
// Modos:
//   { mode: "chat", workspace_id, messages: [{role, content}] } -> { reply, proposal? }
//   { mode: "apply", workspace_id, actions } -> aplica as mudanças confirmadas pelo usuário
// As mudanças são gravadas com o login de quem pediu, então as regras de acesso (RLS) valem normalmente.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const API_KEY = ["ANTHROPIC_API_KEY", "ANTROPIC_API_KEY", "anthropic_api_key", "antropic_api_key", "CLAUDE_API_KEY"].map((k) => Deno.env.get(k)).find(Boolean) ?? "";
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

const PRIO: Record<number, string> = { 1: "Urgente", 2: "Alta", 3: "Média", 4: "Baixa" };
const WD = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const br = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "sem prazo");
const clip = (s: string | null, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

type Ctx = {
  ws: { id: string; name: string; kind: string };
  tasks: any[];
  members: { id: string; name: string }[];
  assignees: Map<string, string[]>;
  code: Map<string, string>; // código Tn -> id
  byId: Map<string, any>;
};

async function loadContext(wsId: string): Promise<Ctx> {
  const { data: ws } = await admin.from("workspaces").select("id,name,kind").eq("id", wsId).single();
  const tasks: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("tasks")
      .select("id,title,description,notes,due_date,project,client,priority,done,done_at,repeat_freq")
      .eq("workspace_id", wsId).order("done").order("due_date", { nullsFirst: false }).range(from, from + 999);
    if (error) throw error;
    tasks.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: mem } = await admin.from("workspace_members").select("user_id").eq("workspace_id", wsId);
  const memIds = (mem ?? []).map((m: any) => m.user_id);
  const { data: profs } = memIds.length ? await admin.from("profiles").select("id,display_name,email").in("id", memIds) : { data: [] };
  const pm = new Map((profs ?? []).map((p: any) => [p.id, p.display_name || p.email || "?"]));
  const members = memIds.map((id: string) => ({ id, name: pm.get(id) ?? "?" }));
  const assignees = new Map<string, string[]>();
  const ids = tasks.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await admin.from("task_assignees").select("task_id,user_id").in("task_id", ids.slice(i, i + 300));
    for (const a of data ?? []) assignees.set(a.task_id, [...(assignees.get(a.task_id) ?? []), a.user_id]);
  }
  const code = new Map<string, string>(), byId = new Map<string, any>();
  tasks.forEach((t, i) => { code.set(`T${i + 1}`, t.id); byId.set(t.id, { ...t, code: `T${i + 1}` }); });
  return { ws: ws!, tasks, members, assignees, code, byId };
}

function describeTasks(c: Ctx) {
  const nm = new Map(c.members.map((m) => [m.id, m.name]));
  const work = c.ws.kind === "trabalho";
  const line = (t: any) => {
    const b = c.byId.get(t.id);
    const parts = [b.code, br(t.due_date)];
    if (work) parts.push(`cliente: ${t.client || "-"}`);
    parts.push(`projeto: ${t.project || "-"}`, t.title);
    if (t.priority) parts.push(`prioridade: ${PRIO[t.priority]}`);
    const who = (c.assignees.get(t.id) ?? []).map((u) => nm.get(u) ?? "?");
    if (who.length) parts.push(`responsáveis: ${who.join(", ")}`);
    if (t.repeat_freq) parts.push("recorrente");
    if (t.done) parts.push(`concluída em ${br((t.done_at ?? "").slice(0, 10) || null)}`);
    else {
      const extra = clip([t.description, t.notes].filter(Boolean).join(" / "), 160);
      if (extra) parts.push(`obs: ${extra}`);
    }
    return parts.join(" | ");
  };
  const open = c.tasks.filter((t) => !t.done), done = c.tasks.filter((t) => t.done);
  return `TAREFAS ABERTAS (${open.length}):\n${open.map(line).join("\n") || "(nenhuma)"}\n\n` +
    `TAREFAS CONCLUÍDAS (${done.length}):\n${done.map(line).join("\n") || "(nenhuma)"}`;
}

const TOOL = {
  name: "propor_mudancas",
  description: "Propõe mudanças nas tarefas. Nada é aplicado até o usuário confirmar no app. Use sempre que o usuário pedir para criar, editar, reagendar, concluir ou reabrir tarefas.",
  input_schema: {
    type: "object",
    properties: {
      resumo: { type: "string", description: "Uma frase curta dizendo o que será feito." },
      acoes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: { type: "string", enum: ["criar", "editar", "concluir", "reabrir"] },
            tarefa: { type: "string", description: "Código da tarefa (ex.: T12). Obrigatório exceto em criar." },
            titulo: { type: "string" },
            prazo: { type: ["string", "null"], description: "AAAA-MM-DD, ou null para remover o prazo." },
            projeto: { type: "string" },
            cliente: { type: "string" },
            prioridade: { type: ["integer", "null"], description: "1 Urgente, 2 Alta, 3 Média, 4 Baixa, null sem prioridade." },
            descricao: { type: "string" },
            observacoes: { type: "string" },
            responsaveis: { type: "array", items: { type: "string" }, description: "Nomes dos membros. Substitui a lista atual." },
          },
          required: ["tipo"],
        },
      },
    },
    required: ["resumo", "acoes"],
  },
};

type Action = {
  type: "create" | "update" | "complete" | "reopen";
  task_id?: string; fields: Record<string, unknown>; assignees?: string[]; label: string;
};

function resolveActions(c: Ctx, input: any): { actions: Action[]; problems: string[] } {
  const actions: Action[] = [], problems: string[] = [];
  const memberByName = (n: string) => {
    const k = n.trim().toLowerCase();
    return c.members.find((m) => m.name.toLowerCase() === k) ?? c.members.find((m) => m.name.toLowerCase().split(" ")[0] === k.split(" ")[0]);
  };
  for (const a of input?.acoes ?? []) {
    const fields: Record<string, unknown> = {};
    const changes: string[] = [];
    if (typeof a.titulo === "string" && a.titulo.trim()) { fields.title = a.titulo.trim().slice(0, 300); changes.push(`título "${fields.title}"`); }
    if ("prazo" in a) {
      if (a.prazo === null || a.prazo === "") { fields.due_date = null; changes.push("sem prazo"); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(a.prazo)) { fields.due_date = a.prazo; changes.push(`prazo ${br(a.prazo)}`); }
      else problems.push(`Prazo inválido: ${a.prazo}`);
    }
    if (typeof a.projeto === "string") { fields.project = a.projeto.trim(); changes.push(`projeto "${fields.project || "-"}"`); }
    if (typeof a.cliente === "string" && c.ws.kind === "trabalho") { fields.client = a.cliente.trim(); changes.push(`cliente "${fields.client || "-"}"`); }
    if ("prioridade" in a) {
      const p = a.prioridade == null ? null : Number(a.prioridade);
      if (p === null || [1, 2, 3, 4].includes(p)) { fields.priority = p; changes.push(p ? `prioridade ${PRIO[p]}` : "sem prioridade"); }
    }
    if (typeof a.descricao === "string") { fields.description = a.descricao; changes.push("descrição"); }
    if (typeof a.observacoes === "string") { fields.notes = a.observacoes; changes.push("observações"); }
    let assignees: string[] | undefined;
    if (Array.isArray(a.responsaveis)) {
      const found: string[] = []; let missing = false;
      for (const n of a.responsaveis) {
        const m = memberByName(String(n));
        if (m) found.push(m.id); else { missing = true; problems.push(`"${n}" não é membro deste ambiente, então mantive os responsáveis atuais.`); }
      }
      if (!missing) assignees = [...new Set(found)];
    }
    if (assignees) {
      changes.push(`responsáveis: ${assignees.length ? assignees.map((id) => c.members.find((m) => m.id === id)!.name).join(", ") : "ninguém"}`);
    }
    if (a.tipo === "criar") {
      if (!fields.title) { problems.push("Tarefa nova sem título."); continue; }
      actions.push({ type: "create", fields, assignees, label: `Criar "${fields.title}"${changes.length > 1 ? ` (${changes.slice(1).join(", ")})` : ""}` });
      continue;
    }
    const id = c.code.get(String(a.tarefa ?? "").toUpperCase().trim());
    if (!id) { problems.push(`Tarefa ${a.tarefa ?? "?"} não encontrada.`); continue; }
    const t = c.byId.get(id);
    if (a.tipo === "concluir") actions.push({ type: "complete", task_id: id, fields: {}, label: `Concluir "${t.title}"` });
    else if (a.tipo === "reabrir") actions.push({ type: "reopen", task_id: id, fields: {}, label: `Reabrir "${t.title}"` });
    else if (a.tipo === "editar" && (changes.length || assignees)) actions.push({ type: "update", task_id: id, fields, assignees, label: `"${t.title}": ${changes.join(", ")}` });
  }
  return { actions, problems };
}

async function chat(c: Ctx, messages: { role: string; content: string }[]) {
  if (!API_KEY) throw new Error("Chave da API da Anthropic não encontrada nos segredos do Supabase (esperado ANTHROPIC_API_KEY).");
  const today = todayLocal();
  const wd = WD[new Date(today + "T12:00:00Z").getUTCDay()];
  const system = `Você é o assistente do app de tarefas do usuário. Ambiente atual: "${c.ws.name}" (${c.ws.kind === "trabalho" ? "trabalho, com clientes" : "pessoal"}).
Hoje é ${wd}, ${br(today)} (horário de Brasília). Membros do ambiente: ${c.members.map((m) => m.name).join(", ")}.

Como responder:
- Português do Brasil, direto e curto. Use listas curtas quando ajudar. Nunca use travessão (—).
- Para análises, baseie-se só nos dados abaixo. Se faltar informação, diga.
- Cite tarefas pelo título (e cliente quando for trabalho), nunca pelo código Tn.
- Quando o usuário pedir para criar, editar, reagendar, concluir ou reabrir tarefas, chame a ferramenta propor_mudancas com todas as ações de uma vez. As mudanças só acontecem quando ele confirmar no app, então não diga que já fez.
- Você não pode apagar tarefas. Se pedirem, explique e sugira concluir.
- Datas relativas ("amanhã", "segunda que vem") devem virar AAAA-MM-DD a partir de hoje.

${describeTasks(c)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2500,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [TOOL], messages,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Claude respondeu com erro: ${body.error?.message || r.status}`);
  const text = (body.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  const use = (body.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL.name);
  if (!use) return { reply: text || "Não consegui responder agora." };
  const { actions, problems } = resolveActions(c, use.input);
  return {
    reply: text || use.input?.resumo || "Preparei estas mudanças:",
    proposal: actions.length ? { summary: use.input?.resumo ?? "", actions } : null,
    problems,
  };
}

async function apply(userJwt: string, c: Ctx, actions: Action[]) {
  const sb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });
  const allowed = new Set(["title", "due_date", "project", "client", "priority", "description", "notes"]);
  const clean = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => allowed.has(k)));
  const memberIds = new Set(c.members.map((m) => m.id));
  let done = 0; const errors: string[] = [];
  for (const a of actions.slice(0, 200)) {
    try {
      if (a.type !== "create" && !c.byId.has(a.task_id!)) throw new Error("tarefa não pertence a este ambiente");
      const people = a.assignees?.filter((id) => memberIds.has(id));
      let taskId = a.task_id;
      if (a.type === "create") {
        const { data, error } = await sb.from("tasks").insert({ ...clean(a.fields), workspace_id: c.ws.id }).select("id").single();
        if (error) throw error; taskId = data.id;
      } else if (a.type === "update") {
        const f = clean(a.fields);
        if (Object.keys(f).length) { const { error } = await sb.from("tasks").update(f).eq("id", taskId); if (error) throw error; }
      } else {
        const { error } = await sb.from("tasks").update({ done: a.type === "complete" }).eq("id", taskId);
        if (error) throw error;
      }
      if (people) {
        if (a.type !== "create") { const { error } = await sb.from("task_assignees").delete().eq("task_id", taskId); if (error) throw error; }
        if (people.length) { const { error } = await sb.from("task_assignees").insert(people.map((u) => ({ task_id: taskId, user_id: u }))); if (error) throw error; }
      }
      done++;
    } catch (e) { errors.push(`${a.label}: ${(e as Error).message}`); }
  }
  return { ok: errors.length === 0, applied: done, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ ok: false, error: "Faça login para usar o assistente." }, 401);
    const { data: m } = await admin.from("workspace_members").select("user_id").eq("workspace_id", body.workspace_id).eq("user_id", uid).maybeSingle();
    if (!m) return json({ ok: false, error: "Você não participa deste ambiente." }, 403);
    const c = await loadContext(body.workspace_id);
    if (body.mode === "chat") {
      const msgs = (Array.isArray(body.messages) ? body.messages : [])
        .filter((x: any) => (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim())
        .slice(-16).map((x: any) => ({ role: x.role, content: x.content.slice(0, 8000) }));
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      for (let i = msgs.length - 1; i > 0; i--) if (msgs[i].role === msgs[i - 1].role) { msgs[i - 1].content += "\n\n" + msgs[i].content; msgs.splice(i, 1); }
      if (msgs.length && msgs[msgs.length - 1].role !== "user") return json({ ok: false, error: "A última mensagem precisa ser sua." }, 400);
      if (!msgs.length) return json({ ok: false, error: "Mensagem vazia." }, 400);
      return json({ ok: true, ...(await chat(c, msgs)) });
    }
    if (body.mode === "apply") {
      if (!Array.isArray(body.actions) || !body.actions.length) return json({ ok: false, error: "Nada para aplicar." }, 400);
      return json(await apply(jwt, c, body.actions));
    }
    return json({ ok: false, error: "Modo inválido." }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
