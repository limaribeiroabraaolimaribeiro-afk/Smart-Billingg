/* ==========================================================================
   Smart Billing — Novo / Editar plano
   ========================================================================== */

(async function initPlanoForm() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const editId = params.get('id');
  const isEdit = Boolean(editId);

  await SBLayout.mount({
    active: 'planos',
    title: isEdit ? 'Editar plano' : 'Novo plano',
    breadcrumb: `Painel <span>/</span> Planos <span>/</span> ${isEdit ? 'Editar' : 'Novo'}`,
    hidePrimaryAction: true,
  });

  if (isEdit) {
    document.getElementById('form-title').textContent = 'Editar plano';
    document.getElementById('submit-btn-label').textContent = 'Salvar alterações';
    document.title = 'Editar plano · Smart Billing';
  }

  const form = document.getElementById('plano-form');
  const els = {
    nome: document.getElementById('nome'),
    descricaoCurta: document.getElementById('descricaoCurta'),
    badge: document.getElementById('badge'),
    descricao: document.getElementById('descricao'),
    valor: document.getElementById('valor'),
    valorReferencia: document.getElementById('valorReferencia'),
    duracaoMeses: document.getElementById('duracaoMeses'),
    descontoPercent: document.getElementById('descontoPercent'),
    parcelas: document.getElementById('parcelas'),
    payPix: document.getElementById('pay-pix'),
    payCartao: document.getElementById('pay-cartao'),
    destaque: document.getElementById('destaque'),
    ativo: document.getElementById('ativo'),
  };

  // Máximo 12 parcelas — a InfinitePay não confirma suporte a mais que isso
  // nesta integração (ver docs/PLANOS_E_ASSINATURAS.md).
  for (let n = 1; n <= 12; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === 1 ? '1x (à vista)' : `${n}x`;
    els.parcelas.appendChild(opt);
  }
  els.parcelas.value = '12';

  function wireToggle(inputEl) {
    const label = inputEl.closest('.option-toggle');
    const sync = () => label.classList.toggle('is-checked', inputEl.checked);
    inputEl.addEventListener('change', sync);
    sync();
  }
  [els.payPix, els.payCartao, els.destaque, els.ativo].forEach(wireToggle);
  document.querySelectorAll('input[name="tipo"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('#tipo-onetime, #tipo-recorrente').forEach((el) => el.classList.remove('is-checked'));
      radio.closest('.option-toggle').classList.add('is-checked');
      updateDuracaoLabel();
    });
  });
  document.getElementById('tipo-onetime').classList.add('is-checked');

  function updateDuracaoLabel() {
    const tipo = document.querySelector('input[name="tipo"]:checked').value;
    const label = document.getElementById('duracao-label');
    if (tipo === 'recurring_monthly') {
      label.textContent = 'Ciclo de cobrança (meses)';
      if (!els.duracaoMeses.value) els.duracaoMeses.value = '1';
    } else {
      label.textContent = 'Duração (meses)';
    }
  }
  updateDuracaoLabel();

  function parseMoeda(input) {
    const raw = input.value.replace(/\./g, '').replace(',', '.').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
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
    if (!els.nome.value.trim()) { setError(els.nome, 'Informe o nome do plano.'); valid = false; }
    if (parseMoeda(els.valor) <= 0) { setError(els.valor, 'Informe um preço válido.'); valid = false; }
    const refValor = els.valorReferencia.value.trim() ? parseMoeda(els.valorReferencia) : null;
    if (refValor != null && refValor < parseMoeda(els.valor)) {
      setError(els.valorReferencia, 'O preço de referência deve ser maior ou igual ao preço.'); valid = false;
    }
    const duracao = Number(els.duracaoMeses.value);
    if (!Number.isFinite(duracao) || duracao < 1) { setError(els.duracaoMeses, 'Informe a duração em meses.'); valid = false; }
    if (!els.payPix.checked && !els.payCartao.checked) {
      SB_UI.toast({ type: 'error', title: 'Selecione ao menos uma forma de pagamento' });
      valid = false;
    }
    return valid;
  }

  function fillForm(p) {
    els.nome.value = p.nome;
    els.descricaoCurta.value = p.descricaoCurta || '';
    els.badge.value = p.badge || '';
    els.descricao.value = p.descricao || '';
    els.valor.value = String(p.valor).replace('.', ',');
    els.valorReferencia.value = p.valorReferencia != null ? String(p.valorReferencia).replace('.', ',') : '';
    els.duracaoMeses.value = p.duracaoMeses;
    els.descontoPercent.value = p.descontoPercent || 0;
    els.parcelas.value = String(p.parcelas || 12);
    els.payPix.checked = p.formaPagamento === 'pix' || p.formaPagamento === 'ambos';
    els.payCartao.checked = p.formaPagamento === 'cartao' || p.formaPagamento === 'ambos';
    els.destaque.checked = !!p.destaque;
    els.ativo.checked = p.ativo !== false;
    document.querySelector(`input[name="tipo"][value="${p.tipoCobranca}"]`).checked = true;
    [els.payPix, els.payCartao, els.destaque, els.ativo].forEach((inp) => inp.closest('.option-toggle').classList.toggle('is-checked', inp.checked));
    document.getElementById('tipo-onetime').classList.toggle('is-checked', p.tipoCobranca === 'one_time');
    document.getElementById('tipo-recorrente').classList.toggle('is-checked', p.tipoCobranca === 'recurring_monthly');
    updateDuracaoLabel();
  }

  if (isEdit) {
    try {
      const plano = await DB.planos.get(editId);
      if (!plano) {
        SB_UI.toast({ type: 'error', title: 'Plano não encontrado' });
        setTimeout(() => { window.location.href = 'planos.html'; }, 900);
      } else {
        fillForm(plano);
      }
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Erro ao carregar plano' });
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

    const formaPagamento = els.payPix.checked && els.payCartao.checked ? 'ambos' : (els.payCartao.checked ? 'cartao' : 'pix');

    const payload = {
      nome: els.nome.value.trim(),
      descricaoCurta: els.descricaoCurta.value.trim(),
      badge: els.badge.value.trim(),
      descricao: els.descricao.value.trim(),
      valor: parseMoeda(els.valor),
      valorReferencia: els.valorReferencia.value.trim() ? parseMoeda(els.valorReferencia) : null,
      duracaoMeses: Number(els.duracaoMeses.value),
      descontoPercent: Number(els.descontoPercent.value) || 0,
      tipoCobranca: document.querySelector('input[name="tipo"]:checked').value,
      formaPagamento,
      parcelas: Number(els.parcelas.value),
      destaque: els.destaque.checked,
      ativo: els.ativo.checked,
    };

    try {
      if (isEdit) {
        await DB.planos.update(editId, payload);
        SB_UI.toast({ type: 'success', title: 'Plano atualizado com sucesso' });
      } else {
        await DB.planos.create(payload);
        SB_UI.toast({ type: 'success', title: 'Plano criado com sucesso' });
      }
      setTimeout(() => { window.location.href = 'planos.html'; }, 600);
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Não foi possível salvar', desc: err?.message || 'Tente novamente em instantes.' });
      submitBtn.disabled = false;
    }
  });
})();
