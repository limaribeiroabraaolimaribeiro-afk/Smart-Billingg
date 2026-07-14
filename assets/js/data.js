/* ==========================================================================
   Smart Billing — Data layer
   --------------------------------------------------------------------------
   Camada de acesso a dados com API assíncrona (Promise-based), no mesmo
   formato de um client Supabase (`await DB.cobrancas.list()`).
   Hoje os dados são simulados e persistidos em localStorage. Para integrar
   com Supabase, basta substituir a implementação interna de cada método
   mantendo a mesma assinatura — nenhuma página precisa mudar.
   ========================================================================== */

const DB = (() => {
  const STORAGE_KEY = 'smart_billing_demo_v1';
  const NETWORK_DELAY = 320;

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function delay(fn) {
    return new Promise((resolve) => setTimeout(() => resolve(fn()), NETWORK_DELAY));
  }

  function daysFromToday(n) {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  }

  function seed() {
    const clientes = [
      { id: 'cli_1', nome: 'Marina Souza Alves', whatsapp: '11987654321', email: 'marina.alves@email.com', criadoEm: daysFromToday(-120) },
      { id: 'cli_2', nome: 'Carlos Eduardo Lima', whatsapp: '21976543210', email: 'carlos.lima@email.com', criadoEm: daysFromToday(-95) },
      { id: 'cli_3', nome: 'Studio Nova Design Ltda', whatsapp: '11965432109', email: 'contato@studionova.com', criadoEm: daysFromToday(-80) },
      { id: 'cli_4', nome: 'Fernanda Ribeiro Costa', whatsapp: '31954321098', email: 'fernanda.costa@email.com', criadoEm: daysFromToday(-70) },
      { id: 'cli_5', nome: 'João Pedro Martins', whatsapp: '41943210987', email: 'joaopedro.martins@email.com', criadoEm: daysFromToday(-60) },
      { id: 'cli_6', nome: 'Academia Corpo & Cia', whatsapp: '11932109876', email: 'financeiro@corpoecia.com', criadoEm: daysFromToday(-55) },
      { id: 'cli_7', nome: 'Beatriz Nogueira Dias', whatsapp: '51921098765', email: 'bia.dias@email.com', criadoEm: daysFromToday(-40) },
      { id: 'cli_8', nome: 'Rafael Augusto Pereira', whatsapp: '19910987654', email: 'rafael.pereira@email.com', criadoEm: daysFromToday(-30) },
      { id: 'cli_9', nome: 'Clínica Vitalis Odontologia', whatsapp: '11909876543', email: 'contato@vitalisodonto.com', criadoEm: daysFromToday(-20) },
      { id: 'cli_10', nome: 'Lucas Gabriel Ferreira', whatsapp: '85998765432', email: 'lucas.ferreira@email.com', criadoEm: daysFromToday(-10) },
    ];

    const cobrancaSeeds = [
      { cli: 'cli_1', desc: 'Consultoria de marketing digital — junho', valor: 1850, venc: -2, status: 'atrasado', forma: 'pix' },
      { cli: 'cli_2', desc: 'Mensalidade plano Premium', valor: 349.9, venc: -1, status: 'atrasado', forma: 'cartao', parcelas: 3 },
      { cli: 'cli_3', desc: 'Projeto identidade visual completa', valor: 4200, venc: 0, status: 'pago', forma: 'pix' },
      { cli: 'cli_4', desc: 'Sessão fotográfica — ensaio corporativo', valor: 780, venc: 0, status: 'pago', forma: 'cartao', parcelas: 2 },
      { cli: 'cli_5', desc: 'Manutenção mensal de sistema', valor: 590, venc: 3, status: 'pendente', forma: 'pix' },
      { cli: 'cli_6', desc: 'Plano anual — 12 matrículas', valor: 5760, venc: 5, status: 'pendente', forma: 'cartao', parcelas: 12 },
      { cli: 'cli_7', desc: 'Consultoria jurídica — contrato', valor: 1200, venc: 7, status: 'pendente', forma: 'pix' },
      { cli: 'cli_8', desc: 'Desenvolvimento landing page', valor: 2500, venc: -5, status: 'atrasado', forma: 'cartao', parcelas: 4 },
      { cli: 'cli_9', desc: 'Tratamento ortodôntico — parcela 3/10', valor: 320, venc: 1, status: 'pendente', forma: 'cartao', parcelas: 10 },
      { cli: 'cli_10', desc: 'Assinatura mensal SaaS', valor: 129.9, venc: -1, status: 'pago', forma: 'pix' },
      { cli: 'cli_1', desc: 'Gestão de tráfego pago — julho', valor: 2100, venc: 12, status: 'pendente', forma: 'pix' },
      { cli: 'cli_2', desc: 'Renovação plano Premium', valor: 349.9, venc: -30, status: 'pago', forma: 'cartao', parcelas: 1 },
      { cli: 'cli_3', desc: 'Manual de marca — revisão', valor: 950, venc: -45, status: 'cancelado', forma: 'pix' },
      { cli: 'cli_4', desc: 'Cobertura evento corporativo', valor: 1600, venc: -12, status: 'pago', forma: 'pix' },
      { cli: 'cli_5', desc: 'Suporte técnico avulso', valor: 210, venc: -3, status: 'pago', forma: 'pix' },
      { cli: 'cli_6', desc: 'Aulas particulares — pacote 10x', valor: 890, venc: 15, status: 'pendente', forma: 'cartao', parcelas: 2 },
      { cli: 'cli_7', desc: 'Elaboração de contrato social', valor: 680, venc: -20, status: 'pago', forma: 'pix' },
      { cli: 'cli_8', desc: 'Manutenção landing page', valor: 350, venc: 20, status: 'pendente', forma: 'pix' },
      { cli: 'cli_9', desc: 'Limpeza e avaliação', valor: 180, venc: -60, status: 'cancelado', forma: 'pix' },
      { cli: 'cli_10', desc: 'Upgrade de plano anual', valor: 1299, venc: 25, status: 'pendente', forma: 'cartao', parcelas: 6 },
      { cli: 'cli_1', desc: 'Relatório de performance — maio', valor: 450, venc: -33, status: 'pago', forma: 'pix' },
      { cli: 'cli_3', desc: 'Cartões de visita + papelaria', valor: 620, venc: 2, status: 'pendente', forma: 'cartao', parcelas: 1 },
      { cli: 'cli_8', desc: 'Hospedagem anual', valor: 480, venc: -8, status: 'atrasado', forma: 'pix' },
      { cli: 'cli_6', desc: 'Avaliação física + plano alimentar', valor: 240, venc: 0, status: 'pago', forma: 'pix' },
    ];

    let seq = 1000;
    const cobrancas = cobrancaSeeds.map((c) => {
      seq += 1;
      const venc = daysFromToday(c.venc);
      const criadoEm = daysFromToday(c.venc - 14);
      const pagoEm = c.status === 'pago' ? daysFromToday(Math.min(c.venc, 0) - 1) : null;
      return {
        id: uid('cob'),
        codigo: `SB-${seq}`,
        clienteId: c.cli,
        descricao: c.desc,
        valor: c.valor,
        vencimento: venc,
        status: c.status,
        formaPagamento: c.forma,
        parcelas: c.parcelas || 1,
        observacoes: '',
        enviarWhatsapp: true,
        enviarEmail: false,
        criadoEm,
        pagoEm,
      };
    });

    const pagamentos = cobrancas
      .filter((c) => c.status === 'pago')
      .map((c) => ({
        id: uid('pag'),
        cobrancaId: c.id,
        clienteId: c.clienteId,
        valor: c.valor,
        forma: c.formaPagamento,
        parcelas: c.parcelas,
        dataHora: c.pagoEm,
        codigoTransacao: `TXN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        status: 'confirmado',
      }));

    const recibos = pagamentos.map((p, i) => ({
      id: uid('rec'),
      numero: `REC-${String(2000 + i).padStart(6, '0')}`,
      cobrancaId: p.cobrancaId,
      pagamentoId: p.id,
      clienteId: p.clienteId,
      geradoEm: p.dataHora,
    }));

    return { clientes, cobrancas, pagamentos, recibos, empresa: {
      nome: 'Smart Billing Serviços Digitais Ltda',
      cnpj: '32.145.678/0001-90',
      email: 'financeiro@smartbilling.com.br',
      telefone: '(11) 4000-1234',
      admin: { nome: 'Abraão Ribeiro', email: 'limaribeiroabraaolimaribeiro@gmail.com', cargo: 'Administrador' },
    } };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupted storage */ }
    const fresh = seed();
    save(fresh);
    return fresh;
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = load();

  function persist() { save(state); }

  function computeStatus(cobranca) {
    if (cobranca.status === 'pago' || cobranca.status === 'cancelado') return cobranca.status;
    const isOverdue = new Date(cobranca.vencimento) < new Date(new Date().toDateString());
    return isOverdue ? 'atrasado' : 'pendente';
  }

  function withComputedStatus(c) {
    return { ...c, status: computeStatus(c) };
  }

  // ---------------- Clientes ----------------
  const clientes = {
    list() {
      return delay(() => state.clientes.map((c) => ({ ...c })));
    },
    get(id) {
      return delay(() => {
        const c = state.clientes.find((x) => x.id === id);
        return c ? { ...c } : null;
      });
    },
    create(payload) {
      return delay(() => {
        const novo = { id: uid('cli'), criadoEm: new Date().toISOString(), ...payload };
        state.clientes.unshift(novo);
        persist();
        return { ...novo };
      });
    },
    update(id, payload) {
      return delay(() => {
        const idx = state.clientes.findIndex((c) => c.id === id);
        if (idx === -1) throw new Error('Cliente não encontrado');
        state.clientes[idx] = { ...state.clientes[idx], ...payload };
        persist();
        return { ...state.clientes[idx] };
      });
    },
    remove(id) {
      return delay(() => {
        state.clientes = state.clientes.filter((c) => c.id !== id);
        persist();
        return true;
      });
    },
    stats(id) {
      return delay(() => {
        const cobs = state.cobrancas.filter((c) => c.clienteId === id).map(withComputedStatus);
        const totalRecebido = cobs.filter((c) => c.status === 'pago').reduce((s, c) => s + c.valor, 0);
        const totalPendente = cobs.filter((c) => c.status === 'pendente' || c.status === 'atrasado').reduce((s, c) => s + c.valor, 0);
        const ultima = cobs.sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm))[0];
        return {
          quantidade: cobs.length,
          totalRecebido,
          totalPendente,
          ultimaCobranca: ultima ? ultima.criadoEm : null,
          cobrancas: cobs.sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm)),
        };
      });
    },
    listWithStats() {
      return delay(() => state.clientes.map((cliente) => {
        const cobs = state.cobrancas.filter((c) => c.clienteId === cliente.id).map(withComputedStatus);
        const totalRecebido = cobs.filter((c) => c.status === 'pago').reduce((s, c) => s + c.valor, 0);
        const totalPendente = cobs.filter((c) => c.status === 'pendente' || c.status === 'atrasado').reduce((s, c) => s + c.valor, 0);
        const ultima = [...cobs].sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm))[0];
        return {
          ...cliente,
          quantidade: cobs.length,
          totalRecebido,
          totalPendente,
          ultimaCobranca: ultima ? ultima.criadoEm : null,
        };
      }));
    },
  };

  // ---------------- Cobranças ----------------
  const cobrancas = {
    list() {
      return delay(() => state.cobrancas.map(withComputedStatus).map((c) => ({
        ...c,
        cliente: state.clientes.find((cl) => cl.id === c.clienteId) || null,
      })));
    },
    get(id) {
      return delay(() => {
        const c = state.cobrancas.find((x) => x.id === id);
        if (!c) return null;
        return { ...withComputedStatus(c), cliente: state.clientes.find((cl) => cl.id === c.clienteId) || null };
      });
    },
    create(payload) {
      return delay(() => {
        const seq = 1000 + state.cobrancas.length + 1;
        const nova = {
          id: uid('cob'),
          codigo: `SB-${seq}`,
          status: 'pendente',
          criadoEm: new Date().toISOString(),
          pagoEm: null,
          parcelas: 1,
          ...payload,
        };
        state.cobrancas.unshift(nova);
        persist();
        return { ...nova };
      });
    },
    update(id, payload) {
      return delay(() => {
        const idx = state.cobrancas.findIndex((c) => c.id === id);
        if (idx === -1) throw new Error('Cobrança não encontrada');
        state.cobrancas[idx] = { ...state.cobrancas[idx], ...payload };
        persist();
        return { ...state.cobrancas[idx] };
      });
    },
    cancel(id) {
      return delay(() => {
        const idx = state.cobrancas.findIndex((c) => c.id === id);
        if (idx === -1) throw new Error('Cobrança não encontrada');
        state.cobrancas[idx].status = 'cancelado';
        persist();
        return { ...state.cobrancas[idx] };
      });
    },
    markPaid(id, { forma = 'pix', parcelas = 1 } = {}) {
      return delay(() => {
        const idx = state.cobrancas.findIndex((c) => c.id === id);
        if (idx === -1) throw new Error('Cobrança não encontrada');
        const cob = state.cobrancas[idx];
        cob.status = 'pago';
        cob.pagoEm = new Date().toISOString();
        persist();

        const pagamento = {
          id: uid('pag'),
          cobrancaId: cob.id,
          clienteId: cob.clienteId,
          valor: cob.valor,
          forma,
          parcelas,
          dataHora: cob.pagoEm,
          codigoTransacao: `TXN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
          status: 'confirmado',
        };
        state.pagamentos.unshift(pagamento);

        const recibo = {
          id: uid('rec'),
          numero: `REC-${String(2000 + state.recibos.length).padStart(6, '0')}`,
          cobrancaId: cob.id,
          pagamentoId: pagamento.id,
          clienteId: cob.clienteId,
          geradoEm: pagamento.dataHora,
        };
        state.recibos.unshift(recibo);
        persist();
        return { cobranca: { ...cob }, pagamento, recibo };
      });
    },
  };

  // ---------------- Pagamentos ----------------
  const pagamentos = {
    list() {
      return delay(() => state.pagamentos.map((p) => ({
        ...p,
        cliente: state.clientes.find((c) => c.id === p.clienteId) || null,
        cobranca: state.cobrancas.find((c) => c.id === p.cobrancaId) || null,
      })));
    },
  };

  // ---------------- Recibos ----------------
  const recibos = {
    list() {
      return delay(() => state.recibos.map((r) => ({
        ...r,
        cliente: state.clientes.find((c) => c.id === r.clienteId) || null,
        cobranca: state.cobrancas.find((c) => c.id === r.cobrancaId) || null,
        pagamento: state.pagamentos.find((p) => p.id === r.pagamentoId) || null,
      })));
    },
  };

  // ---------------- Dashboard ----------------
  const dashboard = {
    summary() {
      return delay(() => {
        const all = state.cobrancas.map(withComputedStatus);
        const now = new Date();
        const todayStr = now.toDateString();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const pagas = all.filter((c) => c.status === 'pago');
        const totalRecebidoMes = pagas
          .filter((c) => c.pagoEm && new Date(c.pagoEm) >= startOfMonth)
          .reduce((s, c) => s + c.valor, 0);
        const totalRecebidoMesAnterior = pagas
          .filter((c) => c.pagoEm && new Date(c.pagoEm) >= startOfLastMonth && new Date(c.pagoEm) < startOfMonth)
          .reduce((s, c) => s + c.valor, 0);

        const pendentes = all.filter((c) => c.status === 'pendente');
        const atrasadas = all.filter((c) => c.status === 'atrasado');
        const pagasHoje = pagas.filter((c) => c.pagoEm && new Date(c.pagoEm).toDateString() === todayStr);
        const vencendo = pendentes.filter((c) => {
          const dias = (new Date(c.vencimento) - now) / 86400000;
          return dias >= 0 && dias <= 7;
        });

        const pctChange = totalRecebidoMesAnterior > 0
          ? ((totalRecebidoMes - totalRecebidoMesAnterior) / totalRecebidoMesAnterior) * 100
          : null;

        return {
          totalRecebido: { valor: totalRecebidoMes, quantidade: pagas.filter((c) => c.pagoEm && new Date(c.pagoEm) >= startOfMonth).length, variacao: pctChange },
          pendentes: { valor: pendentes.reduce((s, c) => s + c.valor, 0), quantidade: pendentes.length },
          pagasHoje: { valor: pagasHoje.reduce((s, c) => s + c.valor, 0), quantidade: pagasHoje.length },
          vencendo: { valor: vencendo.reduce((s, c) => s + c.valor, 0), quantidade: vencendo.length },
          atrasadas: { valor: atrasadas.reduce((s, c) => s + c.valor, 0), quantidade: atrasadas.length },
        };
      });
    },
    recent(limit = 8) {
      return delay(() => state.cobrancas
        .map(withComputedStatus)
        .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm))
        .slice(0, limit)
        .map((c) => ({ ...c, cliente: state.clientes.find((cl) => cl.id === c.clienteId) || null })));
    },
  };

  const empresa = {
    get() {
      return delay(() => ({ ...state.empresa }));
    },
    update(payload) {
      return delay(() => {
        state.empresa = { ...state.empresa, ...payload };
        persist();
        return { ...state.empresa };
      });
    },
  };

  return { clientes, cobrancas, pagamentos, recibos, dashboard, empresa };
})();
