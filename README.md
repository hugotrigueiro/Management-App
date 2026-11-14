# Tarefas (Management App)

App de tarefas de casa e trabalho para poucas pessoas, com ambientes, membros e responsáveis.

- **Frontend:** HTML, CSS e JavaScript puros (sem etapa de build), publicado no GitHub Pages.
- **Backend:** Supabase (Postgres com RLS, login Google, tempo real).
- **Instalação no celular:** abra o site e use "Adicionar à tela inicial" (PWA).

## Estrutura
- `index.html`: telas e formulários.
- `css/app.css`: estilos (tema claro e escuro).
- `js/config.js`: URL e chave pública do Supabase.
- `js/app.js`: lógica do app.

## Segurança
Quem protege os dados são as regras do banco (RLS): cada pessoa só lê e grava tarefas dos ambientes de que é membro.
A chave em `js/config.js` é a chave pública ("anon") e pode ficar no código.
Nunca coloque neste repositório a chave `service_role`, a senha do banco ou o token do bot do Telegram.
