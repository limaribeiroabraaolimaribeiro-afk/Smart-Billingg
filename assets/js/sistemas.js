(async function initSistemas() {
  if (!await SB_AUTH.requireSession()) return;
  await SBLayout.mount({ active: 'sistemas', title: 'Sistemas', breadcrumb: 'Painel <span>/</span> Sistemas', hidePrimaryAction: true });
  const el = id => document.getElementById(id);
  const esc = SB_UI.escapeHtml;
  const form = el('system-form');
  const region = el('systems-region');
  let systems = [], editing = null, canManage = false, subscriptionRequest = 0;
  let loadingSubscriptions = false, subscriptionFailed = false;
  const labels = { active: 'Ativo', grace: 'Em carência', suspended: 'Suspenso' };
  const badges = { active: 'badge-paid', grace: 'badge-pending', suspended: 'badge-overdue' };
  const errorToast = err => SB_UI.toast({ type: 'error', title: 'Não foi possível concluir', desc: err.message });

  async function load() {
    systems = await DB.sistemas.listar(el('filter-client').value || null);
    if (!systems.length) {
      region.innerHTML = '<div class="state-block"><div class="state-block__title">Nenhum sistema cadastrado</div><p>Cadastre um sistema e vincule a assinatura correspondente.</p></div>';
      return;
    }
    region.innerHTML = `<div class="plan-grid">${systems.map(s => {
      const status = s.acesso?.status;
      return `<article class="card card-pad">
        <span class="badge ${badges[status] || ''}">${labels[status] || 'Status indisponível'}</span>
        <h3>${esc(s.nome)}</h3><p>${esc(s.clienteNome)}</p><p>${esc(s.dominio || 'Sem domínio')}</p>
        <p>Assinatura: ${esc(s.assinaturaNome || 'Não vinculada')}${s.assinaturaId ? ` · ${esc(s.assinaturaId.slice(0, 8))}` : ''}</p>
        ${!s.ativo ? '<p>Sistema administrativamente desativado</p>' : ''}
        ${!s.bloqueioAutomatico ? '<p>Bloqueio automático desligado</p>' : ''}
        ${s.manualOverride !== 'none' ? `<p>${s.manualOverride === 'force_active' ? 'Liberação manual' : 'Suspensão manual'} aplicada</p>` : ''}
        <p>Carência: ${s.diasCarencia} dias</p>
        ${status === 'grace' ? `<p>${s.acesso.grace_days_remaining} dias restantes após hoje</p>` : ''}
        ${canManage ? `<div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${[['edit','Editar'],['suspend','Suspender agora'],['release','Liberar manualmente'],['reset','Voltar para automático'],['toggle',s.bloqueioAutomatico ? 'Desligar bloqueio automático' : 'Ativar bloqueio automático'],['key','Copiar chave']].map(([action,label]) => `<button class="btn btn-secondary btn-sm" data-action="${action}" data-id="${esc(s.id)}">${label}</button>`).join('')}
        </div>` : ''}
      </article>`;
    }).join('')}</div>`;
  }
  async function subscriptions(selected = '') {
    const request = ++subscriptionRequest;
    loadingSubscriptions = true;
    subscriptionFailed = false;
    el('system-subscription').disabled = true;
    el('save-system').disabled = true;
    try {
      const rows = el('system-client').value ? await DB.assinaturas.listForClient(el('system-client').value) : [];
      if (request !== subscriptionRequest) return;
      el('system-subscription').innerHTML = '<option value="">Sem assinatura</option>' + rows.map(a => `<option value="${esc(a.id)}">${esc(a.planoNome)} · ${esc(a.status)} · ${esc(a.id.slice(0, 8))}</option>`).join('');
      el('system-subscription').value = selected;
    } catch (err) {
      if (request === subscriptionRequest) { subscriptionFailed = true; el('form-error').textContent = 'Não foi possível carregar as assinaturas. Reabra o formulário para tentar novamente.'; }
      throw err;
    } finally {
      if (request === subscriptionRequest) { loadingSubscriptions = false; el('system-subscription').disabled = subscriptionFailed; el('save-system').disabled = subscriptionFailed; }
    }
  }
  async function openForm(s = null) {
    editing = s?.id || null;
    form.reset(); form.hidden = false;
    el('form-title').textContent = s ? 'Editar sistema' : 'Novo sistema';
    el('form-error').textContent = '';
    el('system-client').disabled = Boolean(s);
    el('system-client').value = s?.clienteId || el('filter-client').value || '';
    el('system-name').value = s?.nome || '';
    el('system-domain').value = s?.dominio || '';
    el('system-grace').value = s?.diasCarencia ?? 3;
    el('system-auto').checked = s?.bloqueioAutomatico ?? true;
    el('system-active').checked = s?.ativo ?? true;
    await subscriptions(s?.assinaturaId || '');
    el('system-name').focus();
  }
  el('new-system').onclick = () => openForm().catch(errorToast);
  el('cancel-system').onclick = () => { form.hidden = true; editing = null; };
  el('system-client').onchange = () => subscriptions().catch(errorToast);
  el('filter-client').onchange = () => load().catch(errorToast);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!canManage || loadingSubscriptions || subscriptionFailed) return;
    el('save-system').disabled = true;
    try {
      const payload = { clienteId: el('system-client').value, nome: el('system-name').value.trim(),
        dominio: el('system-domain').value.trim() || null, assinaturaId: el('system-subscription').value || null,
        diasCarencia: Number(el('system-grace').value), bloqueioAutomatico: el('system-auto').checked, ativo: el('system-active').checked };
      if (!payload.nome) throw new Error('Informe o nome do sistema.');
      if (editing) await DB.sistemas.atualizar(editing, payload); else await DB.sistemas.criar(payload);
      form.hidden = true;
      await load();
      SB_UI.toast({ type: 'success', title: 'Sistema salvo' });
    } catch (err) { el('form-error').textContent = err.message; errorToast(err); }
    finally { el('save-system').disabled = false; }
  };
  region.onclick = async event => {
    const button = event.target.closest('[data-action]');
    if (!button || !canManage) return;
    const s = systems.find(s => s.id === button.dataset.id);
    if (!s) return;
    button.disabled = true;
    try {
      switch (button.dataset.action) {
        case 'edit': await openForm(s); return;
        case 'key': await navigator.clipboard.writeText(s.chave); SB_UI.toast({ type: 'success', title: 'Chave copiada' }); return;
        case 'suspend': await DB.sistemas.suspender(s.id); break;
        case 'release': await DB.sistemas.liberar(s.id); break;
        case 'reset': await DB.sistemas.voltarAutomatico(s.id); break;
        case 'toggle': await DB.sistemas.atualizar(s.id, { bloqueioAutomatico: !s.bloqueioAutomatico }); break;
      }
      await load();
    } catch (err) { errorToast(err); }
    finally { button.disabled = false; }
  };
  try {
    const [clients, permission] = await Promise.all([DB.clientes.list(), DB.sistemas.podeGerenciar()]);
    canManage = permission;
    el('new-system').hidden = !canManage;
    el('demo-note').hidden = !DB._isDemo;
    const options = clients.map(c => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join('');
    el('system-client').innerHTML = '<option value="">Selecione o cliente</option>' + options;
    el('filter-client').innerHTML = '<option value="">Todos os clientes</option>' + options;
    el('filter-client').value = new URLSearchParams(location.search).get('cliente') || '';
    await load();
  } catch (err) {
    region.innerHTML = '<div class="state-block is-error"><p>Não foi possível carregar os sistemas.</p><button class="btn btn-secondary" id="retry-systems">Tentar novamente</button></div>';
    el('retry-systems').onclick = () => location.reload();
    errorToast(err);
  }
})();
