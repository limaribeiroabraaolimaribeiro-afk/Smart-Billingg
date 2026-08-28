/* ==========================================================================
   Smart Billing — Nova / Editar cobrança
   ========================================================================== */

(async function initCobrancaForm() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const editId = params.get('id');
  const preselectClienteId = params.get('clienteId');
  const isEdit = Boolean(editId);

  await SBLayout.mount({
    active: 'cobrancas',
    title: isEdit ? 'Editar cobrança' : 'Nova cobrança',
    breadcrumb: `Painel <span>/</span> Cobranças <span>/</span> ${isEdit ? 'Editar' : 'Nova'}`,
    hidePrimaryAction: true,
  });

  if (isEdit) {
    document.getElementById('submit-btn-label').textContent = 'Salvar alterações';
  }

  const form = document.getElementById('cobranca-form');
  const clienteSelect = document.getElementById('cliente-select');
  const newClientBlock = document.getElementById('new-client-block');
  const existingClientBlock = document.getElementById('existing-client-block');
  const toggleNewClientBtn = document.getElementById('toggle-new-client');
  const toggleNewClientLabel = document.getElementById('toggle-new-client-label');

  const els = {
    descricao: document.getElementById('descricao'),
    valor: document.getElementById('valor'),
    vencimento: document.getElementById('vencimento'),
    observacoes: document.getElementById('observacoes'),
    sendWhatsapp: document.getElementById('send-whatsapp'),
    sendEmail: document.getElementById('send-email'),
    novoNome: document.getElementById('novo-nome'),
    novoWhatsapp: document.getElementById('novo-whatsapp'),
    novoEmail: document.getElementById('novo-email'),
  };

  let clientes = [];
  let usingNewClient = false;

  async function loadClientes() {
    clientes = await DB.clientes.list();
    clienteSelect.innerHTML = '<option value="">Selecione um cliente...</option>' +
      clientes.map((c) => `<option value="${c.id}">${SB_UI.escapeHtml(c.nome)}</option>`).join('');
  }

  function setUsingNewClient(value) {
    usingNewClient = value;
    newClientBlock.style.display = value ? 'block' : 'none';
    existingClientBlock.style.display = value ? 'none' : 'flex';
    toggleNewClientLabel.textContent = value ? 'Selecionar cliente existente' : 'Cadastrar novo cliente';
    renderSummary();
  }

  toggleNewClientBtn.addEventListener('click', () => setUsingNewClient(!usingNewClient));

  ['input', 'change'].forEach((evt) => {
    form.addEventListener(evt, (e) => {
      if (e.target.closest('.form-steps')) renderSummary();
    });
  });
  clienteSelect.addEventListener('change', renderSummary);

  function currentClientLabel() {
    if (usingNewClient) return els.novoNome.value.trim() || 'Novo cliente';
    const c = clientes.find((x) => x.id === clienteSelect.value);
    return c ? c.nome : null;
  }

  function parseValor() {
    const raw = els.valor.value.replace(/\./g, '').replace(',', '.').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function renderSummary() {
    const nome = currentClientLabel();
    const valor = parseValor();
    const body = document.getElementById('summary-body');

    if (!nome && !els.descricao.value && !valor) {
      body.innerHTML = `
        <div class="summary-placeholder">
          ${SB_ICON.invoice}
          <p>Preencha os dados ao lado para visualizar o resumo da cobrança.</p>
        </div>`;
      return;
    }

    body.innerHTML = `
      <div class="summary-row"><span class="label">Cliente</span><span class="value">${SB_UI.escapeHtml(nome || '—')}</span></div>
      <div class="summary-row"><span class="label">Descrição</span><span class="value">${SB_UI.escapeHtml(els.descricao.value || '—')}</span></div>
      <div class="summary-row"><span class="label">Vencimento</span><span class="value">${els.vencimento.value ? SB_UI.formatDate(els.vencimento.value + 'T12:00:00') : '—'}</span></div>
      <div class="summary-total"><span class="label">Valor total</span><span class="value">${SB_UI.formatCurrency(valor)}</span></div>
    `;
  }

  function clearErrors() {
    form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
  }

  function setError(el, message) {
    el.classList.add('has-error');
    const err = document.createElement('div');
    err.className = 'field-error';
    err.textContent = message;
    el.closest('.field')?.appendChild(err);
  }

  function validate() {
    clearErrors();
    let valid = true;

    if (usingNewClient) {
      if (!els.novoNome.value.trim()) { setError(els.novoNome, 'Informe o nome do cliente.'); valid = false; }
      if (!els.novoWhatsapp.value.trim()) { setError(els.novoWhatsapp, 'Informe o WhatsApp do cliente.'); valid = false; }
    } else if (!clienteSelect.value) {
      setError(clienteSelect, 'Selecione um cliente.');
      valid = false;
    }

    if (!els.descricao.value.trim()) { setError(els.descricao, 'Descreva a cobrança.'); valid = false; }
    if (parseValor() <= 0) { setError(els.valor, 'Informe um valor válido.'); valid = false; }
    if (!els.vencimento.value) { setError(els.vencimento, 'Selecione a data de vencimento.'); valid = false; }

    return valid;
  }

  async function prefill() {
    if (!isEdit) {
      if (preselectClienteId && clientes.some((c) => c.id === preselectClienteId)) {
        clienteSelect.value = preselectClienteId;
      }
      renderSummary();
      return;
    }
    try {
      const cob = await DB.cobrancas.get(editId);
      if (!cob) {
        SB_UI.toast({ type: 'error', title: 'Cobrança não encontrada' });
        setTimeout(() => { window.location.href = 'cobrancas.html'; }, 900);
        return;
      }
      clienteSelect.value = cob.clienteId;
      els.descricao.value = cob.descricao;
      els.valor.value = String(cob.valor).replace('.', ',');
      els.vencimento.value = cob.vencimento.slice(0, 10);
      els.observacoes.value = cob.observacoes || '';
      els.sendWhatsapp.checked = Boolean(cob.enviarWhatsapp);
      els.sendEmail.checked = Boolean(cob.enviarEmail);
      renderSummary();
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Erro ao carregar cobrança' });
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) {
      SB_UI.toast({ type: 'error', title: 'Verifique os campos destacados' });
      return;
    }

    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    const originalLabel = document.getElementById('submit-btn-label').textContent;
    document.getElementById('submit-btn-label').textContent = 'Salvando...';

    try {
      let clienteId = clienteSelect.value;
      if (usingNewClient) {
        const novoCliente = await DB.clientes.create({
          nome: els.novoNome.value.trim(),
          whatsapp: els.novoWhatsapp.value.trim(),
          email: els.novoEmail.value.trim(),
        });
        clienteId = novoCliente.id;
      }

      const payload = {
        clienteId,
        descricao: els.descricao.value.trim(),
        valor: parseValor(),
        vencimento: new Date(`${els.vencimento.value}T12:00:00`).toISOString(),
        observacoes: els.observacoes.value.trim(),
        enviarWhatsapp: els.sendWhatsapp.checked,
        enviarEmail: els.sendEmail.checked,
      };

      let saved;
      if (isEdit) {
        saved = await DB.cobrancas.update(editId, payload);
      } else {
        saved = await DB.cobrancas.create(payload);
      }

      SB_UI.toast({ type: 'success', title: isEdit ? 'Cobrança atualizada' : 'Cobrança criada com sucesso', desc: saved.codigo });

      if (!isEdit) {
        const checkoutResult = await DB.cobrancas.generateCheckout(saved.id);
        if (checkoutResult?.success) {
          SB_UI.toast({ type: 'success', title: 'Link de pagamento criado com sucesso', desc: saved.codigo });
        } else {
          SB_UI.toast({ type: 'error', title: 'Cobrança criada, mas não foi possível gerar o checkout.', desc: 'Você pode gerar novamente em Cobranças.' });
        }
      }

      if (els.sendWhatsapp.checked && !isEdit) {
        try {
          if (saved?.cliente?.whatsapp) {
            const empresaAtual = await DB.empresa.get().catch(() => null);
            const message = SB_WA.chargeMessage(saved, empresaAtual?.nome || 'Smart Billing');
            const result = await DB.whatsapp.enqueue({
              messageType: 'charge',
              message,
              chargeId: saved.id,
              clientId: saved.clienteId,
              idempotencyKey: `charge:${saved.id}:create`,
            });
            if (result?.success) {
              SB_UI.toast({ type: 'success', title: 'Cobrança adicionada à fila do WhatsApp', desc: 'Será enviada quando o agente estiver conectado.' });
            } else {
              SB_UI.toast({ type: 'error', title: 'Não foi possível enfileirar o WhatsApp', desc: result?.message || 'Você pode reenviar em Cobranças.' });
            }
          } else {
            SB_UI.toast({ type: 'error', title: 'Cliente sem WhatsApp cadastrado', desc: 'A cobrança foi criada, mas não pôde ser enviada pelo WhatsApp.' });
          }
        } catch (err) {
          console.error('[Smart Billing] Falha ao enfileirar cobrança no WhatsApp:', err);
          SB_UI.toast({ type: 'error', title: 'Não foi possível enfileirar o WhatsApp', desc: 'Você pode reenviar em Cobranças.' });
        }
      }
      if (els.sendEmail.checked) {
        SB_UI.toast({ type: 'info', title: 'Envio de cobrança por e-mail ainda não disponível', desc: 'Use "Enviar por e-mail" nos recibos após a confirmação do pagamento.' });
      }

      setTimeout(() => { window.location.href = 'cobrancas.html'; }, 700);
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Não foi possível salvar', desc: 'Tente novamente em instantes.' });
      submitBtn.disabled = false;
      document.getElementById('submit-btn-label').textContent = originalLabel;
    }
  });

  await loadClientes();
  await prefill();
})();
