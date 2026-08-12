'use strict';

// ============================================================================
// PM2 — Smart Billing Worker (WhatsApp 24/7 + cobrança automática)
// ----------------------------------------------------------------------------
// Uso futuro, na VPS (dentro desta pasta):
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup
//
// NENHUM segredo fica neste arquivo — todas as credenciais (SUPABASE_URL,
// WHATSAPP_AGENT_TOKEN, COMPANY_ID, etc.) continuam vindo exclusivamente de
// ".env" (carregado pelo dotenv dentro de src/config.js), nunca commitado.
//
// instances: 1 é OBRIGATÓRIO — o worker mantém UMA sessão de WhatsApp
// (LocalAuth) e UM scheduler de cobrança por processo. Rodar mais de uma
// instância abriria duas sessões concorrentes do mesmo número e duplicaria
// os ciclos do scheduler.
// ============================================================================

module.exports = {
  apps: [
    {
      name: 'smart-billing-worker',
      script: './src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      // Tempo dado ao processo para tratar SIGTERM (ver shutdown() em
      // src/index.js) antes do PM2 mandar SIGKILL — precisa ser maior que o
      // timeout de segurança interno do worker (10s) para o encerramento
      // gracioso ter chance de terminar sozinho.
      kill_timeout: 12_000,
      // Evita ficar reiniciando em loop apertado se o processo cair repetidas
      // vezes logo na inicialização (ex.: .env mal configurado).
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 5_000,
      env: {
        NODE_ENV: 'production',
      },
      time: true, // prefixa cada linha de log com timestamp do PM2
    },
  ],
};
