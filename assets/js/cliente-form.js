/* ==========================================================================
   Smart Billing — Novo / Editar cliente
   ========================================================================== */

(async function initClienteForm() {
  const session = await SB_AUTH.requireSession();
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const editId = params.get('id');
  const isEdit = Boolean(editId);

  await SBLayout.mount({
    active: 'clientes',
    title: isEdit ? 'Editar cliente' : 'Novo cliente',
    breadcrumb: `Painel <span>/</span> Clientes <span>/</span> ${isEdit ? 'Editar' : 'Novo'}`,
  });

  if (isEdit) {
    document.getElementById('form-title').textContent = 'Editar cliente';
    document.getElementById('submit-btn-label').textContent = 'Salvar alterações';
    document.title = 'Editar cliente · Smart Billing';
  }

  const form = document.getElementById('cliente-form');
  const els = {
    nome: document.getElementById('nome'),
    whatsapp: document.getElementById('whatsapp'),
    email: document.getElementById('email'),
  };

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
    if (!els.nome.value.trim()) { setError(els.nome, 'Informe o nome do cliente.'); valid = false; }
    if (!els.whatsapp.value.trim()) { setError(els.whatsapp, 'Informe o WhatsApp do cliente.'); valid = false; }
    if (els.email.value.trim() && !/^\S+@\S+\.\S+$/.test(els.email.value.trim())) {
      setError(els.email, 'Informe um e-mail válido.'); valid = false;
    }
    return valid;
  }

  if (isEdit) {
    try {
      const cliente = await DB.clientes.get(editId);
      if (!cliente) {
        SB_UI.toast({ type: 'error', title: 'Cliente não encontrado' });
        setTimeout(() => { window.location.href = 'clientes.html'; }, 900);
      } else {
        els.nome.value = cliente.nome;
        els.whatsapp.value = cliente.whatsapp;
        els.email.value = cliente.email || '';
      }
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Erro ao carregar cliente' });
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

    const payload = {
      nome: els.nome.value.trim(),
      whatsapp: els.whatsapp.value.trim(),
      email: els.email.value.trim(),
    };

    try {
      if (isEdit) {
        await DB.clientes.update(editId, payload);
        SB_UI.toast({ type: 'success', title: 'Cliente atualizado com sucesso' });
      } else {
        await DB.clientes.create(payload);
        SB_UI.toast({ type: 'success', title: 'Cliente cadastrado com sucesso' });
      }
      setTimeout(() => { window.location.href = 'clientes.html'; }, 600);
    } catch (err) {
      SB_UI.toast({ type: 'error', title: 'Não foi possível salvar', desc: 'Tente novamente em instantes.' });
      submitBtn.disabled = false;
    }
  });
})();
