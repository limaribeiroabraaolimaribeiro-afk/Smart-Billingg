'use strict';

require('dotenv').config();

const REQUIRED = ['SUPABASE_URL', 'WHATSAPP_AGENT_FUNCTION_URL', 'WHATSAPP_AGENT_TOKEN', 'COMPANY_ID'];
const missing = REQUIRED.filter((key) => !process.env[key] || !process.env[key].trim());

if (missing.length) {
  console.error('\n[Smart Billing Agent] Configuração incompleta.');
  console.error(`Faltam preencher no .env: ${missing.join(', ')}`);
  console.error('Copie .env.example para .env e preencha os valores (veja README.md).\n');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(process.env.COMPANY_ID.trim())) {
  console.error('\n[Smart Billing Agent] COMPANY_ID inválido — precisa ser o UUID da empresa no Supabase.\n');
  process.exit(1);
}

module.exports = {
  supabaseUrl: process.env.SUPABASE_URL.trim().replace(/\/+$/, ''),
  agentFunctionUrl: process.env.WHATSAPP_AGENT_FUNCTION_URL.trim().replace(/\/+$/, ''),
  agentToken: process.env.WHATSAPP_AGENT_TOKEN.trim(),
  companyId: process.env.COMPANY_ID.trim(),
  publicAppUrl: (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, ''),
  pollIntervalMs: Math.max(2000, Number(process.env.POLL_INTERVAL_MS) || 5000),
  port: Number(process.env.PORT) || 3210,
};
