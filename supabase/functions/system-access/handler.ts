// Contrato público mínimo. Erros nunca são decisões de suspensão.
export function createHandler(lookup: (key: string) => Promise<unknown>) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const params = new URL(req.url).searchParams;
    const key = params.get('key');
    if ([...params.keys()].some(k => k !== 'key') || params.getAll('key').length !== 1 ||
      !key || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      return json({ error: 'invalid_key' }, 400);
    }
    try {
      const result = await lookup(key) as Record<string, unknown> | null;
      if (result === null) return json({ error: 'system_not_found' }, 404);
      if (!result || !['active', 'grace', 'suspended'].includes(String(result.status)) ||
        result.allowed !== (result.status !== 'suspended') ||
        typeof result.checked_at !== 'string' || !Number.isFinite(Date.parse(result.checked_at)) ||
        (result.status === 'grace' && (!Number.isInteger(result.grace_days_remaining) || Number(result.grace_days_remaining) < 0))) {
        throw new Error('invalid_rpc_response');
      }
      // Whitelist: mesmo que o RPC mude, nenhum dado privado chega ao público.
      return json({ allowed: result.allowed, status: result.status,
        ...(result.status === 'grace' ? { grace_days_remaining: result.grace_days_remaining } : {}),
        checked_at: result.checked_at });
    } catch {
      return json({ error: 'service_unavailable' }, 503);
    }
  };
}
