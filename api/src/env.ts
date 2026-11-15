/** #59 Bindings e segredos que o Worker recebe. Os valores nunca ficam no git. */
export interface Env {
  /** #59 URL do projeto Supabase. Var do Worker (não é segredo); local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_URL?: string;
  /** #59 Chave secreta do Supabase. Em produção via `wrangler secret put`; local, no `.dev.vars`. */
  BARTE_ACADEMY_SUPABASE_SECRET_KEY?: string;
  /**
   * Application Audience (AUD) da aplicação do Cloudflare Access (#54). Não é segredo: a esteira
   * passa com `wrangler deploy --var`, a partir da variável do repositório. Vazio: o Worker fecha.
   */
  ACCESS_AUD?: string;
  /**
   * Domínio do time do Zero Trust, como `barte-academy.cloudflareaccess.com` (#54). A esteira passa
   * com `wrangler deploy --var`. Aceita `https://` na frente e barra no fim. Vazio: o Worker fecha.
   */
  ACCESS_TEAM_DOMAIN?: string;
  /**
   * Os arquivos da tela (web/dist, #60), servidos depois do Access. Ausente nos testes e num Worker
   * publicado sem a tela: aí todo caminho fora das rotas da API responde 404.
   */
  ASSETS?: Fetcher;
  /**
   * #63 Nível de aprovação de cada pessoa, JSON de e-mail para nível (`analista`, `coordenacao`,
   * `diretoria`). Não é segredo: a esteira passa com `wrangler deploy --var`. Vazio: ninguém aprova.
   */
  APPROVER_LEVELS?: string;
  /**
   * #174 E-mails dos administradores, um JSON de lista (`["ana@jachegou.com.br"]`). Não é segredo: a
   * esteira passa com `wrangler deploy --var`. Vazio: ninguém administra (fail-closed).
   */
  BARTE_ACADEMY_ADMIN_EMAILS?: string;
  /**
   * #171 Setup token do Claude Code, secret do Worker: caminho secundário, usado só sem a chave da API. Chama a
   * Messages API com `Authorization: Bearer` e `anthropic-beta: oauth-2025-04-20`. Em produção via
   * `wrangler secret put`; local, no `.dev.vars`. A Anthropic pode barrá-lo: um 429 sem `retry-after` no log
   * do Cron é a credencial bloqueada, e a saída é pôr a chave da API. Sem ele (e sem a chave), o Cron pula
   * as tarefas do Claude e a regra decide sozinha.
   */
  BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN?: string;
  /**
   * #171 Credencial principal: chave da API da Anthropic (`x-api-key`), secret do Worker. Se existir, tem
   * prioridade sobre o setup token; trocar de via muda só o secret, não o código.
   */
  BARTE_ACADEMY_ANTHROPIC_API_KEY?: string;
}
