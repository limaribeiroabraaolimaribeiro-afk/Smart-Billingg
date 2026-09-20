import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHandler } from './handler.ts';

Deno.serve(createHandler(async (key) => {
  const url = Deno.env.get('SUPABASE_URL');
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !secret) throw new Error('missing_configuration');
  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc('get_system_access', { p_key: key })
    .abortSignal(AbortSignal.timeout(8000));
  if (error) throw error;
  return data;
}));
