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

  // Multa/juros de mora — usada só pelo backend demo (o backend real delega
  // esse cálculo inteiramente ao banco, ver sql/late_fees_and_interest.sql).
  // Mesma fórmula exata dos dois lados: multa uma vez só, juros simples
  // proporcionais por dia, nunca sobre parcelamento de cartão da InfinitePay
  // — só sobre a própria due_date da cobrança. Pago/cancelado nunca
  // recalcula: devolve o snapshot já travado, senão pareceria que os juros
  // continuam correndo depois da confirmação do pagamento.
  function calculateLateCharges(cobranca, empresa) {
    if (cobranca.status === 'pago' || cobranca.status === 'cancelado') {
      return {
        diasAtraso: cobranca.diasAtraso || 0,
        multaValor: cobranca.multaValor || 0,
        jurosValor: cobranca.jurosValor || 0,
        valorAtualizado: cobranca.valorAtualizado != null ? cobranca.valorAtualizado : cobranca.valor,
        calculadoEm: cobranca.calculadoEm || new Date().toISOString(),
      };
    }

    const vencimentoMeiaNoite = new Date(new Date(cobranca.vencimento).toDateString());
    const hojeMeiaNoite = new Date(new Date().toDateString());
    const diasAtraso = Math.max(0, Math.round((hojeMeiaNoite - vencimentoMeiaNoite) / 86400000));

    let multaValor = 0;
    let jurosValor = 0;
    if (empresa?.lateFeeEnabled !== false && diasAtraso > 0) {
      const multaPercent = Math.min(Number(empresa?.lateFeePercent ?? 2), 2);
      const jurosPercentMes = Number(empresa?.lateInterestMonthlyPercent ?? 1);
      multaValor = Math.round(cobranca.valor * (multaPercent / 100) * 100) / 100;
      jurosValor = Math.round(cobranca.valor * (jurosPercentMes / 100) * (diasAtraso / 30) * 100) / 100;
    }

    return {
      diasAtraso,
      multaValor,
      jurosValor,
      valorAtualizado: Math.round((cobranca.valor + multaValor + jurosValor) * 100) / 100,
      calculadoEm: new Date().toISOString(),
    };
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
          admin: { nome: 'Administrador Demo', email: 'admin@example.com', telefone: '(11) 99999-9999', cargo: 'Administrador' },
          lateFeeEnabled: true,
          lateFeePercent: 2,
          lateInterestMonthlyPercent: 1,
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

    // Snapshots salvos antes deste recurso existir não têm essas listas —
    // inicializa com os 3 planos padrão na primeira vez que o demo roda
    // depois da atualização, sem apagar nada do que já existia.
    if (!Array.isArray(state.planos)) {
      state.planos = [
        { id: 'plano_mensal', nome: 'Mensal', descricaoCurta: 'Flexível', valor: 190, valorReferencia: null, descontoPercent: 0, duracaoMeses: 1, tipoCobranca: 'recurring_monthly', badge: '', destaque: false, formaPagamento: 'ambos', parcelas: 12, ativo: true, ordem: 1, criadoEm: daysFromToday(-60) },
        { id: 'plano_anual', nome: 'Anual', descricaoCurta: '', valor: 1938, valorReferencia: 2280, descontoPercent: 15, duracaoMeses: 12, tipoCobranca: 'one_time', badge: 'MAIS ESCOLHIDO', destaque: true, formaPagamento: 'ambos', parcelas: 12, ativo: true, ordem: 2, criadoEm: daysFromToday(-60) },
        { id: 'plano_2anos', nome: '2 anos', descricaoCurta: '', valor: 3648, valorReferencia: 4560, descontoPercent: 20, duracaoMeses: 24, tipoCobranca: 'one_time', badge: 'MELHOR ECONOMIA', destaque: false, formaPagamento: 'ambos', parcelas: 12, ativo: true, ordem: 3, criadoEm: daysFromToday(-60) },
      ];
      persist();
    }
    if (!Array.isArray(state.ofertas)) { state.ofertas = []; persist(); }
    if (!Array.isArray(state.assinaturas)) { state.assinaturas = []; persist(); }

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
          // Espelha o "on delete cascade" do banco real: excluir o cliente
          // remove também suas cobranças e, em cascata, os pagamentos/recibos
          // ligados a essas cobranças — nada fica órfão como "Cliente removido".
          const cobrancaIds = new Set(state.cobrancas.filter((c) => c.clienteId === id).map((c) => c.id));
          state.clientes = state.clientes.filter((c) => c.id !== id);
          state.cobrancas = state.cobrancas.filter((c) => c.clienteId !== id);
          state.pagamentos = state.pagamentos.filter((p) => !cobrancaIds.has(p.cobrancaId));
          state.recibos = state.recibos.filter((r) => !cobrancaIds.has(r.cobrancaId));
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
          const encargos = calculateLateCharges(c, state.empresa);
          return {
            ...withComputedStatus(c),
            cliente: state.clientes.find((cl) => cl.id === c.clienteId) || null,
            diasAtraso: encargos.diasAtraso,
            multaValor: encargos.multaValor,
            jurosValor: encargos.jurosValor,
            valorAtualizado: encargos.valorAtualizado,
            calculadoEm: encargos.calculadoEm,
            multaAtiva: state.empresa?.lateFeeEnabled !== false,
            multaPercent: Number(state.empresa?.lateFeePercent ?? 2),
            jurosPercentMes: Number(state.empresa?.lateInterestMonthlyPercent ?? 1),
          };
        });
      },
      // Espelha create-checkout-for-token: em modo demo não existe gateway
      // real, mas o cálculo/trava de multa+juros acontece igual — só o link
      // de checkout em si não é gerado (mesma limitação de generateCheckout).
      gerarCheckoutAtualizado(token) {
        return delay(() => {
          const idx = state.cobrancas.findIndex((x) => x.publicToken === token);
          if (idx === -1) return { success: false, message: 'Cobrança não encontrada.' };
          const c = state.cobrancas[idx];
          if (c.status === 'pago' || c.status === 'cancelado') {
            return { success: false, message: 'Cobrança paga ou cancelada não pode gerar checkout.' };
          }
          const encargos = calculateLateCharges(c, state.empresa);
          state.cobrancas[idx] = {
            ...c,
            multaValor: encargos.multaValor,
            jurosValor: encargos.jurosValor,
            valorAtualizado: encargos.valorAtualizado,
            diasAtraso: encargos.diasAtraso,
            calculadoEm: encargos.calculadoEm,
          };
          persist();
          return { success: false, message: 'Checkout indisponível em modo de demonstração.' };
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
          // Trava (se ainda não tinha sido travado) o valor com multa/juros
          // de hoje antes de registrar o pagamento — mesmo comportamento de
          // register_manual_payment() no banco real: reconciliação manual de
          // uma cobrança vencida registra o valor com encargos, não o original.
          const encargos = calculateLateCharges(cob, state.empresa);
          const valorPago = encargos.valorAtualizado;
          cob.multaValor = encargos.multaValor;
          cob.jurosValor = encargos.jurosValor;
          cob.valorAtualizado = encargos.valorAtualizado;
          cob.diasAtraso = encargos.diasAtraso;
          cob.calculadoEm = encargos.calculadoEm;
          cob.status = 'pago';
          cob.pagoEm = new Date().toISOString();
          persist();

          const pagamento = {
            id: uid('pag'),
            cobrancaId: cob.id,
            clienteId: cob.clienteId,
            valor: valorPago,
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
          empresa: { nome: state.empresa?.nome },
        })));
      },
      obterCompleto(id) {
        return delay(() => {
          const r = state.recibos.find((x) => x.id === id);
          if (!r) return null;
          return {
            ...r,
            cliente: state.clientes.find((c) => c.id === r.clienteId) || null,
            cobranca: state.cobrancas.find((c) => c.id === r.cobrancaId) || null,
            pagamento: state.pagamentos.find((p) => p.id === r.pagamentoId) || null,
            empresa: { nome: state.empresa?.nome },
          };
        });
      },
      getByPublicToken(token) {
        return delay(() => {
          const r = state.recibos.find((x) => x.publicToken === token);
          if (!r) return null;
          const pagamentoInterno = state.pagamentos.find((p) => p.id === r.pagamentoId) || null;
          // Espelha o comportamento do RPC público real (get_public_receipt_by_token):
          // codigoTransacao é interno, nunca exposto ao token público.
          const { codigoTransacao, ...pagamentoPublico } = pagamentoInterno || {};
          return {
            ...r,
            cliente: state.clientes.find((c) => c.id === r.clienteId) || null,
            cobranca: state.cobrancas.find((c) => c.id === r.cobrancaId) || null,
            pagamento: pagamentoInterno ? pagamentoPublico : null,
            empresa: { nome: state.empresa?.nome },
          };
        });
      },
      // Sem serviço de e-mail real disponível em modo de demonstração.
      sendEmail() {
        return delay(() => ({
          success: false,
          code: 'EMAIL_SERVICE_NOT_CONFIGURED',
          message: 'Envio de e-mail indisponível em modo de demonstração.',
        }));
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

    // ---------------- agente de WhatsApp ----------------
    // Envio automático depende de infraestrutura real (Supabase + agente
    // local) — em modo de demonstração não há fila nem agente conectado.
    // As preferências ficam em memória (não persistem) só para a UI não
    // quebrar; nenhuma mensagem é realmente enfileirada.
    let demoWaSettings = {
      sendChargeOnCreate: false,
      sendReceiptOnPayment: false,
      remind3DaysBefore: false,
      remind1DayBefore: false,
      remindOnDueDate: false,
      remindWhenOverdue: false,
    };
    const whatsapp = {
      getAgentState() {
        return delay(() => null);
      },
      getSettings() {
        return delay(() => ({ companyId: null, ...demoWaSettings }));
      },
      updateSettings(payload) {
        return delay(() => {
          demoWaSettings = { ...demoWaSettings, ...payload };
          return { companyId: null, ...demoWaSettings };
        });
      },
      enqueue() {
        return delay(() => ({ success: false, message: 'Envio automático de WhatsApp disponível apenas com o Supabase configurado.' }));
      },
      history() {
        return delay(() => []);
      },
    };

    // ---------------- planos, ofertas e assinaturas ----------------
    function planoAtivosCount(planoId) {
      return state.assinaturas.filter((a) => a.planoId === planoId && a.status === 'active').length;
    }

    const planos = {
      list() {
        return delay(() => [...state.planos].sort((a, b) => a.ordem - b.ordem).map((p) => ({ ...p })));
      },
      listWithStats() {
        return delay(() => [...state.planos].sort((a, b) => a.ordem - b.ordem).map((p) => ({ ...p, clientesAtivos: planoAtivosCount(p.id) })));
      },
      get(id) {
        return delay(() => {
          const p = state.planos.find((x) => x.id === id);
          return p ? { ...p } : null;
        });
      },
      create(payload) {
        return delay(() => {
          const novo = { id: uid('plano'), ativo: true, ordem: state.planos.length + 1, criadoEm: new Date().toISOString(), ...payload };
          state.planos.push(novo);
          persist();
          return { ...novo };
        });
      },
      update(id, payload) {
        return delay(() => {
          const idx = state.planos.findIndex((p) => p.id === id);
          if (idx === -1) throw new Error('Plano não encontrado');
          state.planos[idx] = { ...state.planos[idx], ...payload };
          persist();
          return { ...state.planos[idx] };
        });
      },
      duplicate(id) {
        return delay(() => {
          const original = state.planos.find((p) => p.id === id);
          if (!original) throw new Error('Plano não encontrado');
          const copia = { ...original, id: uid('plano'), nome: `${original.nome} (cópia)`, ativo: false, ordem: state.planos.length + 1, criadoEm: new Date().toISOString() };
          state.planos.push(copia);
          persist();
          return { ...copia };
        });
      },
      remove(id) {
        return delay(() => {
          if (planoAtivosCount(id) > 0) {
            return { success: false, message: 'Este plano tem assinaturas ativas e não pode ser excluído. Desative-o em vez de excluir.' };
          }
          state.planos = state.planos.filter((p) => p.id !== id);
          persist();
          return { success: true };
        });
      },
    };

    const ofertas = {
      create({ clienteId, planIds, titulo, mensagem, expiraEmDias = 7 }) {
        return delay(() => {
          const cliente = state.clientes.find((c) => c.id === clienteId);
          if (!cliente) throw new Error('Cliente não encontrado');
          const expira = new Date();
          expira.setDate(expira.getDate() + Math.max(1, expiraEmDias || 7));
          const nova = {
            id: uid('oferta'), clienteId, planIds, titulo: titulo || null, mensagem: mensagem || null,
            publicToken: uid('tok'), status: 'active', expiraEm: expira.toISOString(),
            planoSelecionadoId: null, cobrancaId: null, selecionadoEm: null, criadoEm: new Date().toISOString(),
          };
          state.ofertas.push(nova);
          persist();
          return { ...nova };
        });
      },
      getByPublicToken(token) {
        return delay(() => {
          const o = state.ofertas.find((x) => x.publicToken === token);
          if (!o) return null;
          const cliente = state.clientes.find((c) => c.id === o.clienteId);
          const empresa = state.empresa;
          const isExpired = o.status === 'active' && new Date(o.expiraEm) < new Date();
          const planoSel = o.planoSelecionadoId ? state.planos.find((p) => p.id === o.planoSelecionadoId) : null;
          const cobranca = o.cobrancaId ? state.cobrancas.find((c) => c.id === o.cobrancaId) : null;
          return {
            id: o.id, titulo: o.titulo, mensagem: o.mensagem, status: o.status, isExpired,
            expiraEm: o.expiraEm, clienteNome: cliente?.nome || 'Cliente', empresaNome: empresa?.nome || 'Smart Billing',
            planoSelecionadoNome: planoSel?.nome || null,
            cobrancaStatus: cobranca ? cobranca.status : null,
            cobrancaPublicToken: cobranca ? cobranca.publicToken : null,
            planos: state.planos.filter((p) => o.planIds.includes(p.id) && p.ativo).sort((a, b) => a.ordem - b.ordem),
          };
        });
      },
      // Em modo demo a "cobrança" é criada localmente (sem InfinitePay real) —
      // suficiente para exercitar a navegação/UX da página pública offline.
      selectPlan({ offerToken, planId }) {
        return delay(() => {
          const o = state.ofertas.find((x) => x.publicToken === offerToken);
          if (!o) return { success: false, result: 'not_found' };
          if (o.status === 'selected') return { success: true, result: 'already_selected', charge_public_token: state.cobrancas.find((c) => c.id === o.cobrancaId)?.publicToken };
          if (new Date(o.expiraEm) < new Date()) return { success: false, result: 'expired' };
          if (!o.planIds.includes(planId)) return { success: false, result: 'invalid_plan' };
          const plano = state.planos.find((p) => p.id === planId && p.ativo);
          if (!plano) return { success: false, result: 'invalid_plan' };

          const novaCobranca = {
            id: uid('cob'), clienteId: o.clienteId, descricao: `Plano ${plano.nome}`, valor: plano.valor,
            vencimento: new Date().toISOString(), status: 'pendente', formaPagamento: plano.formaPagamento,
            parcelas: plano.parcelas, publicToken: uid('tok'), checkoutUrl: null, criadoEm: new Date().toISOString(), pagoEm: null,
            planoId: plano.id, ofertaId: o.id,
          };
          state.cobrancas.unshift(novaCobranca);

          const novaAssinatura = {
            id: uid('assin'), clienteId: o.clienteId, planoId: plano.id, cobrancaInicialId: novaCobranca.id,
            status: 'pending', startsAt: null, endsAt: null, nextBillingAt: null, criadoEm: new Date().toISOString(),
          };
          state.assinaturas.push(novaAssinatura);

          o.status = 'selected';
          o.planoSelecionadoId = plano.id;
          o.cobrancaId = novaCobranca.id;
          o.selecionadoEm = new Date().toISOString();
          persist();
          return { success: true, result: 'created', charge_public_token: novaCobranca.publicToken };
        });
      },
      listForClient(clienteId) {
        return delay(() => state.ofertas.filter((o) => o.clienteId === clienteId).map((o) => ({ ...o })));
      },
    };

    const assinaturas = {
      getCurrentForClient(clienteId) {
        return delay(() => {
          const lista = state.assinaturas.filter((a) => a.clienteId === clienteId).sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
          const atual = lista.find((a) => a.status === 'active' || a.status === 'pending' || a.status === 'overdue') || lista[0] || null;
          if (!atual) return null;
          const plano = state.planos.find((p) => p.id === atual.planoId);
          return { ...atual, planoNome: plano?.nome || '', planoValor: plano?.valor || 0, planoTipo: plano?.tipoCobranca || '' };
        });
      },
      listForClient(clienteId) {
        return delay(() => state.assinaturas
          .filter((a) => a.clienteId === clienteId)
          .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm))
          .map((a) => {
            const plano = state.planos.find((p) => p.id === a.planoId);
            return { ...a, planoNome: plano?.nome || '' };
          }));
      },
      cancel(id) {
        return delay(() => {
          const idx = state.assinaturas.findIndex((a) => a.id === id);
          if (idx === -1) throw new Error('Assinatura não encontrada');
          state.assinaturas[idx] = { ...state.assinaturas[idx], status: 'cancelled', cancelledAt: new Date().toISOString(), nextBillingAt: null };
          persist();
          return { ...state.assinaturas[idx] };
        });
      },
    };

    return { clientes, cobrancas, pagamentos, recibos, dashboard, empresa, whatsapp, planos, ofertas, assinaturas };
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
      // Pagamento InfinitePay confirmado mas com valor/estado divergente do
      // esperado (ex.: cliente pagou por um checkout antigo, de antes do
      // vencimento) — nunca perdido, registrado em payment_reviews (embedado
      // via CHARGE_SELECT). Precisa de status próprio pro painel: nunca deve
      // parecer "em dia"/"atrasada" como se nada tivesse acontecido.
      const hasPendingReview = Array.isArray(row.payment_reviews)
        && row.payment_reviews.some((r) => r.status === 'pending_review');
      if (hasPendingReview) return 'revisao';
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
        pagamento: row.payment ? {
          valor: Number(row.payment.gross_amount),
          forma: row.payment.payment_method,
          parcelas: row.payment.installments,
          dataHora: row.payment.paid_at,
          codigoTransacao: row.payment.provider_transaction_id,
        } : null,
        empresa: row.company ? { nome: row.company.name } : null,
      };
    }

    // payment_reviews(status) é embedado só pra detectar cobrança com pagamento
    // divergente pendente de revisão (ver statusFromDb) — nunca expõe valores
    // monetários nem transaction_nsu pra esta listagem geral.
    const CHARGE_SELECT = '*, client:clients(id, name, whatsapp, email, document, notes, status, created_at, updated_at), payment_reviews(status)';
    const PAYMENT_SELECT = '*, charge:charges(charge_number, client:clients(id, name, whatsapp, email))';
    const RECEIPT_SELECT = '*, company:companies(name), charge:charges(charge_number, description, client:clients(id, name, whatsapp, email)), payment:payments(gross_amount, payment_method, installments, paid_at, provider_transaction_id)';

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
          // has_pending_review (não charges.status) sinaliza a revisão: um
          // pagamento InfinitePay confirmado que não bateu com o valor/estado
          // esperado (ex.: checkout antigo pago após o vencimento) fica em
          // payment_reviews sem mexer no status da cobrança.
          status: row.status === 'paid' ? 'pago' : row.status === 'cancelled' ? 'cancelado' : row.has_pending_review ? 'revisao' : computeEffectiveStatus('pendente', `${row.due_date}T12:00:00`),
          checkoutUrl: row.checkout_url,
          pagoEm: row.paid_at,
          cliente: { nome: row.client_name },
          empresaNome: row.company_name,
          // Multa/juros — sempre calculados no banco (get_public_charge_by_token
          // -> calculate_late_charges), nunca no navegador.
          diasAtraso: row.days_overdue || 0,
          multaValor: Number(row.late_fee_amount || 0),
          jurosValor: Number(row.late_interest_amount || 0),
          valorAtualizado: row.updated_amount != null ? Number(row.updated_amount) : Number(row.amount),
          calculadoEm: row.late_fee_calculated_at,
          multaAtiva: Boolean(row.late_fee_enabled),
          multaPercent: Number(row.late_fee_percent || 0),
          jurosPercentMes: Number(row.late_interest_monthly_percent || 0),
        };
      },
      // Chama a Edge Function pública create-checkout-for-token — usada só
      // quando a cobrança está vencida e o checkout já carregado pode estar
      // com o valor antigo (sem multa/juros). Nunca envia o valor: o servidor
      // recalcula e trava multa/juros antes de gerar o link novo.
      async gerarCheckoutAtualizado(token) {
        const { data, error } = await client.functions.invoke('create-checkout-for-token', {
          body: { token },
        });
        if (error) {
          let message = 'Não foi possível gerar o checkout atualizado.';
          try {
            const body = await error.context?.json?.();
            if (body?.message) message = body.message;
          } catch (_) { /* mantém mensagem genérica */ }
          return { success: false, message };
        }
        return data;
      },
      async create(payload) {
        const companyId = await getCompanyId();
        const userId = await getUserId();
        const insertRow = {
          company_id: companyId,
          client_id: payload.clienteId,
          description: payload.descricao,
          amount: payload.valor,
          due_date: String(payload.vencimento).slice(0, 10),
          notes: payload.observacoes || null,
          created_by: userId,
        };
        // Só grava payment_methods/max_installments quando o chamador envia
        // explicitamente (hoje só a importação de dados legados em
        // Configurações) — o formulário de cobrança não configura mais isso;
        // sem esses campos, a tabela usa os defaults (pix+cartão, 1x), que
        // não controlam nada real (a InfinitePay decide isso no checkout).
        if (payload.formaPagamento !== undefined) insertRow.payment_methods = formaToPaymentMethods(payload.formaPagamento);
        if (payload.parcelas !== undefined) insertRow.max_installments = payload.parcelas;
        const row = unwrap(await client.from('charges').insert(insertRow).select(CHARGE_SELECT).single());

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
      async obterCompleto(id) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('receipts').select(RECEIPT_SELECT).eq('company_id', companyId).eq('id', id).maybeSingle());
        return mapReceipt(data);
      },
      // Chama a Edge Function send-receipt-email (autenticada). Todo o
      // conteúdo do e-mail é montado no servidor a partir do receipt_id —
      // o frontend nunca envia valor/cliente/descrição/destinatário.
      async sendEmail(id) {
        const { data, error } = await client.functions.invoke('send-receipt-email', {
          body: { receipt_id: id },
        });
        if (error) {
          let message = 'Não foi possível enviar o e-mail.';
          let code = null;
          try {
            const body = await error.context?.json?.();
            if (body?.message) message = body.message;
            if (body?.code) code = body.code;
          } catch (_) { /* mantém mensagem genérica */ }
          return { success: false, message, code };
        }
        return { success: true, message: data?.message || 'Recibo enviado por e-mail' };
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
          // Sem codigoTransacao: get_public_receipt_by_token (RPC pública) não
          // retorna provider_transaction_id — esse dado é só para o painel
          // autenticado (ver recibos.obterCompleto / recibos.list acima).
          pagamento: {
            forma: row.payment_method,
            parcelas: row.installments,
            valor: Number(row.gross_amount),
            dataHora: row.paid_at,
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
          lateFeeEnabled: company.late_fee_enabled !== false,
          lateFeePercent: Number(company.late_fee_percent ?? 2),
          lateInterestMonthlyPercent: Number(company.late_interest_monthly_percent ?? 1),
          admin: {
            nome: profile.name,
            email: profile.email,
            telefone: profile.phone || '',
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
        if (payload.lateFeeEnabled !== undefined) companyPatch.late_fee_enabled = payload.lateFeeEnabled;
        // Teto de 2% é reforçado no banco (CHECK constraint) — aqui só evita
        // uma viagem ao servidor pra descobrir que vai ser rejeitado.
        if (payload.lateFeePercent !== undefined) companyPatch.late_fee_percent = Math.min(Number(payload.lateFeePercent) || 0, 2);
        if (payload.lateInterestMonthlyPercent !== undefined) companyPatch.late_interest_monthly_percent = Math.max(Number(payload.lateInterestMonthlyPercent) || 0, 0);
        if (Object.keys(companyPatch).length) {
          unwrap(await client.from('companies').update(companyPatch).eq('id', companyId));
        }

        if (payload.admin) {
          const profilePatch = {};
          if (payload.admin.nome !== undefined) profilePatch.name = payload.admin.nome;
          if (payload.admin.email !== undefined) profilePatch.email = payload.admin.email;
          if (payload.admin.telefone !== undefined) profilePatch.phone = payload.admin.telefone;
          // "cargo" reflete o papel em company_members e não é editável por aqui
          // (evita que um usuário se autopromova a owner/admin sem controle).
          if (Object.keys(profilePatch).length) {
            unwrap(await client.from('profiles').update(profilePatch).eq('id', userId));
          }
        }

        return empresa.get();
      },
    };

    // ---------------- agente de WhatsApp ----------------
    function mapAgentState(row) {
      if (!row) return null;
      return {
        status: row.status,
        phoneNumber: row.phone_number,
        displayName: row.display_name,
        qrCode: row.qr_code,
        lastSeenAt: row.last_seen_at,
        connectedAt: row.connected_at,
        disconnectedAt: row.disconnected_at,
        errorMessage: row.error_message,
      };
    }

    function mapWaSettings(row, companyId) {
      return {
        companyId,
        sendChargeOnCreate: Boolean(row?.send_charge_on_create),
        sendReceiptOnPayment: Boolean(row?.send_receipt_on_payment),
        remind3DaysBefore: Boolean(row?.remind_3_days_before),
        remind1DayBefore: Boolean(row?.remind_1_day_before),
        remindOnDueDate: Boolean(row?.remind_on_due_date),
        remindWhenOverdue: Boolean(row?.remind_when_overdue),
      };
    }

    function mapWaOutbox(row) {
      if (!row) return null;
      return {
        id: row.id,
        recipient: row.recipient,
        message: row.message,
        messageType: row.message_type,
        status: row.status,
        attempts: row.attempts,
        whatsappMessageId: row.whatsapp_message_id,
        errorMessage: row.error_message,
        scheduledAt: row.scheduled_at,
        sentAt: row.sent_at,
        failedAt: row.failed_at,
        createdAt: row.created_at,
      };
    }

    const whatsapp = {
      async getAgentState() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('whatsapp_agent_state').select('*').eq('company_id', companyId).maybeSingle());
        return mapAgentState(data);
      },
      async getSettings() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('whatsapp_settings').select('*').eq('company_id', companyId).maybeSingle());
        return mapWaSettings(data, companyId);
      },
      async updateSettings(payload) {
        const companyId = await getCompanyId();
        const patch = { company_id: companyId };
        if (payload.sendChargeOnCreate !== undefined) patch.send_charge_on_create = payload.sendChargeOnCreate;
        if (payload.sendReceiptOnPayment !== undefined) patch.send_receipt_on_payment = payload.sendReceiptOnPayment;
        if (payload.remind3DaysBefore !== undefined) patch.remind_3_days_before = payload.remind3DaysBefore;
        if (payload.remind1DayBefore !== undefined) patch.remind_1_day_before = payload.remind1DayBefore;
        if (payload.remindOnDueDate !== undefined) patch.remind_on_due_date = payload.remindOnDueDate;
        if (payload.remindWhenOverdue !== undefined) patch.remind_when_overdue = payload.remindWhenOverdue;
        const row = unwrap(await client.from('whatsapp_settings').upsert(patch, { onConflict: 'company_id' }).select('*').single());
        return mapWaSettings(row, companyId);
      },
      // Único caminho para enfileirar mensagens — chama a função do banco
      // enqueue_whatsapp_message(), que resolve o destinatário real a partir
      // do charge_id/receipt_id/client_id (nunca aceita recipient do navegador).
      async enqueue({ messageType, message, chargeId = null, receiptId = null, clientId = null, idempotencyKey = null }) {
        const companyId = await getCompanyId();
        const { data, error } = await client.rpc('enqueue_whatsapp_message', {
          p_company_id: companyId,
          p_message_type: messageType,
          p_message: message,
          p_charge_id: chargeId,
          p_receipt_id: receiptId,
          p_client_id: clientId,
          p_idempotency_key: idempotencyKey,
        });
        if (error) {
          return { success: false, message: error.message || 'Não foi possível enfileirar a mensagem.' };
        }
        return { success: true, job: mapWaOutbox(data) };
      },
      async history({ chargeId, receiptId, limit = 10 } = {}) {
        const companyId = await getCompanyId();
        let query = client.from('whatsapp_outbox').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(limit);
        if (chargeId) query = query.eq('charge_id', chargeId);
        if (receiptId) query = query.eq('receipt_id', receiptId);
        const data = unwrap(await query);
        return data.map(mapWaOutbox);
      },
    };

    // ---------------- planos ----------------
    function mapPlano(row) {
      if (!row) return null;
      return {
        id: row.id,
        nome: row.name,
        descricao: row.description || '',
        descricaoCurta: row.short_description || '',
        valor: Number(row.amount),
        valorReferencia: row.reference_amount != null ? Number(row.reference_amount) : null,
        descontoPercent: Number(row.discount_percent || 0),
        duracaoMeses: row.duration_months != null ? Number(row.duration_months) : null,
        tipoCobranca: row.billing_type,
        badge: row.badge || '',
        destaque: !!row.featured,
        ativo: !!row.active,
        ordem: row.sort_order,
        observacoes: row.notes || '',
        criadoEm: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    // payment_methods/max_installments continuam existindo na tabela (default
    // pix+cartão / 1x) mas não controlam nada real — a InfinitePay decide
    // forma de pagamento e parcelamento no próprio checkout (ver
    // docs/PLANOS_E_ASSINATURAS.md). Por isso o frontend de Planos não lê
    // nem grava mais esses dois campos.
    const PLANO_SELECT = 'id, company_id, name, description, short_description, amount, reference_amount, discount_percent, duration_months, billing_type, badge, featured, active, sort_order, notes, created_at, updated_at';

    function planoToRow(payload) {
      const row = {};
      if (payload.nome !== undefined) row.name = payload.nome;
      if (payload.descricao !== undefined) row.description = payload.descricao || null;
      if (payload.descricaoCurta !== undefined) row.short_description = payload.descricaoCurta || null;
      if (payload.valor !== undefined) row.amount = payload.valor;
      if (payload.valorReferencia !== undefined) row.reference_amount = payload.valorReferencia || null;
      if (payload.descontoPercent !== undefined) row.discount_percent = payload.descontoPercent || 0;
      if (payload.duracaoMeses !== undefined) row.duration_months = payload.duracaoMeses;
      if (payload.tipoCobranca !== undefined) row.billing_type = payload.tipoCobranca;
      if (payload.badge !== undefined) row.badge = payload.badge || null;
      if (payload.destaque !== undefined) row.featured = payload.destaque;
      if (payload.ativo !== undefined) row.active = payload.ativo;
      if (payload.ordem !== undefined) row.sort_order = payload.ordem;
      if (payload.observacoes !== undefined) row.notes = payload.observacoes || null;
      return row;
    }

    const planos = {
      async list() {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('billing_plans').select(PLANO_SELECT).eq('company_id', companyId).order('sort_order'));
        return data.map(mapPlano);
      },
      // Também traz o nº de assinaturas ativas de cada plano (para a
      // listagem do painel: "12 clientes"). Uma query extra e pequena
      // (agrupada em memória) é mais simples e segura que uma view nova.
      async listWithStats() {
        const companyId = await getCompanyId();
        const [plansData, subsData] = await Promise.all([
          client.from('billing_plans').select(PLANO_SELECT).eq('company_id', companyId).order('sort_order'),
          client.from('client_subscriptions').select('plan_id').eq('company_id', companyId).eq('status', 'active'),
        ]);
        const plans = unwrap(plansData).map(mapPlano);
        const subs = unwrap(subsData);
        const counts = {};
        subs.forEach((s) => { counts[s.plan_id] = (counts[s.plan_id] || 0) + 1; });
        return plans.map((p) => ({ ...p, clientesAtivos: counts[p.id] || 0 }));
      },
      async get(id) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('billing_plans').select(PLANO_SELECT).eq('company_id', companyId).eq('id', id).maybeSingle());
        return mapPlano(data);
      },
      async create(payload) {
        const companyId = await getCompanyId();
        const row = { company_id: companyId, ...planoToRow(payload) };
        const data = unwrap(await client.from('billing_plans').insert(row).select(PLANO_SELECT).single());
        return mapPlano(data);
      },
      async update(id, payload) {
        const companyId = await getCompanyId();
        const row = planoToRow(payload);
        const data = unwrap(await client.from('billing_plans').update(row).eq('company_id', companyId).eq('id', id).select(PLANO_SELECT).single());
        return mapPlano(data);
      },
      async duplicate(id) {
        const original = await planos.get(id);
        if (!original) throw new Error('Plano não encontrado');
        return planos.create({ ...original, nome: `${original.nome} (cópia)`, ativo: false });
      },
      async remove(id) {
        const companyId = await getCompanyId();
        const { error } = await client.from('billing_plans').delete().eq('company_id', companyId).eq('id', id);
        if (error) {
          // Violação de FK (on delete restrict) — plano em uso por alguma assinatura.
          if (error.code === '23503') {
            return { success: false, message: 'Este plano tem assinaturas associadas e não pode ser excluído. Desative-o em vez de excluir.' };
          }
          return { success: false, message: error.message || 'Não foi possível excluir o plano.' };
        }
        return { success: true };
      },
    };

    // ---------------- ofertas de planos ----------------
    function mapOfertaPublica(row) {
      if (!row) return null;
      return {
        titulo: row.title,
        mensagem: row.message,
        status: row.status,
        isExpired: row.is_expired,
        expiraEm: row.expires_at,
        clienteNome: row.client_name,
        empresaNome: row.company_name,
        planoSelecionadoNome: row.selected_plan_name,
        cobrancaStatus: row.charge_status,
        cobrancaPublicToken: row.charge_public_token,
        planos: (row.plans || []).map((p) => ({
          id: p.id, nome: p.name, descricao: p.description, descricaoCurta: p.short_description,
          valor: Number(p.amount), valorReferencia: p.reference_amount != null ? Number(p.reference_amount) : null,
          descontoPercent: Number(p.discount_percent || 0),
          // Number(...) por segurança: classificarPlanos() em oferta.js compara
          // com === 6/12, então mesmo vindo como string algum dia (mudança na
          // API, serialização diferente etc.) o plano não deve silenciosamente
          // cair em "secundário" por divergência de tipo.
          duracaoMeses: p.duration_months != null ? Number(p.duration_months) : null,
          tipoCobranca: p.billing_type,
          badge: p.badge || '', destaque: !!p.featured,
        })),
      };
    }

    const ofertas = {
      async create({ clienteId, planIds, titulo, mensagem, expiraEmDias = 7 }) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.rpc('create_plan_offer', {
          p_company_id: companyId,
          p_client_id: clienteId,
          p_plan_ids: planIds,
          p_title: titulo || null,
          p_message: mensagem || null,
          p_expires_in_days: expiraEmDias,
        }));
        const row = Array.isArray(data) ? data[0] : data;
        return { id: row.id, publicToken: row.public_token, status: row.status, expiraEm: row.expires_at };
      },
      // Acesso público: usa a função SECURITY DEFINER (sem exigir sessão/RLS).
      async getByPublicToken(token) {
        const data = unwrap(await client.rpc('get_public_plan_offer_by_token', { p_token: token }));
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return null;
        return mapOfertaPublica(row);
      },
      // Chama a Edge Function pública select-plan-offer — nunca envia
      // preço/desconto/duração, só o token da oferta e o id do plano
      // escolhido. Todo o resto é resolvido no banco (ver sql/billing_plans.sql).
      async selectPlan({ offerToken, planId }) {
        const { data, error } = await client.functions.invoke('select-plan-offer', {
          body: { offer_token: offerToken, plan_id: planId },
        });
        if (error) {
          let message = 'Não foi possível processar sua escolha. Tente novamente.';
          try {
            const body = await error.context?.json?.();
            if (body?.message) message = body.message;
          } catch (_) { /* mantém mensagem genérica */ }
          return { success: false, message };
        }
        return data;
      },
      async listForClient(clienteId) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('plan_offers').select('id, public_token, title, status, expires_at, selected_plan_id, charge_id, selected_at, created_at').eq('company_id', companyId).eq('client_id', clienteId).order('created_at', { ascending: false }));
        return data.map((row) => ({
          id: row.id, publicToken: row.public_token, titulo: row.title, status: row.status,
          expiraEm: row.expires_at, planoSelecionadoId: row.selected_plan_id, cobrancaId: row.charge_id,
          selecionadoEm: row.selected_at, criadoEm: row.created_at,
        }));
      },
    };

    // ---------------- assinaturas ----------------
    function mapAssinatura(row) {
      if (!row) return null;
      return {
        id: row.id,
        clienteId: row.client_id,
        planoId: row.plan_id,
        planoNome: row.billing_plans?.name || '',
        planoTipo: row.billing_plans?.billing_type || '',
        planoValor: row.billing_plans ? Number(row.billing_plans.amount) : 0,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        nextBillingAt: row.next_billing_at,
        cancelledAt: row.cancelled_at,
        criadoEm: row.created_at,
      };
    }

    const ASSINATURA_SELECT = 'id, client_id, plan_id, status, starts_at, ends_at, next_billing_at, cancelled_at, created_at, billing_plans(name, billing_type, amount)';

    const assinaturas = {
      async getCurrentForClient(clienteId) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('client_subscriptions').select(ASSINATURA_SELECT)
          .eq('company_id', companyId).eq('client_id', clienteId)
          .in('status', ['active', 'pending', 'overdue'])
          .order('created_at', { ascending: false }).limit(1).maybeSingle());
        if (data) return mapAssinatura(data);
        // Sem assinatura em andamento: devolve a mais recente (cancelada/expirada), se houver.
        const fallback = unwrap(await client.from('client_subscriptions').select(ASSINATURA_SELECT)
          .eq('company_id', companyId).eq('client_id', clienteId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle());
        return mapAssinatura(fallback);
      },
      async listForClient(clienteId) {
        const companyId = await getCompanyId();
        const data = unwrap(await client.from('client_subscriptions').select(ASSINATURA_SELECT)
          .eq('company_id', companyId).eq('client_id', clienteId)
          .order('created_at', { ascending: false }));
        return data.map(mapAssinatura);
      },
      async cancel(id) {
        const data = unwrap(await client.rpc('cancel_client_subscription', { p_subscription_id: id }));
        const row = Array.isArray(data) ? data[0] : data;
        return mapAssinatura(row);
      },
    };

    return { clientes, cobrancas, pagamentos, recibos, dashboard, empresa, whatsapp, planos, ofertas, assinaturas };
  }

  const backend = useDemo ? buildDemoBackend() : buildSupabaseBackend();

  return { ...backend, _readLocalDemoSnapshot: readLocalDemoSnapshot, _isDemo: useDemo };
})();
