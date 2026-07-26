/* ==========================================================================
   Smart Billing — Configurações page logic
   ========================================================================== */

(async function initConfiguracoes() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  await SBLayout.mount({
    active: 'configuracoes',
    title: 'Configurações',
    breadcrumb: 'Painel <span>/</span> Configurações',
    hidePrimaryAction: true,
  });

  const content = document.getElementById('settings-content');
  const menu = document.getElementById('settings-menu');
  let empresa = null;

  try {
    empresa = await DB.empresa.get();
  } catch (err) {
    empresa = null;
  }

  // ---------------- Agente de WhatsApp (Configurações → WhatsApp) ----------------
  let waState = null;
  let waSettings = null;
  let waHistory = [];
  let waPollTimer = null;

  const WA_STATUS_META = {
    offline: { label: 'Agente desconectado', tone: 'pending' },
    starting: { label: 'Iniciando...', tone: 'pending' },
    qr_required: { label: 'Aguardando leitura do QR Code', tone: 'pending' },
    authenticated: { label: 'Autenticando...', tone: 'pending' },
    ready: { label: 'WhatsApp conectado', tone: 'paid' },
    disconnected: { label: 'Desconectado', tone: 'overdue' },
    error: { label: 'Erro na conexão', tone: 'overdue' },
  };
  const WA_JOB_LABEL = { pending: 'Na fila', processing: 'Enviando', sent: 'Enviado', failed: 'Falhou', cancelled: 'Cancelado' };
  const WA_JOB_TONE = { pending: 'pending', processing: 'pending', sent: 'paid', failed: 'overdue', cancelled: 'canceled' };
  const WA_TYPE_LABEL = { charge: 'Cobrança', overdue_reminder: 'Lembrete (atraso)', due_soon_reminder: 'Lembrete', receipt: 'Recibo', test: 'Teste', custom: 'Mensagem' };

  function waAgentBaseUrl() {
    const port = localStorage.getItem('sb_wa_agent_port') || '3210';
    return `http://127.0.0.1:${port}`;
  }

  // Chama o agente local diretamente do navegador (só funciona quando esta
  // página está aberta no MESMO computador onde o agente está rodando — é
  // uma limitação inerente de um agente 100% local). Timeout curto para não
  // travar a UI quando o agente não está acessível.
  async function callLocalAgent(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${waAgentBaseUrl()}${path}`, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`O agente respondeu com erro (${res.status}).`);
      return await res.json().catch(() => ({}));
    } catch (err) {
      clearTimeout(timeout);
      throw new Error('Não foi possível falar com o agente local neste computador. Abra o agente e tente novamente.');
    }
  }

  async function loadWhatsappData() {
    try { waState = await DB.whatsapp.getAgentState(); } catch (err) { waState = null; }
    try { waSettings = await DB.whatsapp.getSettings(); } catch (err) { waSettings = null; }
    try { waHistory = await DB.whatsapp.history({ limit: 8 }); } catch (err) { waHistory = []; }
  }

  function stopWaPolling() {
    if (waPollTimer) { clearInterval(waPollTimer); waPollTimer = null; }
  }

  // Atualiza status/QR/histórico a cada 3s enquanto a aba WhatsApp está
  // aberta, para que o QR apareça e o status "conectado" atualize sozinho
  // sem o usuário precisar recarregar a página.
  function startWaPolling() {
    stopWaPolling();
    waPollTimer = setInterval(async () => {
      if (!menu.querySelector('[data-section="whatsapp"]')?.classList.contains('is-active')) {
        stopWaPolling();
        return;
      }
      await loadWhatsappData();
      content.innerHTML = sectionWhatsapp();
      wireWhatsappButtons();
    }, 3000);
  }

  function fieldRow(label, value) {
    return `<div class="field"><label>${label}</label><input class="input" value="${SB_UI.escapeHtml(value || '')}" /></div>`;
  }

  function sectionPerfil() {
    if (!empresa) return errorBlock();
    return `
      <form class="card card-pad" id="form-perfil">
        <div class="card-header__title" style="margin-bottom:4px;">Perfil do administrador</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Suas informações pessoais de acesso</div>
        <div class="field-row">
          ${fieldRow('Nome completo', empresa.admin.nome).replace('<input', '<input id="perfil-nome"')}
          ${fieldRow('Cargo', empresa.admin.cargo).replace('<input', `<input id="perfil-cargo" ${window.SMART_BILLING_CONFIG?.useDemoMode ? '' : 'disabled title="O cargo é definido pela sua função na empresa e não pode ser editado aqui."'}`)}
        </div>
        <div class="field-row" style="margin-top:16px;">
          <div class="field">
            <label>E-mail de acesso</label>
            <input class="input" id="perfil-email" type="email" value="${SB_UI.escapeHtml(empresa.admin.email)}" />
          </div>
          <div class="field">
            <label>WhatsApp</label>
            <input class="input" id="perfil-telefone" placeholder="(47) 99999-9999" value="${SB_UI.escapeHtml(empresa.admin.telefone || '')}" />
          </div>
        </div>
        <p class="field-hint" style="margin-top:10px;">Usado para receber a "mensagem de teste" do agente de WhatsApp, em Configurações → WhatsApp.</p>
        <button type="submit" class="btn btn-primary" style="margin-top:20px;">Salvar alterações</button>
      </form>`;
  }

  function sectionEmpresa() {
    if (!empresa) return errorBlock();
    return `
      <form class="card card-pad" id="form-empresa">
        <div class="card-header__title" style="margin-bottom:4px;">Dados da empresa</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Essas informações aparecem nas cobranças e recibos enviados aos clientes</div>
        <div class="field">
          <label>Razão social</label>
          <input class="input" id="empresa-nome" value="${SB_UI.escapeHtml(empresa.nome)}" />
        </div>
        <div class="field-row" style="margin-top:16px;">
          <div class="field"><label>CNPJ</label><input class="input" id="empresa-cnpj" value="${SB_UI.escapeHtml(empresa.cnpj)}" /></div>
          <div class="field"><label>Telefone</label><input class="input" id="empresa-telefone" value="${SB_UI.escapeHtml(empresa.telefone)}" /></div>
        </div>
        <div class="field" style="margin-top:16px;">
          <label>E-mail financeiro</label>
          <input class="input" id="empresa-email" type="email" value="${SB_UI.escapeHtml(empresa.email)}" />
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:20px;">Salvar alterações</button>
      </form>`;
  }

  function integrationCard({ title, desc, icon, configured, fields }) {
    return `
      <div class="card card-pad">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;">
          <div style="display:flex;gap:12px;align-items:center;">
            <span class="stat-card__icon stat-card__icon--brand" style="width:38px;height:38px;">${icon}</span>
            <div>
              <div class="card-header__title" style="font-size:14px;">${title}</div>
              <div class="card-header__subtitle">${desc}</div>
            </div>
          </div>
          <span class="badge ${configured ? 'badge-paid' : 'badge-pending'}">${configured ? 'Configurado' : 'Não configurado'}</span>
        </div>
        ${fields}
      </div>`;
  }

  function sectionIntegracoes() {
    const cfg = window.SMART_BILLING_CONFIG || {};
    return `
      <div style="display:flex;flex-direction:column;gap:20px;">
        ${integrationCard({
          title: 'Supabase',
          desc: 'Banco de dados e autenticação',
          icon: SB_ICON.package,
          configured: Boolean(cfg.supabase?.url),
          fields: `
            <div class="field-row">
              <div class="field"><label>URL do projeto</label><input class="input" placeholder="https://xxxx.supabase.co" value="${SB_UI.escapeHtml(cfg.supabase?.url || '')}" disabled /></div>
              <div class="field"><label>Chave anônima (anon key)</label><input class="input" type="password" placeholder="••••••••••••••••" disabled /></div>
            </div>
            <p class="field-hint" style="margin-top:10px;">As credenciais devem ser definidas por variáveis de ambiente no ambiente de produção — nunca diretamente no código-fonte.</p>`,
        })}
        ${integrationCard({
          title: 'InfinitePay',
          desc: 'Processamento de pagamentos via Pix e cartão',
          icon: SB_ICON.card,
          configured: Boolean(cfg.infinitePay?.clientId),
          fields: `
            <div class="field-row">
              <div class="field"><label>Client ID</label><input class="input" placeholder="ip_client_xxxxxxxx" value="${SB_UI.escapeHtml(cfg.infinitePay?.clientId || '')}" disabled /></div>
              <div class="field"><label>Ambiente</label><select class="select" disabled><option>Produção</option><option>Sandbox</option></select></div>
            </div>
            <p class="field-hint" style="margin-top:10px;">A chave secreta de API nunca deve ser exposta no front-end — todas as chamadas autenticadas devem passar por uma function de backend.</p>`,
        })}
      </div>`;
  }

  function sectionNotificacoes() {
    const prefs = JSON.parse(localStorage.getItem('sb_notif_prefs') || '{}');
    const opt = (key, def) => prefs[key] !== undefined ? prefs[key] : def;
    return `
      <div class="card card-pad">
        <div class="card-header__title" style="margin-bottom:4px;">Preferências de notificação</div>
        <div class="card-header__subtitle" style="margin-bottom:20px;">Escolha como deseja ser avisado sobre eventos de cobrança</div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label class="checkbox-row"><input type="checkbox" data-pref="pagamento" ${opt('pagamento', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Pagamento recebido</span><br/><span class="checkbox-row__desc">Ser notificado quando uma cobrança for paga</span></span></label>
          <label class="checkbox-row"><input type="checkbox" data-pref="vencimento" ${opt('vencimento', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Cobrança vencendo</span><br/><span class="checkbox-row__desc">Alertar 3 dias antes do vencimento</span></span></label>
          <label class="checkbox-row"><input type="checkbox" data-pref="atraso" ${opt('atraso', true) ? 'checked' : ''} /><span><span class="checkbox-row__label">Cobrança atrasada</span><br/><span class="checkbox-row__desc">Ser notificado quando uma cobrança vencer sem pagamento</span></span></label>
        </div>
      </div>`;
  }

  function sectionSeguranca() {
    return `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Senha de acesso</div>
          <div class="card-header__subtitle" style="margin-bottom:20px;">Recomendamos alterar sua senha periodicamente</div>
          <button class="btn btn-secondary" id="btn-change-pass">${SB_ICON.key}<span>Alterar senha</span></button>
        </div>
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;color:var(--red-500);">Zona de risco</div>
          <div class="card-header__subtitle" style="margin-bottom:20px;">Ações irreversíveis relacionadas à sua conta</div>
          <button class="btn btn-danger-ghost" id="btn-logout-all">${SB_ICON.logout}<span>Sair de todos os dispositivos</span></button>
        </div>
      </div>`;
  }

  function sectionDados() {
    const isDemo = Boolean(window.SMART_BILLING_CONFIG?.useDemoMode);
    const snapshot = DB._readLocalDemoSnapshot?.();
    const qtdClientes = snapshot?.clientes?.length || 0;
    const qtdCobrancas = snapshot?.cobrancas?.length || 0;
    const jaMigrado = localStorage.getItem('smart_billing_migration_done_v1');

    if (isDemo) {
      return `
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Disponível somente quando o Supabase estiver configurado</div>
          <div class="auth-banner">
            ${SB_ICON.alertTriangle}
            <span>O sistema está em <strong>modo de demonstração</strong>. Configure o Supabase (veja SUPABASE_SETUP.md) para habilitar a migração dos dados simulados para o banco real.</span>
          </div>
        </div>`;
    }

    if (qtdClientes === 0 && qtdCobrancas === 0) {
      return `
        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Transferir dados simulados (localStorage) para o Supabase</div>
          <div class="state-block">
            <div class="state-block__icon">${SB_ICON.inbox}</div>
            <div class="state-block__title">Nenhum dado local encontrado</div>
            <p class="state-block__desc">Não há clientes ou cobranças de demonstração salvos neste navegador para migrar.</p>
          </div>
        </div>`;
    }

    return `
      <div class="card card-pad">
        <div class="card-header__title" style="margin-bottom:4px;">Migração de dados</div>
        <div class="card-header__subtitle" style="margin-bottom:16px;">Transferir os dados simulados deste navegador (localStorage) para o Supabase</div>

        ${jaMigrado ? `
          <div class="auth-banner">
            ${SB_ICON.alertTriangle}
            <span>Uma migração já foi realizada neste navegador em <strong>${SB_UI.formatDateTime(jaMigrado)}</strong>. Rodar novamente pode duplicar registros.</span>
          </div>` : ''}

        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          <div class="summary-row"><span class="label">Clientes encontrados</span><span class="value">${qtdClientes}</span></div>
          <div class="summary-row"><span class="label">Cobranças encontradas</span><span class="value">${qtdCobrancas}</span></div>
        </div>

        <p class="field-hint" style="margin-bottom:16px;">
          Os clientes serão criados primeiro; em seguida as cobranças serão recriadas já vinculadas ao cliente correto.
          Cobranças que estavam pagas geram automaticamente um pagamento e um recibo (com data/hora da migração).
          Os dados locais NÃO são apagados — permanecem como backup neste navegador.
        </p>

        <button class="btn btn-primary" id="btn-start-migration">
          ${SB_ICON.package}<span>${jaMigrado ? 'Migrar novamente mesmo assim' : 'Iniciar migração'}</span>
        </button>
        <div id="migration-result" style="margin-top:16px;"></div>
      </div>`;
  }

  function sectionWhatsapp() {
    const st = waState;
    const meta = WA_STATUS_META[st?.status] || WA_STATUS_META.offline;
    const isReady = st?.status === 'ready';
    const hasQr = st?.status === 'qr_required' && st?.qrCode;
    const needsAttention = !st || ['offline', 'disconnected', 'error'].includes(st.status);
    const lastSeenLabel = st?.lastSeenAt ? SB_UI.formatDateTime(st.lastSeenAt) : '—';

    return `
      <div style="display:flex;flex-direction:column;gap:20px;">
        <div class="card card-pad">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
            <div>
              <div class="card-header__title" style="margin-bottom:4px;">Agente local de WhatsApp</div>
              <div class="card-header__subtitle">Conecte o WhatsApp do seu celular para enviar cobranças, lembretes e recibos automaticamente.</div>
            </div>
            <span class="badge badge-${meta.tone}">${meta.label}</span>
          </div>

          ${isReady ? `
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
              <div class="summary-row"><span class="label">Número conectado</span><span class="value">${SB_UI.escapeHtml(st.phoneNumber || '—')}</span></div>
              <div class="summary-row"><span class="label">Nome no WhatsApp</span><span class="value">${SB_UI.escapeHtml(st.displayName || '—')}</span></div>
              <div class="summary-row"><span class="label">Última atividade</span><span class="value">${lastSeenLabel}</span></div>
            </div>` : ''}

          ${hasQr ? `
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:16px;">
              <img src="${st.qrCode}" alt="QR Code do WhatsApp" style="width:220px;height:220px;border-radius:12px;border:1px solid var(--border-subtle, #e5e7eb);" />
              <p class="field-hint">No celular: WhatsApp → Aparelhos conectados → Conectar aparelho, e escaneie o código acima.</p>
            </div>` : ''}

          ${needsAttention ? `
            <div class="auth-banner" style="margin-bottom:16px;">
              ${SB_ICON.alertTriangle}
              <span>${st?.status === 'error' && st?.errorMessage ? SB_UI.escapeHtml(st.errorMessage) : 'O agente local precisa estar aberto no seu computador para conectar o WhatsApp.'}</span>
            </div>` : ''}

          <div style="display:flex;flex-wrap:wrap;gap:10px;">
            <button class="btn btn-primary btn-sm" id="wa-btn-connect">${SB_ICON.whatsapp}<span>Conectar WhatsApp</span></button>
            <button class="btn btn-secondary btn-sm" id="wa-btn-new-qr">${SB_ICON.refreshCw}<span>Gerar novo QR Code</span></button>
            <button class="btn btn-secondary btn-sm" id="wa-btn-reconnect">${SB_ICON.refreshCw}<span>Reconectar</span></button>
            <button class="btn btn-danger-ghost btn-sm" id="wa-btn-logout">${SB_ICON.ban}<span>Desconectar do zero</span></button>
            <button class="btn btn-secondary btn-sm" id="wa-btn-test">${SB_ICON.mail}<span>Enviar mensagem de teste</span></button>
            <button class="btn btn-secondary btn-sm" id="wa-btn-open-local">${SB_ICON.externalLink}<span>Abrir agente local</span></button>
          </div>
          <div class="field" style="margin-top:14px;max-width:220px;">
            <label>Porta do agente local</label>
            <input class="input" id="wa-agent-port" value="${SB_UI.escapeHtml(localStorage.getItem('sb_wa_agent_port') || '3210')}" />
          </div>
          <p class="field-hint" style="margin-top:10px;">Os botões acima falam diretamente com o agente em http://127.0.0.1 — só funcionam neste computador, com o agente aberto.</p>
        </div>

        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Envio automático</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Escolha quando o Smart Billing deve enfileirar mensagens automaticamente pelo WhatsApp</div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="sendChargeOnCreate" ${waSettings?.sendChargeOnCreate ? 'checked' : ''} /><span><span class="checkbox-row__label">Enviar cobrança ao criar</span><br/><span class="checkbox-row__desc">Complementa a caixa "Notificar cliente" do formulário de nova cobrança</span></span></label>
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="sendReceiptOnPayment" ${waSettings?.sendReceiptOnPayment ? 'checked' : ''} /><span><span class="checkbox-row__label">Enviar recibo ao confirmar pagamento</span><br/><span class="checkbox-row__desc">Envia automaticamente ao marcar uma cobrança como paga</span></span></label>
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="remind3DaysBefore" ${waSettings?.remind3DaysBefore ? 'checked' : ''} /><span><span class="checkbox-row__label">Lembrete 3 dias antes do vencimento</span></span></label>
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="remind1DayBefore" ${waSettings?.remind1DayBefore ? 'checked' : ''} /><span><span class="checkbox-row__label">Lembrete 1 dia antes do vencimento</span></span></label>
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="remindOnDueDate" ${waSettings?.remindOnDueDate ? 'checked' : ''} /><span><span class="checkbox-row__label">Lembrete no dia do vencimento</span></span></label>
            <label class="checkbox-row"><input type="checkbox" data-wa-pref="remindWhenOverdue" ${waSettings?.remindWhenOverdue ? 'checked' : ''} /><span><span class="checkbox-row__label">Lembrete após atraso</span></span></label>
          </div>
          <p class="field-hint" style="margin-top:14px;">Os lembretes por data ficam salvos aqui, mas nesta versão ainda dependem de um disparo manual — use "Enviar lembrete" no menu de cada cobrança em Cobranças.</p>
        </div>

        <div class="card card-pad">
          <div class="card-header__title" style="margin-bottom:4px;">Histórico recente</div>
          <div class="card-header__subtitle" style="margin-bottom:16px;">Últimas mensagens enfileiradas pelo painel</div>
          ${waHistory.length === 0 ? `
            <div class="state-block">
              <div class="state-block__icon">${SB_ICON.whatsapp}</div>
              <div class="state-block__title">Nenhuma mensagem enviada ainda</div>
              <p class="state-block__desc">Envie uma cobrança, um recibo ou uma mensagem de teste para ver o histórico aqui.</p>
            </div>` : `
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Tipo</th><th>Destinatário</th><th>Status</th><th>Quando</th></tr></thead>
                <tbody>
                  ${waHistory.map((h) => `
                    <tr>
                      <td class="table-cell-muted">${WA_TYPE_LABEL[h.messageType] || h.messageType}</td>
                      <td>${SB_UI.escapeHtml(h.recipient)}</td>
                      <td><span class="badge badge-${WA_JOB_TONE[h.status] || 'pending'}">${WA_JOB_LABEL[h.status] || h.status}</span></td>
                      <td class="table-cell-muted">${SB_UI.formatDateTime(h.createdAt)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`}
        </div>
      </div>`;
  }

  function wireWhatsappButtons() {
    document.getElementById('wa-agent-port')?.addEventListener('change', (e) => {
      localStorage.setItem('sb_wa_agent_port', e.target.value.trim() || '3210');
    });

    document.getElementById('wa-btn-open-local')?.addEventListener('click', () => {
      window.open(waAgentBaseUrl(), '_blank');
    });

    async function refreshAfterAction() {
      await loadWhatsappData();
      content.innerHTML = sectionWhatsapp();
      wireWhatsappButtons();
    }

    document.getElementById('wa-btn-connect')?.addEventListener('click', async () => {
      try {
        await callLocalAgent('/start', { method: 'POST' });
        SB_UI.toast({ type: 'info', title: 'Solicitação enviada ao agente', desc: 'Aguardando QR Code...' });
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Agente local não encontrado', desc: err.message });
      }
      await refreshAfterAction();
    });

    document.getElementById('wa-btn-new-qr')?.addEventListener('click', async () => {
      const ok = await SB_UI.confirmDialog({
        title: 'Gerar novo QR Code',
        desc: 'Isso encerra a sessão atual do WhatsApp neste agente e gera um novo código para escanear. Continuar?',
        confirmLabel: 'Gerar novo QR',
        cancelLabel: 'Cancelar',
        tone: 'warn',
      });
      if (!ok) return;
      try {
        await callLocalAgent('/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forceNewQR: true }) });
        SB_UI.toast({ type: 'info', title: 'Gerando novo QR Code...' });
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Agente local não encontrado', desc: err.message });
      }
      await refreshAfterAction();
    });

    document.getElementById('wa-btn-reconnect')?.addEventListener('click', async () => {
      try {
        await callLocalAgent('/restart', { method: 'POST' });
        SB_UI.toast({ type: 'info', title: 'Reconectando...' });
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Agente local não encontrado', desc: err.message });
      }
      await refreshAfterAction();
    });

    document.getElementById('wa-btn-logout')?.addEventListener('click', async () => {
      const ok = await SB_UI.confirmDialog({
        title: 'Desconectar do zero',
        desc: 'Isso encerra a sessão do WhatsApp deste agente e apaga a conexão salva (só a sessão do Smart Billing). Você precisará escanear um novo QR Code para reconectar. Continuar?',
        confirmLabel: 'Desconectar',
        cancelLabel: 'Cancelar',
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await callLocalAgent('/logout', { method: 'POST' });
        SB_UI.toast({ type: 'success', title: 'Sessão encerrada' });
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Agente local não encontrado', desc: err.message });
      }
      await refreshAfterAction();
    });

    document.getElementById('wa-btn-test')?.addEventListener('click', async () => {
      const btn = document.getElementById('wa-btn-test');
      btn.disabled = true;
      try {
        const result = await DB.whatsapp.enqueue({
          messageType: 'test',
          message: 'Mensagem de teste do Smart Billing ✅\n\nSe você recebeu isso, o agente de WhatsApp está funcionando corretamente.',
          idempotencyKey: `test:${Date.now()}`,
        });
        if (result?.success) {
          SB_UI.toast({ type: 'success', title: 'Mensagem de teste adicionada à fila', desc: 'Será enviada quando o WhatsApp estiver conectado.' });
        } else {
          SB_UI.toast({ type: 'error', title: 'Não foi possível enviar o teste', desc: result?.message || 'Cadastre seu WhatsApp em Perfil.' });
        }
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Não foi possível enviar o teste', desc: 'Tente novamente em instantes.' });
      } finally {
        btn.disabled = false;
      }
      await refreshAfterAction();
    });

    content.querySelectorAll('[data-wa-pref]').forEach((el) => {
      el.addEventListener('change', async () => {
        el.disabled = true;
        try {
          waSettings = await DB.whatsapp.updateSettings({ [el.dataset.waPref]: el.checked });
          SB_UI.toast({ type: 'success', title: 'Preferência salva', duration: 2000 });
        } catch (err) {
          el.checked = !el.checked;
          SB_UI.toast({ type: 'error', title: 'Não foi possível salvar', desc: 'Tente novamente.' });
        } finally {
          el.disabled = false;
        }
      });
    });
  }

  function errorBlock() {
    return `
      <div class="card card-pad">
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Não foi possível carregar os dados</div>
          <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
        </div>
      </div>`;
  }

  const sections = {
    perfil: sectionPerfil,
    empresa: sectionEmpresa,
    integracoes: sectionIntegracoes,
    whatsapp: sectionWhatsapp,
    notificacoes: sectionNotificacoes,
    seguranca: sectionSeguranca,
    dados: sectionDados,
  };

  async function runMigration() {
    const snapshot = DB._readLocalDemoSnapshot();
    const resultEl = document.getElementById('migration-result');
    const btn = document.getElementById('btn-start-migration');

    const ok = await SB_UI.confirmDialog({
      title: 'Iniciar migração de dados',
      desc: `Isso vai criar ${snapshot.clientes.length} cliente(s) e ${snapshot.cobrancas.length} cobrança(s) no Supabase, vinculados à sua empresa atual. Deseja continuar?`,
      confirmLabel: 'Migrar agora',
      tone: 'warn',
    });
    if (!ok) return;

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Migrando...';

    const idMap = {};
    let clientesOk = 0;
    let cobrancasOk = 0;
    let cobrancasPagas = 0;
    let cobrancasCanceladas = 0;
    const erros = [];

    for (const cli of snapshot.clientes) {
      try {
        const novo = await DB.clientes.create({ nome: cli.nome, whatsapp: cli.whatsapp, email: cli.email });
        idMap[cli.id] = novo.id;
        clientesOk += 1;
      } catch (err) {
        erros.push(`Cliente "${cli.nome}": ${err.message}`);
      }
    }

    for (const cob of snapshot.cobrancas) {
      const novoClienteId = idMap[cob.clienteId];
      if (!novoClienteId) {
        erros.push(`Cobrança "${cob.descricao}" ignorada (cliente original não encontrado).`);
        continue;
      }
      try {
        const nova = await DB.cobrancas.create({
          clienteId: novoClienteId,
          descricao: cob.descricao,
          valor: cob.valor,
          vencimento: cob.vencimento,
          formaPagamento: cob.formaPagamento,
          parcelas: cob.parcelas,
          observacoes: cob.observacoes || '',
          enviarWhatsapp: false,
          enviarEmail: false,
        });
        cobrancasOk += 1;

        if (cob.status === 'pago') {
          await DB.cobrancas.markPaid(nova.id, { forma: cob.formaPagamento === 'ambos' ? 'pix' : cob.formaPagamento, parcelas: cob.parcelas });
          cobrancasPagas += 1;
        } else if (cob.status === 'cancelado') {
          await DB.cobrancas.cancel(nova.id);
          cobrancasCanceladas += 1;
        }
      } catch (err) {
        erros.push(`Cobrança "${cob.descricao}": ${err.message}`);
      }
    }

    localStorage.setItem('smart_billing_migration_done_v1', new Date().toISOString());

    resultEl.innerHTML = `
      <div class="auth-banner" style="background:var(--green-100);border-color:rgba(16,185,129,.3);">
        ${SB_ICON.checkCircle}
        <span>
          Migração concluída: <strong>${clientesOk}</strong> cliente(s) e <strong>${cobrancasOk}</strong> cobrança(s) criados
          (${cobrancasPagas} marcada(s) como paga, ${cobrancasCanceladas} cancelada(s)).
          ${erros.length ? `${erros.length} item(ns) com erro — veja abaixo.` : ''}
        </span>
      </div>
      ${erros.length ? `<ul style="margin-top:10px;padding-left:18px;font-size:12px;color:var(--red-600,#dc2626);">${erros.map((e) => `<li>${SB_UI.escapeHtml(e)}</li>`).join('')}</ul>` : ''}
    `;
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Migrar novamente mesmo assim';
    SB_UI.toast({ type: 'success', title: 'Migração concluída', desc: `${clientesOk} clientes, ${cobrancasOk} cobranças.` });
  }

  function wireSection(name) {
    if (name === 'perfil') {
      document.getElementById('form-perfil')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const admin = {
          nome: document.getElementById('perfil-nome').value.trim(),
          cargo: document.getElementById('perfil-cargo').value.trim(),
          email: document.getElementById('perfil-email').value.trim(),
          telefone: document.getElementById('perfil-telefone').value.trim(),
        };
        await DB.empresa.update({ admin: { ...empresa.admin, ...admin } });
        empresa.admin = { ...empresa.admin, ...admin };
        SB_UI.toast({ type: 'success', title: 'Perfil atualizado com sucesso' });
      });
    }
    if (name === 'empresa') {
      document.getElementById('form-empresa')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          nome: document.getElementById('empresa-nome').value.trim(),
          cnpj: document.getElementById('empresa-cnpj').value.trim(),
          telefone: document.getElementById('empresa-telefone').value.trim(),
          email: document.getElementById('empresa-email').value.trim(),
        };
        await DB.empresa.update(payload);
        empresa = { ...empresa, ...payload };
        SB_UI.toast({ type: 'success', title: 'Dados da empresa atualizados' });
      });
    }
    if (name === 'notificacoes') {
      content.querySelectorAll('[data-pref]').forEach((el) => {
        el.addEventListener('change', () => {
          const prefs = JSON.parse(localStorage.getItem('sb_notif_prefs') || '{}');
          prefs[el.dataset.pref] = el.checked;
          localStorage.setItem('sb_notif_prefs', JSON.stringify(prefs));
          SB_UI.toast({ type: 'success', title: 'Preferência salva', duration: 2000 });
        });
      });
    }
    if (name === 'seguranca') {
      document.getElementById('btn-change-pass')?.addEventListener('click', async () => {
        if (window.SMART_BILLING_CONFIG?.useDemoMode) {
          SB_UI.toast({ type: 'info', title: 'Indisponível no modo demonstração', desc: 'Conecte a autenticação do Supabase para habilitar esta ação.' });
          return;
        }
        try {
          await SB_AUTH.resetPassword(empresa.admin.email);
          SB_UI.toast({ type: 'success', title: 'E-mail enviado', desc: `Link para redefinir a senha enviado para ${empresa.admin.email}.` });
        } catch (err) {
          SB_UI.toast({ type: 'error', title: 'Não foi possível enviar o e-mail', desc: err.message });
        }
      });
      document.getElementById('btn-logout-all')?.addEventListener('click', async () => {
        const ok = await SB_UI.confirmDialog({
          title: 'Sair de todos os dispositivos',
          desc: 'Isso encerrará todas as sessões ativas, incluindo a atual. Deseja continuar?',
          confirmLabel: 'Sair de todos',
          tone: 'danger',
        });
        if (ok) {
          await SB_AUTH?.signOut();
          SB_UI.toast({ type: 'info', title: 'Sessões encerradas' });
          const dest = window.SMART_BILLING_CONFIG?.useDemoMode ? 'index.html' : 'login.html';
          setTimeout(() => { window.location.href = dest; }, 600);
        }
      });
    }
    if (name === 'dados') {
      document.getElementById('btn-start-migration')?.addEventListener('click', runMigration);
    }
    if (name === 'whatsapp') {
      wireWhatsappButtons();
      startWaPolling();
    }
  }

  function render(name) {
    content.innerHTML = sections[name] ? sections[name]() : errorBlock();
    wireSection(name);
  }

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-section]');
    if (!btn) return;
    menu.querySelectorAll('.settings-menu-item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const name = btn.dataset.section;
    stopWaPolling();
    if (name === 'whatsapp') {
      content.innerHTML = '<div class="card card-pad"><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div>';
      await loadWhatsappData();
    }
    render(name);
  });

  render('perfil');
})();
