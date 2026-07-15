/* ==========================================================================
   Smart Billing — Data layer
   --------------------------------------------------------------------------
   Camada de acesso a dados com API assíncrona (Promise-based). Exporta o
   mesmo objeto `DB` (DB.clientes, DB.cobrancas, DB.pagamentos, DB.recibos,
   DB.dashboard, DB.empresa) independentemente do backend usado por baixo —
   nenhuma página precisa saber se os dados vêm do Supabase ou de dados
   simulados.

   - Modo demonstração (config.js → useDemoMode: true): dados simulados
     persistidos em localStorage (implementação em `buildDemoBackend`).
   - Modo real (Supabase configurado): consultas reais ao Postgres via
     supabase-js, respeitando RLS (implementação em `buildSupabaseBackend`).

   Os dois backends devolvem exatamente o mesmo formato de objeto em
   português (cliente.nome, cobranca.descricao, cobranca.valor, ...), então
   a camada de mapeamento (snake_case do banco -> camelCase em português)
   fica isolada aqui dentro.
   ========================================================================== */

const DB = (() => {
  const cfg = window.SMART_BILLING_CONFIG || {};
  const supabaseReady = typeof SB_SUPABASE !== 'undefined' && Boolean(SB_SUPABASE?.isConfigured);
  const useDemo = Boolean(cfg.useDemoMode) || !supabaseReady;

  // ==========================================================================
  // Helpers compartilhados (usados pelos dois backends)
  // ==========================================================================
  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function computeEffectiveStatus(status, dueDateLike) {
    if (status === 'pago' || status === 'cancelado') return status;
    const isOverdue = new Date(dueDateLike) < new Date(new Date().toDateString());
    return isOverdue ? 'atrasado' : 'pendente';
  }

  // Agregações puras reaproveitadas pelos dois backends para o dashboard.
  function aggregateDashboard(cobrancas) {
    const now = new Date();
    const todayStr = now.toDateString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const pagas = cobrancas.filter((c) => c.status === 'pago');
    const totalRecebidoMes = pagas
      .filter((c) => c.pagoEm && new Date(c.pagoEm) >= startOfMonth)
      .reduce((s, c) => s + c.valor, 0);
    const totalRecebidoMesAnterior = pagas
      .filter((c) => c.pagoEm && new Date(c.pagoEm) >= startOfLastMonth && new Date(c.pagoEm) < startOfMonth)
      .reduce((s, c) => s + c.valor, 0);

    const pendentes = cobrancas.filter((c) => c.status === 'pendente');
    const atrasadas = cobrancas.filter((c) => c.status === 'atrasado');
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
  }

  function aggregateClientStats(cobrancasDoCliente) {
    const totalRecebido = cobrancasDoCliente.filter((c) => c.status === 'pago').reduce((s, c) => s + c.valor, 0);
    const totalPendente = cobrancasDoCliente.filter((c) => c.status === 'pendente' || c.status === 'atrasado').reduce((s, c) => s + c.valor, 0);
    const ordenadas = [...cobrancasDoCliente].sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
    return {
      quantidade: cobrancasDoCliente.length,
      totalRecebido,
      totalPendente,
      ultimaCobranca: ordenadas[0] ? ordenadas[0].criadoEm : null,
      cobrancas: ordenadas,
    };
  }

  const STORAGE_KEY = 'smart_billing_demo_v1';

  // Usado pela ferramenta de migração em Configurações → Dados, mesmo quando
  // o backend ativo é o real (precisamos ler o localStorage "antigo").
  function readLocalDemoSnapshot() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  // ==========================================================================
  // BACKEND DE DEMONSTRAÇÃO (localStorage)
  // ==========================================================================
  function buildDemoBackend() {
    const NETWORK_DELAY = 320;

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
          publicToken: uid('tok'),
          checkoutUrl: null,
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
        publicToken: uid('tok'),
        geradoEm: p.dataHora,
      }));

      return {
        clientes, cobrancas, pagamentos, recibos,
        empresa: {
          nome: 'Smart Billing Serviços Digitais Ltda',
          cnpj: '32.145.678/0001-90',
          email: 'financeiro@smartbilling.com.br',
          telefone: '(11) 4000-1234',
          admin: { nome: 'Abraão Ribeiro', email: 'limaribeiroabraaolimaribeiro@gmail.com', cargo: 'Administrador' },
        },
      };
    }

    function load() {
      const existing = readLocalDemoSnapshot();
      if (existing) return existing;
      const fresh = seed();
      save(fresh);
      return fresh;
    }

    function save(state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    let state = load();
    function persist() { save(state); }

    function withComputedStatus(c) {
      return { ...c, status: computeEffectiveStatus(c.status, c.vencimento) };
    }

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
          return aggregateClientStats(cobs);
        });
      },
      listWithStats() {
        return delay(() => state.clientes.map((cliente) => {
          const cobs = state.cobrancas.filter((c) => c.clienteId === cliente.id).map(withComputedStatus);
          const stats = aggregateClientStats(cobs);
          return { ...cliente, quantidade: stats.quantidade, totalRecebido: stats.totalRecebido, totalPendente: stats.totalPendente, ultimaCobranca: stats.ultimaCobranca };
        }));
      },
    };

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
      getByPublicToken(token) {
        return delay(() => {
          const c = state.cobrancas.find((x) => x.publicToken === token);
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
            publicToken: uid('tok'),
            checkoutUrl: null,
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
            publicToken: uid('tok'),
            geradoEm: pagamento.dataHora,
          };
          state.recibos.unshift(recibo);
          persist();
          return { cobranca: { ...cob }, pagamento, recibo };
        });
      },
      // Sem integração real disponível em modo de demonstração — não simula
      // aprovação nem gera link de checkout falso.
      generateCheckout() {
        return delay(() => ({ success: false, message: 'Checkout indisponível em modo de demonstração.' }));
      },
      checkInfinitePayPayment() {
        return delay(() => ({ success: false, paid: false }));
      },
    };

    const pagamentos = {
      list() {
        return delay(() => state.pagamentos.map((p) => ({
          ...p,
          cliente: state.clientes.find((c) => c.id === p.clienteId) || null,
          cobranca: state.cobrancas.find((c) => c.id === p.cobrancaId) || null,
        })));
      },
    };

    const recibos = {
      list() {
        return delay(() => state.recibos.map((r) => ({
          ...r,
          cliente: state.clientes.find((c) => c.id === r.clienteId) || null,
          cobranca: state.cobrancas.find((c) => c.id === r.cobrancaId) || null,
          pagamento: state.pagamentos.find((p) => p.id === r.pagamentoId) || null,
        })));
      },
      getByPublicToken(token) {
        return delay(() => {
          const r = state.recibos.find((x) => x.publicToken === token);
          if (!r) return null;
          return {
            ...r,
            cliente: state.clientes.find((c) => c.id === r.clienteId) || null,
            cobranca: state.cobrancas.find((c) => c.id === r.cobrancaId) || null,
            pagamento: state.pagamentos.find((p) => p.id === r.pagamentoId) || null,
          };
        });
      },
    };

    const dashboard = {
      summary() {
        return delay(() => aggregateDashboard(state.cobrancas.map(withComputedStatus)));
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
          state.empresa = { ...state.empresa, ...payload, admin: { ...state.empresa.admin, ...(payload.admin || {}) } };
          persist();
          return { ...state.empresa };
        });
      },
    };

    return { clientes, cobrancas, pagamentos, recibos, dashboard, empresa };
  }

  // ==========================================================================
  // BACKEND REAL (Supabase / Postgres)
  // ==========================================================================
  function buildSupabaseBackend() {
    const client = SB_SUPABASE.client;

    function unwrap({ data, error }) {
      if (error) throw new Error(error.message || 'Erro ao acessar o Supabase.');
      return data;
    }

    let cachedCompanyId = null;
    async function getCompanyId() {
      if (cachedCompanyId) return cachedCompanyId;
      const data = unwrap(await client.rpc('my_default_company_id'));
      if (!data) throw new Error('Nenhuma empresa encontrada para este usuário.');
      cachedCompanyId = data;
      return cachedCompanyId;
    }

    let cachedUserId = null;
    async function getUserId() {
      if (cachedUserId) return cachedUserId;
      const { data, error } = await client.auth.getUser();
      if (error) throw new Error(error.message);
      cachedUserId = data?.user?.id || null;
      return cachedUserId;
    }

    // ---------------- mapeamento snake_case (DB) <-> português (frontend) ----------------
    function mapClient(row) {
      if (!row) return null;
      return {
        id: row.id,
        nome: row.name,
        whatsapp: row.whatsapp || '',
        email: row.email || '',
        documento: row.document || '',
        observacoes: row.notes || '',
        status: row.status,
        criadoEm: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    function paymentMethodsToForma(arr) {
      const has = (m) => Array.isArray(arr) && arr.includes(m);
      if (has('pix') && has('cartao')) return 'ambos';
      if (has('cartao')) return 'cartao';
      return 'pix';
    }
    function formaToPaymentMethods(forma) {
      if (forma === 'ambos') return ['pix', 'cartao'];
      if (forma === 'cartao') return ['cartao'];
      return ['pix'];
    }
    function statusFromDb(row) {
      if (row.status === 'paid') return 'pago';
      if (row.status === 'cancelled') return 'cancelado';
      return computeEffectiveStatus('pendente', `${row.due_date}T12:00:00`);
    }

    function mapCharge(row) {
      if (!row) return null;
      return {
        id: row.id,
        codigo: row.charge_number,
        clienteId: row.client_id,
        descricao: row.description,
        valor: Number(row.amount),
        vencimento: `${row.due_date}T12:00:00`,
        status: statusFromDb(row),
        formaPagamento: paymentMethodsToForma(row.payment_methods),
        parcelas: row.max_installments,
        observacoes: row.notes || '',
        publicToken: row.public_token,
        checkoutUrl: row.checkout_url,
        provider: row.provider,
        criadoEm: row.created_at,
        pagoEm: row.paid_at,
        canceladoEm: row.cancelled_at,
        cliente: row.client ? mapClient(row.client) : null,
      };
    }

    function mapPayment(row) {
      if (!row) return null;
      return {
        id: row.id,
        cobrancaId: row.charge_id,
        valor: Number(row.gross_amount),
        forma: row.payment_method,
        parcelas: row.installments,
        dataHora: row.paid_at || row.created_at,
        codigoTransacao: row.provider_transaction_id || row.id,
        status: row.status === 'approved' ? 'confirmado' : row.status,
        cliente: row.charge?.client ? mapClient(row.charge.client) : null,
        cobranca: row.charge ? { codigo: row.charge.charge_number } : null,
      };
    }

    function mapReceipt(row) {
      if (!row) return null;
      return {
        id: row.id,
        numero: row.receipt_number,
        cobrancaId: row.charge_id,
        pagamentoId: row.payment_id,
        publicToken: row.public_token,
        geradoEm: row.issued_at,
        cliente: row.charge?.client ? mapClient(row.charge.client) : null,
        cobranca: row.charge ? { codigo: row.charge.charge_number, descricao: row.charge.description } : null,
        pagamento: row.payment ? { valor: Number(row.payment.gross_amount), forma: row.payment.payment_method } : null,
      };
    }

    const CHARGE_SELECT = '*, client:clients(id, name, whatsapp, email, document, notes, status, created_at, updated_at)';
    const PAYMENT_SELECT = '*, charge:charges(charge_number, client:clients(id, name, whatsapp, email))';
    const RECEIPT_SELECT = '*, charge:charges(charge_number, description, client:clients(id, name, whatsapp, email)), payment:payments(gross_amount, payment_method, paid_at)';

    // ---------------- clientes ----------------
    const clientes = {
      async list() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('clients').select('*').eq('company_id', companyId).order('name'));
        return data.map(mapClient);
      },
      async get(id) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('clients').select('*').eq('company_id', companyId).eq('id', id).maybeSingle());
        return mapClient(data);
      },
      async create(payload) {
        const companyId = await getCompanyId();
        const row = unwrap(await client.from('clients').insert({
          company_id: companyId,
          name: payload.nome,
          whatsapp: payload.whatsapp || null,
          email: payload.email || null,
        }).select('*').single());
        return mapClient(row);
      },
      async update(id, payload) {
        const companyId = await getCompanyId();
        const patch = {};
        if (payload.nome !== undefined) patch.name = payload.nome;
        if (payload.whatsapp !== undefined) patch.whatsapp = payload.whatsapp;
        if (payload.email !== undefined) patch.email = payload.email;
        if (payload.status !== undefined) patch.status = payload.status;
        const row = unwrap(await client.from('clients').update(patch).eq('company_id', companyId).eq('id', id).select('*').single());
        return mapClient(row);
      },
      async remove(id) {
        const companyId = await getCompanyId();
        unwrap(await client.from('clients').delete().eq('company_id', companyId).eq('id', id));
        return true;
      },
      async stats(id) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('charges').select(CHARGE_SELECT).eq('company_id', companyId).eq('client_id', id));
        return aggregateClientStats(data.map(mapCharge));
      },
      async listWithStats() {
        const companyId = await getCompanyId();
        const [clientsRows, chargesRows] = await Promise.all([
          client.from('clients').select('*').eq('company_id', companyId).order('name'),
          client.from('charges').select('id, client_id, amount, status, due_date, paid_at, created_at').eq('company_id', companyId),
        ]);
        const clientList = unwrap(clientsRows).map(mapClient);
        const chargeList = unwrap(chargesRows).map((row) => ({
          clienteId: row.client_id,
          valor: Number(row.amount),
          status: statusFromDb(row),
          criadoEm: row.created_at,
        }));

        return clientList.map((cliente) => {
          const cobs = chargeList.filter((c) => c.clienteId === cliente.id);
          const stats = aggregateClientStats(cobs);
          return { ...cliente, quantidade: stats.quantidade, totalRecebido: stats.totalRecebido, totalPendente: stats.totalPendente, ultimaCobranca: stats.ultimaCobranca };
        });
      },
    };

    // ---------------- cobranças ----------------
    async function logNotification(companyId, chargeId, channel, recipient, message) {
      try {
        await client.from('notification_logs').insert({
          company_id: companyId, charge_id: chargeId, channel, recipient, message, status: 'sent',
        });
      } catch (err) {
        console.warn('Falha ao registrar notification_log (não bloqueia a cobrança):', err);
      }
    }

    const cobrancas = {
      async list() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('charges').select(CHARGE_SELECT).eq('company_id', companyId).order('created_at', { ascending: false }));
        return data.map(mapCharge);
      },
      async get(id) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('charges').select(CHARGE_SELECT).eq('company_id', companyId).eq('id', id).maybeSingle());
        return mapCharge(data);
      },
      async getByPublicToken(token) {
        // Acesso público: usa a função SECURITY DEFINER (sem exigir sessão/RLS de charges).
        const data = unwrap(await client.rpc('get_public_charge_by_token', { p_token: token }));
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return null;
        return {
          id: row.id,
          codigo: row.charge_number,
          descricao: row.description,
          valor: Number(row.amount),
          vencimento: `${row.due_date}T12:00:00`,
          status: row.status === 'paid' ? 'pago' : row.status === 'cancelled' ? 'cancelado' : computeEffectiveStatus('pendente', `${row.due_date}T12:00:00`),
          formaPagamento: paymentMethodsToForma(row.payment_methods),
          parcelas: row.max_installments,
          checkoutUrl: row.checkout_url,
          pagoEm: row.paid_at,
          cliente: { nome: row.client_name },
          empresaNome: row.company_name,
        };
      },
      async create(payload) {
        const companyId = await getCompanyId();
        const userId = await getUserId();
        const row = unwrap(await client.from('charges').insert({
          company_id: companyId,
          client_id: payload.clienteId,
          description: payload.descricao,
          amount: payload.valor,
          due_date: String(payload.vencimento).slice(0, 10),
          payment_methods: formaToPaymentMethods(payload.formaPagamento),
          max_installments: payload.parcelas || 1,
          notes: payload.observacoes || null,
          created_by: userId,
        }).select(CHARGE_SELECT).single());

        const mapped = mapCharge(row);

        if (payload.enviarWhatsapp && mapped.cliente?.whatsapp) {
          await logNotification(companyId, mapped.id, 'whatsapp', mapped.cliente.whatsapp, `Cobrança ${mapped.codigo} enviada por WhatsApp`);
        }
        if (payload.enviarEmail && mapped.cliente?.email) {
          await logNotification(companyId, mapped.id, 'email', mapped.cliente.email, `Cobrança ${mapped.codigo} enviada por e-mail`);
        }

        return mapped;
      },
      async update(id, payload) {
        const companyId = await getCompanyId();
        const patch = {};
        if (payload.clienteId !== undefined) patch.client_id = payload.clienteId;
        if (payload.descricao !== undefined) patch.description = payload.descricao;
        if (payload.valor !== undefined) patch.amount = payload.valor;
        if (payload.vencimento !== undefined) patch.due_date = String(payload.vencimento).slice(0, 10);
        if (payload.formaPagamento !== undefined) patch.payment_methods = formaToPaymentMethods(payload.formaPagamento);
        if (payload.parcelas !== undefined) patch.max_installments = payload.parcelas;
        if (payload.observacoes !== undefined) patch.notes = payload.observacoes;
        const row = unwrap(await client.from('charges').update(patch).eq('company_id', companyId).eq('id', id).select(CHARGE_SELECT).single());
        return mapCharge(row);
      },
      async cancel(id) {
        const companyId = await getCompanyId();
        const row = unwrap(await client.from('charges').update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('company_id', companyId).eq('id', id).select(CHARGE_SELECT).single());
        return mapCharge(row);
      },
      async markPaid(id, { forma = 'pix', parcelas = 1 } = {}) {
        const result = unwrap(await client.rpc('register_manual_payment', {
          p_charge_id: id,
          p_payment_method: forma === 'cartao' ? 'cartao' : 'pix',
          p_installments: parcelas || 1,
        }));
        const row = Array.isArray(result) ? result[0] : result;
        const cobranca = await cobrancas.get(id);
        return { cobranca, pagamento: { id: row?.payment_id }, recibo: { id: row?.receipt_id } };
      },
      // Chama a Edge Function create-infinitepay-checkout (autenticada) para
      // gerar/reaproveitar o checkout_url de uma cobrança já salva no banco.
      async generateCheckout(id) {
        const { data, error } = await client.functions.invoke('create-infinitepay-checkout', {
          body: { charge_id: id },
        });
        if (error) {
          let message = 'Não foi possível gerar o checkout.';
          try {
            const body = await error.context?.json?.();
            if (body?.message) message = body.message;
          } catch (_) { /* mantém mensagem genérica */ }
          return { success: false, message };
        }
        return data;
      },
      // Chama a Edge Function pública check-infinitepay-payment a partir da
      // tela de retorno do checkout (sem exigir sessão).
      async checkInfinitePayPayment(payload) {
        const { data, error } = await client.functions.invoke('check-infinitepay-payment', { body: payload });
        if (error) {
          return { success: false, paid: false };
        }
        return data;
      },
    };

    // ---------------- pagamentos ----------------
    const pagamentos = {
      async list() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('payments').select(PAYMENT_SELECT).eq('company_id', companyId).order('paid_at', { ascending: false }));
        return data.map(mapPayment);
      },
    };

    // ---------------- recibos ----------------
    const recibos = {
      async list() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('receipts').select(RECEIPT_SELECT).eq('company_id', companyId).order('issued_at', { ascending: false }));
        return data.map(mapReceipt);
      },
      async getByPublicToken(token) {
        const data = unwrap(await client.rpc('get_public_receipt_by_token', { p_token: token }));
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return null;
        return {
          numero: row.receipt_number,
          geradoEm: row.issued_at,
          cobranca: { codigo: row.charge_number, descricao: row.description },
          cliente: { nome: row.client_name },
          empresaNome: row.company_name,
          pagamento: {
            forma: row.payment_method,
            parcelas: row.installments,
            valor: Number(row.gross_amount),
            dataHora: row.paid_at,
            codigoTransacao: row.provider_transaction_id,
          },
        };
      },
    };

    // ---------------- dashboard ----------------
    const dashboard = {
      async summary() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('charges').select('amount, status, due_date, paid_at').eq('company_id', companyId));
        const mapped = data.map((row) => ({
          valor: Number(row.amount),
          status: statusFromDb(row),
          vencimento: `${row.due_date}T12:00:00`,
          pagoEm: row.paid_at,
        }));
        return aggregateDashboard(mapped);
      },
      async recent(limit = 8) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('charges').select(CHARGE_SELECT).eq('company_id', companyId).order('created_at', { ascending: false }).limit(limit));
        return data.map(mapCharge);
      },
    };

    // ---------------- empresa ----------------
    const ROLE_LABEL = { owner: 'Proprietário', admin: 'Administrador', employee: 'Funcionário', viewer: 'Visualizador' };

    const empresa = {
      async get() {
        const companyId = await getCompanyId();
        const userId = await getUserId();
        const [companyRow, profileRow, memberRow] = await Promise.all([
          client.from('companies').select('*').eq('id', companyId).single(),
          client.from('profiles').select('*').eq('id', userId).single(),
          client.from('company_members').select('role').eq('company_id', companyId).eq('user_id', userId).maybeSingle(),
        ]);
        const company = unwrap(companyRow);
        const profile = unwrap(profileRow);
        const member = unwrap(memberRow);

        return {
          nome: company.name,
          cnpj: company.document || '',
          email: company.email || '',
          telefone: company.phone || company.whatsapp || '',
          endereco: company.address || '',
          cidade: company.city || '',
          estado: company.state || '',
          cep: company.zip_code || '',
          admin: {
            nome: profile.name,
            email: profile.email,
            cargo: ROLE_LABEL[member?.role] || 'Membro',
          },
        };
      },
      async update(payload) {
        const companyId = await getCompanyId();
        const userId = await getUserId();

        const companyPatch = {};
        if (payload.nome !== undefined) companyPatch.name = payload.nome;
        if (payload.cnpj !== undefined) companyPatch.document = payload.cnpj;
        if (payload.email !== undefined) companyPatch.email = payload.email;
        if (payload.telefone !== undefined) companyPatch.phone = payload.telefone;
        if (Object.keys(companyPatch).length) {
          unwrap(await client.from('companies').update(companyPatch).eq('id', companyId));
        }

        if (payload.admin) {
          const profilePatch = {};
          if (payload.admin.nome !== undefined) profilePatch.name = payload.admin.nome;
          if (payload.admin.email !== undefined) profilePatch.email = payload.admin.email;
          // "cargo" reflete o papel em company_members e não é editável por aqui
          // (evita que um usuário se autopromova a owner/admin sem controle).
          if (Object.keys(profilePatch).length) {
            unwrap(await client.from('profiles').update(profilePatch).eq('id', userId));
          }
        }

        return empresa.get();
      },
    };

    return { clientes, cobrancas, pagamentos, recibos, dashboard, empresa };
  }

  const backend = useDemo ? buildDemoBackend() : buildSupabaseBackend();

  return { ...backend, _readLocalDemoSnapshot: readLocalDemoSnapshot, _isDemo: useDemo };
})();
