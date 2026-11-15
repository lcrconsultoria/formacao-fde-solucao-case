/** Testes do cliente do Claude (#171), com o fetch falso: autenticação plugável, tool use, prazo, falhas e segredo. */
import { describe, expect, it } from 'vitest';
import {
  ClaudeClient,
  ClaudeError,
  DEFAULT_MODEL,
  credentialsFromEnv,
  type ClaudeCredentials,
  type FetchFn,
  type Tool,
} from '../../src/claude/client.js';
import { runClaudeRound } from '../../src/claude/cron.js';
import type { SupabaseRest } from '../../src/connectors/supabase-rest.js';

const SCHEMA = { type: 'object', properties: { match: { type: ['string', 'null'] } }, required: ['match'] };
const OAUTH: ClaudeCredentials = { kind: 'oauth', token: 'tok-secreto-oauth' };
const KEY: ClaudeCredentials = { kind: 'api-key', apiKey: 'sk-secreta-api' };

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function json(content: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ content }), { status });
}
const answer = (input: unknown) => ({ type: 'tool_use', id: 'tu_final', name: 'responder', input });

function scripted(responses: (() => Response | Promise<Response>)[]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchFn = async (url, init) => {
    calls.push({
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!next) throw new Error('sem resposta roteirizada');
    return next();
  };
  return { fetch, calls };
}

const ask = (client: ClaudeClient) => client.ask<{ match: string | null }>({ system: 'sistema', prompt: 'pergunta', schema: SCHEMA });

describe('credentialsFromEnv (#171)', () => {
  it('a chave da API (plano B) tem prioridade sobre o setup token', () => {
    expect(credentialsFromEnv({ BARTE_ACADEMY_ANTHROPIC_API_KEY: ' k ', BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({ kind: 'api-key', apiKey: 'k' });
  });
  it('sem a chave, usa o setup token', () => {
    expect(credentialsFromEnv({ BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({ kind: 'oauth', token: 't' });
  });
  it('sem nenhuma das duas (ou em branco), undefined', () => {
    expect(credentialsFromEnv({})).toBeUndefined();
    expect(credentialsFromEnv({ BARTE_ACADEMY_ANTHROPIC_API_KEY: '  ' })).toBeUndefined();
  });
});

describe('ClaudeClient: autenticação (#171)', () => {
  it('#credencial/AC-1 com as duas variáveis no ambiente, o fetch recebe x-api-key e nenhum authorization nem anthropic-beta', async () => {
    const credentials = credentialsFromEnv({ BARTE_ACADEMY_ANTHROPIC_API_KEY: 'sk-secreta-api', BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'tok-secreto-oauth' });
    expect(credentials).toBeDefined();
    const { fetch, calls } = scripted([() => json([answer({ match: null })])]);
    await ask(new ClaudeClient({ credentials: credentials as ClaudeCredentials, fetch }));
    expect(calls[0]?.headers).toMatchObject({ 'x-api-key': 'sk-secreta-api' });
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    expect(calls[0]?.headers).not.toHaveProperty('anthropic-beta');
  });

  it('setup token: Bearer, cabeçalho beta e o começo de system do Claude Code', async () => {
    const { fetch, calls } = scripted([() => json([answer({ match: 'x' })])]);
    await expect(ask(new ClaudeClient({ credentials: OAUTH, fetch }))).resolves.toEqual({ match: 'x' });
    const [call] = calls;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.headers).toMatchObject({ authorization: 'Bearer tok-secreto-oauth', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' });
    expect(call?.headers).not.toHaveProperty('x-api-key');
    expect((call?.body.system as { text: string }[])[0]?.text).toContain('Claude Code');
    expect((call?.body.system as { text: string }[])[1]?.text).toBe('sistema');
  });

  it('chave da API: x-api-key, sem Bearer nem beta, e system sem o prefixo', async () => {
    const { fetch, calls } = scripted([() => json([answer({ match: null })])]);
    await ask(new ClaudeClient({ credentials: KEY, fetch }));
    const [call] = calls;
    expect(call?.headers).toMatchObject({ 'x-api-key': 'sk-secreta-api' });
    expect(call?.headers).not.toHaveProperty('authorization');
    expect(call?.headers).not.toHaveProperty('anthropic-beta');
    expect(call?.body.system).toEqual([{ type: 'text', text: 'sistema' }]);
  });

  it('pede a saída estruturada pela tool responder, forçada, no modelo padrão', async () => {
    const { fetch, calls } = scripted([() => json([answer({ match: 'x' })])]);
    await ask(new ClaudeClient({ credentials: KEY, fetch }));
    expect(calls[0]?.body).toMatchObject({
      model: DEFAULT_MODEL,
      tool_choice: { type: 'tool', name: 'responder' },
      tools: [{ name: 'responder', input_schema: SCHEMA }],
      messages: [{ role: 'user', content: 'pergunta' }],
    });
  });
});

describe('ClaudeClient: laço de tool use (#171)', () => {
  const lookup = (handler: Tool['handler']): Tool => ({ name: 'buscar_nota', description: 'busca', input_schema: { type: 'object' }, handler });

  it('roda a tool pedida, devolve o resultado ao modelo e termina na resposta', async () => {
    const { fetch, calls } = scripted([
      () => json([{ type: 'tool_use', id: 'tu_1', name: 'buscar_nota', input: { chave: 'N1' } }]),
      () => json([answer({ match: 'ok' })]),
    ]);
    const seen: unknown[] = [];
    const client = new ClaudeClient({ credentials: KEY, fetch });
    const out = await client.converse({ system: 's', prompt: 'p', schema: SCHEMA, tools: [lookup(async (i) => (seen.push(i), { total: 10 }))] });
    expect(out).toEqual({ match: 'ok' });
    expect(seen).toEqual([{ chave: 'N1' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.tool_choice).toEqual({ type: 'any' });
    const last = (calls[1]?.body.messages as { role: string; content: unknown }[]).at(-1);
    expect(last).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"total":10}' }] });
  });

  it('a falha do handler volta ao modelo como erro genérico, sem o texto dela', async () => {
    const { fetch, calls } = scripted([
      () => json([{ type: 'tool_use', id: 'tu_1', name: 'buscar_nota', input: {} }]),
      () => json([answer({ match: null })]),
    ]);
    await new ClaudeClient({ credentials: KEY, fetch }).converse({
      system: 's', prompt: 'p', schema: SCHEMA,
      tools: [lookup(async () => { throw new Error('senha-do-banco'); })],
    });
    const last = JSON.stringify(calls[1]?.body.messages);
    expect(last).toContain('falha ao executar a tool');
    expect(last).not.toContain('senha-do-banco');
  });

  it('tool que o modelo inventou volta como erro, sem rodar nada', async () => {
    const { fetch, calls } = scripted([
      () => json([{ type: 'tool_use', id: 'tu_1', name: 'apagar_tudo', input: {} }]),
      () => json([answer({ match: null })]),
    ]);
    await new ClaudeClient({ credentials: KEY, fetch }).converse({ system: 's', prompt: 'p', schema: SCHEMA, tools: [lookup(async () => 1)] });
    expect(JSON.stringify(calls[1]?.body.messages)).toContain('"is_error":true');
  });

  it('passar do teto de voltas é falha', async () => {
    const { fetch } = scripted([() => json([{ type: 'tool_use', id: 'tu', name: 'buscar_nota', input: {} }])]);
    const client = new ClaudeClient({ credentials: KEY, fetch });
    const error = await client.converse({ system: 's', prompt: 'p', schema: SCHEMA, tools: [lookup(async () => 1)], maxTurns: 3 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ClaudeError', kind: 'format' });
    expect(client.calls).toBe(3);
    expect(client.failures).toBe(1);
  });
});

describe('ClaudeClient: falhas (#171)', () => {
  it('#credencial/AC-4 429 com retry-after vira rate_limit global, conta a falha e não leva segredo nem corpo', async () => {
    const { fetch } = scripted([() => new Response('{"error":"tok-secreto-oauth corpo"}', { status: 429, headers: { 'retry-after': '30' } })]);
    const client = new ClaudeClient({ credentials: OAUTH, fetch });
    const error = (await ask(client).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error).toMatchObject({ kind: 'rate_limit', status: 429, isGlobal: true });
    expect(error.message).toBe('claude: HTTP 429 (limite de uso)');
    expect(client.failures).toBe(1);
  });

  it('#credencial/AC-3 429 sem retry-after com o setup token é credencial bloqueada, global, sem token nem corpo', async () => {
    const { fetch } = scripted([() => new Response('{"error":"tok-secreto-oauth corpo"}', { status: 429 })]);
    const client = new ClaudeClient({ credentials: OAUTH, fetch });
    const error = (await ask(client).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toMatchObject({ kind: 'rate_limit', status: 429, isGlobal: true });
    expect(error.message).toContain('credencial bloqueada');
    expect(error.message).not.toContain('limite de uso');
    expect(error.message).not.toContain('tok-secreto-oauth');
    expect(error.message).not.toContain('corpo');
    expect(client.failures).toBe(1);
  });

  it('#credencial/AC-3 429 com retry-after com o setup token continua limite de uso passageiro', async () => {
    const { fetch } = scripted([() => new Response('', { status: 429, headers: { 'retry-after': '30' } })]);
    const error = (await ask(new ClaudeClient({ credentials: OAUTH, fetch })).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toMatchObject({ kind: 'rate_limit', isGlobal: true });
    expect(error.message).toBe('claude: HTTP 429 (limite de uso)');
  });

  it('#credencial/AC-3 429 sem retry-after com a chave da API continua limite de uso, sem a chave na mensagem', async () => {
    const { fetch } = scripted([() => new Response('', { status: 429 })]);
    const error = (await ask(new ClaudeClient({ credentials: KEY, fetch })).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toMatchObject({ kind: 'rate_limit', isGlobal: true });
    expect(error.message).toBe('claude: HTTP 429 (limite de uso)');
    expect(error.message).not.toContain('sk-secreta-api');
  });

  it('#credencial/AC-4 401 vira auth, global', async () => {
    const { fetch } = scripted([() => new Response('', { status: 401 })]);
    expect(await ask(new ClaudeClient({ credentials: OAUTH, fetch })).catch((e: unknown) => e)).toMatchObject({ kind: 'auth', isGlobal: true });
  });

  it('500 é falha do item, não global', async () => {
    const { fetch } = scripted([() => new Response('', { status: 500 })]);
    expect(await ask(new ClaudeClient({ credentials: OAUTH, fetch })).catch((e: unknown) => e)).toMatchObject({ kind: 'api', isGlobal: false });
  });

  it('falha de rede vira network, sem o texto do erro original', async () => {
    const fetch: FetchFn = async () => { throw new Error('connect https://api.anthropic.com com tok-secreto-oauth'); };
    const error = (await ask(new ClaudeClient({ credentials: OAUTH, fetch })).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).not.toContain('tok-secreto-oauth');
  });

  it('resposta sem tool_use, ou que não é JSON, é erro de formato', async () => {
    const a = scripted([() => json([{ type: 'text', text: 'oi' }])]);
    expect(await ask(new ClaudeClient({ credentials: KEY, fetch: a.fetch })).catch((e: unknown) => e)).toMatchObject({ kind: 'format' });
    const b = scripted([() => new Response('não é json', { status: 200 })]);
    expect(await ask(new ClaudeClient({ credentials: KEY, fetch: b.fetch })).catch((e: unknown) => e)).toMatchObject({ kind: 'format' });
  });

  it('o prazo aborta o pedido e vira timeout', async () => {
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
      });
    const error = await ask(new ClaudeClient({ credentials: KEY, fetch, timeoutMs: 20 })).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout' });
  });
});

describe('runClaudeRound: o Cron falha fechado (#171)', () => {
  const rest = (calls: string[]): SupabaseRest =>
    ({
      select: async (table: string) => { calls.push(`select ${table}`); return []; },
      insert: async () => { calls.push('insert'); return []; },
      upsert: async () => { calls.push('upsert'); return []; },
    }) as unknown as SupabaseRest;

  it('#credencial/AC-4 sem credencial, pula e registra uma linha', async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const round = await runClaudeRound(rest(calls), {}, { log: (l) => lines.push(l) });
    expect(round).toEqual({ ran: false, failedTasks: [], failures: 0 });
    expect(calls).toEqual([]);
    expect(lines).toEqual(['cron: sem credencial do Claude; tarefas do Claude puladas e a regra decide sozinha']);
  });

  it('#credencial/AC-3 #credencial/AC-4 429 sem retry-after do setup token: a rodada para, nenhuma linha gasta tentativa e o log diz credencial bloqueada sem segredo', async () => {
    const { runTasks } = await import('../../src/claude/runner.js');
    const { fetch } = scripted([() => new Response('', { status: 429 })]);
    const client = new ClaudeClient({ credentials: OAUTH, fetch });
    const upserts: unknown[] = [];
    const db = { select: async () => [], upsert: async (...args: unknown[]) => (upserts.push(args), []) };
    const task = {
      name: 'teste',
      pending: async () => ({ requests: ['a', 'b'].map((key) => ({ key, input: key })), dropped: 0 }),
      run: async (_input: unknown, askClaude: typeof client.ask) => askClaude({ system: 's', prompt: 'p', schema: SCHEMA }),
    };
    const lines: string[] = [];
    const result = await runTasks({ db, ask: client.ask, tasks: [task], log: (l) => lines.push(l), secrets: ['tok-secreto-oauth'] });
    expect(client.calls).toBe(1);
    expect(upserts).toHaveLength(0);
    expect(result.failedTasks).toEqual(['teste']);
    expect(lines.join('\n')).toContain('credencial bloqueada');
    expect(lines.join('\n')).toContain('a regra decide sozinha');
    expect(lines.join('\n')).not.toContain('tok-secreto-oauth');
  });

  it('com o banco falhando, não lança e não vaza o texto do erro', async () => {
    const lines: string[] = [];
    const broken = { select: async () => { throw new Error('tok-secreto-oauth no meio'); } } as unknown as SupabaseRest;
    const round = await runClaudeRound(broken, { BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'tok-secreto-oauth' }, { log: (l) => lines.push(l) });
    expect(round.ran).toBe(true);
    expect(lines.join('\n')).not.toContain('tok-secreto-oauth');
  });

  it('um Claude lento não segura a rodada: passado o prazo, para e deixa o resto', async () => {
    let now = new Date('2026-11-15T12:00:00Z').getTime();
    const asked: string[] = [];
    const { runTasks } = await import('../../src/claude/runner.js');
    const db = { select: async () => [], upsert: async () => [] };
    const slow = {
      name: 'lenta',
      pending: async () => ({ requests: ['a', 'b', 'c'].map((key) => ({ key, input: key })), dropped: 0 }),
      run: async (input: unknown) => {
        asked.push(String(input));
        now += 60_000; // cada pergunta leva 1 min
        return { r: 1 };
      },
    };
    const lines: string[] = [];
    await runTasks({ db, ask: async () => ({}) as never, tasks: [slow], log: (l) => lines.push(l), now: () => new Date(now), deadline: now + 90_000 });
    expect(asked).toEqual(['a', 'b']);
    expect(lines[0]).toContain('orçamento da rodada esgotado');
  });

  it('o erro do Supabase gravado leva só operação, tabela e status, sem o corpo', async () => {
    const { storedError } = await import('../../src/claude/runner.js');
    const { SupabaseRestError } = await import('../../src/connectors/supabase-rest.js');
    const text = storedError(new SupabaseRestError('select', 'kit_notas', 500, 'corpo-com-dado'));
    expect(text).toContain('HTTP 500');
    expect(text).not.toContain('corpo-com-dado');
  });

  it('uma rodada com a fila cheia gasta no máximo 2 subrequests por pedido, dentro dos 50 do plano gratuito', async () => {
    const { runTasks } = await import('../../src/claude/runner.js');
    const { CRON_LIMIT } = await import('../../src/claude/cron.js');
    let subrequests = 0;
    const db = {
      select: async () => (subrequests += 1, []),
      upsert: async () => (subrequests += 1, []),
    };
    const full = (name: string) => ({
      name,
      pending: async () => ({ requests: Array.from({ length: 30 }, (_, i) => ({ key: `${name}${i}`, input: i })), dropped: 0 }),
      run: async () => (subrequests += 1, { r: 1 }),
    });
    await runTasks({ db, ask: async () => ({}) as never, tasks: [full('a'), full('b')], log: () => {}, limit: CRON_LIMIT });
    expect(subrequests).toBeLessThanOrEqual(2 * 2 * CRON_LIMIT + 7);
    expect(2 * 2 * CRON_LIMIT + 7).toBeLessThan(50);
  });
});
