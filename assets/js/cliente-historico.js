/* ==========================================================================
   Smart Billing — Histórico financeiro do cliente
   ========================================================================== */

(async function initClienteHistorico() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const clienteId = params.get('id');

  await SBLayout.mount({
    active: 'clientes',
    title: 'Histórico do cliente',
    breadcrumb: 'Painel <span>/</span> Clientes <span>/</span> Histórico',
  });

  const profileRegion = document.getElementById('profile-region');
  const miniStats = document.getElementById('mini-stats');
  const historyRegion = document.getElementById('history-region');

  if (!clienteId) {
    profileRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Cliente não informado</div>
        <p class="state-block__desc">Volte para a lista de clientes e selecione um cliente.</p>
        <a href="clientes.html" class="btn btn-secondary btn-sm">Voltar</a>
      </div>`;
    return;
  }

  let cobrancasCliente = [];
  let cliente = null;

  try {
    let stats;
    [cliente, stats] = await Promise.all([DB.clientes.get(clienteId), DB.clientes.stats(clienteId)]);
    if (!cliente) {
      profileRegion.innerHTML = `
        <div class="state-block is-error">
          <div class="state-block__icon">${SB_ICON.alertCircle}</div>
          <div class="state-block__title">Cliente não encontrado</div>
          <p class="state-block__desc">Ele pode ter sido removido.</p>
          <a href="clientes.html" class="btn btn-secondary btn-sm">Voltar para clientes</a>
        </div>`;
      return;
    }

    document.title = `${cliente.nome} · Smart Billing`;
    cobrancasCliente = stats.cobrancas.map((c) => ({ ...c, cliente }));

    profileRegion.innerHTML = `
      <div class="card card-pad profile-header">
        <span class="profile-avatar">${SB_UI.initials(cliente.nome)}</span>
        <div>
          <div class="profile-meta__name">${SB_UI.escapeHtml(cliente.nome)}</div>
          <div class="profile-meta__row">
            <span>${SB_ICON.phone}</span><span>${SB_UI.escapeHtml(cliente.whatsapp)}</span>
            ${cliente.email ? `<span style="margin-left:8px;">${SB_ICON.mail}</span><span>${SB_UI.escapeHtml(cliente.email)}</span>` : ''}
          </div>
        </div>
        <div class="profile-actions">
          <a href="cliente-form.html?id=${cliente.id}" class="btn btn-secondary">${SB_ICON.edit}<span>Editar cliente</span></a>
          <a href="cobranca-form.html?clienteId=${cliente.id}" class="btn btn-primary">${SB_ICON.plus}<span>Nova cobrança</span></a>
        </div>
      </div>`;

    miniStats.style.display = 'grid';
    miniStats.innerHTML = `
      <div class="mini-stat"><div class="mini-stat__label">Total de cobranças</div><div class="mini-stat__value">${stats.quantidade}</div></div>
      <div class="mini-stat"><div class="mini-stat__label">Total recebido</div><div class="mini-stat__value">${SB_UI.formatCurrency(stats.totalRecebido)}</div></div>
      <div class="mini-stat"><div class="mini-stat__label">Total pendente</div><div class="mini-stat__value">${SB_UI.formatCurrency(stats.totalPendente)}</div></div>
    `;

    renderHistory();
  } catch (err) {
    profileRegion.innerHTML = `
      <div class="state-block is-error">
        <div class="state-block__icon">${SB_ICON.alertCircle}</div>
        <div class="state-block__title">Não foi possível carregar o cliente</div>
        <p class="state-block__desc">Tente novamente.</p>
        <button class="btn btn-secondary btn-sm" onclick="location.reload()">Tentar novamente</button>
      </div>`;
    return;
  }

  function rowHtml(c) {
    return `
      <tr>
        <td class="table-cell-primary">${c.codigo}</td>
        <td>${SB_UI.escapeHtml(c.descricao)}</td>
        <td>${SB_UI.formatDate(c.vencimento)}</td>
        <td class="table-cell-primary">${SB_UI.formatCurrency(c.valor)}</td>
        <td>${SB_UI.badgeHtml(c.status)}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" data-menu-toggle="${c.id}" aria-label="Ações">${SB_ICON.moreVertical}</button>
            <div class="action-menu" data-menu="${c.id}">${SB_ACTIONS.rowMenuHtml(c)}</div>
          </div>
        </td>
      </tr>`;
  }

  function renderHistory() {
    if (cobrancasCliente.length === 0) {
      historyRegion.innerHTML = `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.inbox}</div>
          <div class="state-block__title">Nenhuma cobrança para este cliente</div>
          <p class="state-block__desc">Crie a primeira cobrança para este cliente.</p>
          <a href="cobranca-form.html?clienteId=${clienteId}" class="btn btn-primary btn-sm">${SB_ICON.plus}<span>Nova cobrança</span></a>
        </div>`;
      return;
    }

    historyRegion.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Código</th><th>Descrição</th><th>Vencimento</th><th>Valor</th><th>Status</th><th class="text-right">Ações</th></tr></thead>
          <tbody>${cobrancasCliente.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="card-list">${cobrancasCliente.map((c) => `
        <div class="data-card">
          <div class="data-card__top">
            <span class="table-cell-primary">${c.codigo}</span>
            ${SB_UI.badgeHtml(c.status)}
          </div>
          <div class="data-card__row"><span class="label">Descrição</span><span class="value">${SB_UI.escapeHtml(c.descricao)}</span></div>
          <div class="data-card__row"><span class="label">Vencimento</span><span class="value">${SB_UI.formatDate(c.vencimento)}</span></div>
          <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(c.valor)}</span></div>
        </div>`).join('')}</div>`;

    SB_UI.initActionMenus(historyRegion);
    SB_ACTIONS.wire(historyRegion, (id) => cobrancasCliente.find((c) => c.id === id), {
      onChange: async () => {
        const stats = await DB.clientes.stats(clienteId);
        cobrancasCliente = stats.cobrancas.map((c) => ({ ...c, cliente }));
        renderHistory();
      },
    });
  }

  // ---------------- Plano atual + histórico de ofertas ----------------
  const planoRegion = document.getElementById('plano-region');
  const STATUS_ASSIN_LABEL = { pending: 'Aguardando pagamento', active: 'Ativo', overdue: 'Em atraso', cancelled: 'Cancelado', expired: 'Expirado' };
  const STATUS_ASSIN_TONE = { pending: 'badge-pending', active: 'badge-paid', overdue: 'badge-overdue', cancelled: 'badge-canceled', expired: 'badge-canceled' };

  async function renderPlano() {
    try {
      const [assinatura, ofertas] = await Promise.all([
        DB.assinaturas.getCurrentForClient(clienteId),
        DB.ofertas.listForClient(clienteId),
      ]);

      const blocoAssinatura = assinatura ? `
        <div class="data-card" style="margin-bottom:${ofertas.length ? '16px' : '0'};">
          <div class="data-card__top">
            <span class="table-cell-primary">${SB_UI.escapeHtml(assinatura.planoNome || 'Plano')}</span>
            <span class="badge ${STATUS_ASSIN_TONE[assinatura.status] || 'badge-pending'}">${STATUS_ASSIN_LABEL[assinatura.status] || assinatura.status}</span>
          </div>
          ${assinatura.status === 'active' && assinatura.planoTipo === 'recurring_monthly' ? `
            <div class="data-card__row"><span class="label">Valor</span><span class="value">${SB_UI.formatCurrency(assinatura.planoValor)}/mês</span></div>
            ${assinatura.nextBillingAt ? `<div class="data-card__row"><span class="label">Próxima cobrança</span><span class="value">${SB_UI.formatDate(assinatura.nextBillingAt)}</span></div>` : ''}
          ` : ''}
          ${assinatura.status === 'active' && assinatura.planoTipo === 'one_time' ? `
            <div class="data-card__row"><span class="label">Valor pago</span><span class="value">${SB_UI.formatCurrency(assinatura.planoValor)}</span></div>
            ${assinatura.startsAt ? `<div class="data-card__row"><span class="label">Início</span><span class="value">${SB_UI.formatDate(assinatura.startsAt)}</span></div>` : ''}
            ${assinatura.endsAt ? `<div class="data-card__row"><span class="label">Validade</span><span class="value">${SB_UI.formatDate(assinatura.endsAt)}</span></div>` : ''}
          ` : ''}
          ${assinatura.status === 'pending' ? `<div class="data-card__row"><span class="label">Situação</span><span class="value">Aguardando confirmação do pagamento inicial</span></div>` : ''}
          ${assinatura.status === 'active' ? `<div class="data-card__actions"><button type="button" class="btn btn-secondary btn-sm" data-cancelar-assinatura="${assinatura.id}">Cancelar assinatura</button></div>` : ''}
        </div>` : '';

      const blocoOfertas = ofertas.length ? `
        <div class="table-cell-muted" style="font-size:12px;font-weight:700;margin-bottom:8px;">Histórico de planos (ofertas enviadas)</div>
        <div class="card-list" style="display:flex;">
          ${ofertas.slice(0, 5).map((o) => `
            <div class="data-card">
              <div class="data-card__row"><span class="label">${o.titulo ? SB_UI.escapeHtml(o.titulo) : 'Oferta'}</span><span class="value">${SB_UI.formatDate(o.criadoEm)}</span></div>
              <div class="data-card__row"><span class="label">Status</span><span class="value">${o.status === 'selected' ? 'Plano escolhido' : o.status === 'cancelled' ? 'Cancelada' : new Date(o.expiraEm) < new Date() ? 'Expirada' : 'Aguardando escolha'}</span></div>
            </div>`).join('')}
        </div>` : '';

      planoRegion.innerHTML = blocoAssinatura || blocoOfertas ? `${blocoAssinatura}${blocoOfertas}` : `
        <div class="state-block">
          <div class="state-block__icon">${SB_ICON.package}</div>
          <div class="state-block__title">Nenhum plano ainda</div>
          <p class="state-block__desc">Crie uma oferta de planos para este cliente escolher.</p>
        </div>`;

      planoRegion.querySelectorAll('[data-cancelar-assinatura]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await SB_UI.confirmDialog({
            title: 'Cancelar assinatura?',
            desc: 'O histórico de cobranças já geradas é preservado. Nenhuma nova cobrança de renovação será criada.',
            confirmLabel: 'Cancelar assinatura',
            cancelLabel: 'Voltar',
            tone: 'danger',
          });
          if (!ok) return;
          await DB.assinaturas.cancel(btn.dataset.cancelarAssinatura);
          SB_UI.toast({ type: 'success', title: 'Assinatura cancelada' });
          renderPlano();
        });
      });
    } catch (err) {
      planoRegion.innerHTML = `<p class="table-cell-muted">Não foi possível carregar o plano deste cliente.</p>`;
    }
  }

  // ---------------- Criação de oferta ----------------
  const ofertaCard = document.getElementById('oferta-criacao-card');
  const ofertaBody = document.getElementById('oferta-criacao-body');
  let ofertaFormLoaded = false;

  async function abrirFormularioOferta() {
    ofertaCard.style.display = 'block';
    ofertaCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (ofertaFormLoaded) return;
    ofertaFormLoaded = true;

    let planosAtivos = [];
    try {
      planosAtivos = (await DB.planos.list()).filter((p) => p.ativo);
    } catch (err) { /* segue com lista vazia — mostra estado abaixo */ }

    if (planosAtivos.length === 0) {
      ofertaBody.innerHTML = `
        <div class="state-block">
          <div class="state-block__title">Nenhum plano ativo</div>
          <p class="state-block__desc">Cadastre ao menos um plano ativo antes de criar uma oferta.</p>
          <a href="planos.html" class="btn btn-primary btn-sm">Ir para Planos</a>
        </div>`;
      return;
    }

    ofertaBody.innerHTML = `
      <div class="field">
        <label>Planos oferecidos</label>
        <div class="pay-method-grid" id="oferta-planos-check" style="grid-template-columns:1fr;">
          ${planosAtivos.map((p) => `
            <label class="option-toggle is-checked" style="cursor:pointer;">
              <input type="checkbox" value="${p.id}" checked />
              <span><span class="option-toggle__title">${SB_UI.escapeHtml(p.nome)}</span><br/><span class="option-toggle__desc">${SB_UI.formatCurrency(p.valor)}${p.tipoCobranca === 'recurring_monthly' ? '/mês' : ''}</span></span>
            </label>`).join('')}
        </div>
      </div>
      <div class="field-row" style="margin-top:16px;">
        <div class="field">
          <label for="oferta-titulo">Título <span class="optional">(opcional)</span></label>
          <input class="input" id="oferta-titulo" placeholder="Escolha o plano ideal" />
        </div>
        <div class="field">
          <label for="oferta-validade">Validade (dias)</label>
          <input class="input" id="oferta-validade" type="number" min="1" value="7" />
        </div>
      </div>
      <div class="field" style="margin-top:16px;">
        <label for="oferta-mensagem">Mensagem <span class="optional">(opcional)</span></label>
        <textarea class="textarea" id="oferta-mensagem" rows="2" placeholder="Mensagem que aparece na página da oferta"></textarea>
      </div>
      <button type="button" class="btn btn-primary btn-block" id="btn-gerar-oferta" style="margin-top:20px;">Gerar link da oferta</button>
      <div id="oferta-resultado" style="margin-top:16px;"></div>`;

    ofertaBody.querySelectorAll('#oferta-planos-check .option-toggle input').forEach((inp) => {
      inp.addEventListener('change', () => inp.closest('.option-toggle').classList.toggle('is-checked', inp.checked));
    });

    document.getElementById('btn-gerar-oferta').addEventListener('click', async (e) => {
      const planIds = Array.from(ofertaBody.querySelectorAll('#oferta-planos-check input:checked')).map((i) => i.value);
      if (planIds.length === 0) {
        SB_UI.toast({ type: 'error', title: 'Selecione ao menos um plano' });
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const oferta = await DB.ofertas.create({
          clienteId,
          planIds,
          titulo: document.getElementById('oferta-titulo').value.trim() || null,
          mensagem: document.getElementById('oferta-mensagem').value.trim() || null,
          expiraEmDias: Number(document.getElementById('oferta-validade').value) || 7,
        });
        const link = SB_WA.publicOfferUrl(oferta.publicToken);
        const mensagemWa = SB_WA.offerMessage(cliente.nome, oferta.publicToken);
        document.getElementById('oferta-resultado').innerHTML = `
          <div class="field">
            <label>Link gerado</label>
            <div style="display:flex;gap:8px;">
              <input class="input" id="oferta-link-gerado" value="${SB_UI.escapeHtml(link)}" readonly style="flex:1;" />
              <button type="button" class="btn btn-secondary" id="btn-copiar-link">Copiar</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="btn-enviar-whatsapp" style="margin-top:12px;">Enviar pelo WhatsApp</button>`;

        document.getElementById('btn-copiar-link').addEventListener('click', async () => {
          await SB_UI.copyToClipboard(link);
          SB_UI.toast({ type: 'success', title: 'Link copiado' });
        });
        document.getElementById('btn-enviar-whatsapp').addEventListener('click', async () => {
          // Mesma fila do resto do sistema (DB.whatsapp.enqueue) — nenhuma
          // integração paralela de WhatsApp é criada para ofertas.
          const result = await DB.whatsapp.enqueue({
            messageType: 'custom',
            message: mensagemWa,
            clientId: clienteId,
            idempotencyKey: `plan-offer:${oferta.id}`,
          });
          if (result.success) {
            SB_UI.toast({ type: 'success', title: 'Oferta enviada pelo WhatsApp' });
          } else {
            window.open(SB_UI.whatsappLink(cliente.whatsapp, mensagemWa), '_blank');
          }
        });

        SB_UI.toast({ type: 'success', title: 'Oferta criada com sucesso' });
        renderPlano();
      } catch (err) {
        SB_UI.toast({ type: 'error', title: 'Não foi possível criar a oferta', desc: err?.message || 'Tente novamente.' });
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.getElementById('btn-criar-oferta').addEventListener('click', abrirFormularioOferta);
  document.getElementById('btn-fechar-oferta').addEventListener('click', () => { ofertaCard.style.display = 'none'; });

  renderPlano();
})();
