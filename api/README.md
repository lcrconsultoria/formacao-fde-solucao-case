# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health`, `GET /me` e `GET /api/valor-barrado` e a tela de `web/` (atrás do Cloudflare Access, #60; o
painel está em `src/panel/README.md`) e tem um Cron a cada 15 minutos que só
registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
BARTE_ACADEMY_ANTHROPIC_API_KEY=...
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=barte-academy.cloudflareaccess.com
```

## O Claude no Worker (#171)

O Cron chama o Claude pela Messages API (`src/claude/`), no começo de cada rodada, e grava as sugestões em
`claude_suggestions`. A regra determinística confirma cada uma; sem sugestão, decide sozinha.

- **Credencial principal:** a chave da API da Anthropic, em `BARTE_ACADEMY_ANTHROPIC_API_KEY` (`x-api-key`). A
  esteira (`deploy-api.yml`) a põe no Worker com `wrangler secret put`, a partir do secret do GitHub de mesmo nome.
- **Caminho secundário:** o setup token do Claude Code, em `BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN`
  (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`), usado só quando a chave não existe. É uso da
  assinatura fora do Claude Code: a Anthropic pode limitar ou bloquear.
- **429 no log do Cron:** `HTTP 429 (limite de uso)` é limite passageiro (com `retry-after`, ou com a chave da
  API): a próxima rodada tenta de novo. `HTTP 429 (credencial bloqueada: ...)` é o setup token sem `retry-after`:
  esperar não resolve, ponha a chave da API no Worker (e no `.dev.vars`).
- **Falha fechada:** sem credencial, com 429 ou 401, a rodada é interrompida, a falha é contada e logada sem
  segredo, e nenhuma linha de erro gasta tentativa. A regra decide sozinha.
- **Tarefas:** `src/claude/tasks/` (`description-match`, #66; `probable-order`, #65). Para acrescentar uma, crie o
  arquivo exportando um `ClaudeTask` e uma linha em `tasks/index.ts`.
- **Eval do casamento de descrição** (fora do gate, precisa da credencial): `npm run eval:description-match`.

## Testar

```bash
npm run typecheck
npm test
```

Na raiz do repositório, `make check` roda os dois junto com o resto do gate.

## Publicar

Não se publica à mão. Cada merge na `main` que mexe em `api/` roda o workflow
`.github/workflows/deploy-api.yml`, que testa e publica com `wrangler deploy`.
Ele também pode ser disparado pela aba Actions, mas só publica a partir da `main`. Os segredos do Worker em
produção entram com `npx wrangler secret put <NOME>`, nunca no git.

## Cloudflare Access

Toda rota, menos `GET /health`, exige o JWT do Cloudflare Access (#54). O Worker lê o token do
cabeçalho `Cf-Access-Jwt-Assertion` ou do cookie `CF_Authorization` e confere a assinatura RS256
contra as chaves do time, o `aud`, o `iss` e a validade. `GET /me` devolve o e-mail de quem entrou.

| Situação | Resposta |
|---|---|
| Sem token (mesmo com as variáveis vazias) | 401 `unauthenticated` |
| Com token, mas `ACCESS_AUD` ou `ACCESS_TEAM_DOMAIN` vazios | 503 `access_not_configured` |
| Token inválido (assinatura, `aud`, `iss`, expirado, kid desconhecido) | 403 `forbidden` |
| Chaves do time fora do ar | 503 `access_unavailable` |

As duas variáveis não são segredo. Em produção, a esteira passa com `wrangler deploy --var`, a
partir das variáveis do repositório `BARTE_ACADEMY_ACCESS_AUD` e `BARTE_ACADEMY_ACCESS_TEAM_DOMAIN`.
Localmente, ficam no `.dev.vars`; sem elas, só o `/health` responde 200.

### Provisionar

Uma vez por conta, no painel da Cloudflare: abra o Zero Trust, crie o time `barte-academy` e
escolha o plano Free. Depois, na raiz do repositório:

```bash
export BARTE_ACADEMY_CLOUDFLARE_API_TOKEN=...   # com permissão de Access: Apps and Policies
export BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID=...
export BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS="aluno1@gmail.com, aluno2@gmail.com"
python3 scripts/cloudflare_access.py --dry-run   # mostra o que enviaria
python3 scripts/cloudflare_access.py
```

O script garante o login por código no e-mail e a aplicação `formacao-fde-solucao-case`, com a
política que libera a `barte.com` e os alunos listados. Rodar de novo atualiza, não duplica. No fim,
imprime `ACCESS_AUD=...` e `ACCESS_TEAM_DOMAIN=...`: são os valores das variáveis do repositório.
