/* ==========================================================================
   Smart Billing — Geração real de PDF de recibo (jsPDF)
   --------------------------------------------------------------------------
   Depende da build UMD do jsPDF carregada via CDN (ver <head>/scripts de
   recibos.html e recibo-publico.html), que expõe window.jspdf.jsPDF. Este
   arquivo precisa ser carregado DEPOIS do jsPDF e ANTES de recibos.js /
   recibo-publico.js.

   Aceita tanto o formato retornado por DB.recibos.list()/obterCompleto()
   (cliente/cobranca/pagamento/empresa aninhados) quanto o formato público
   de DB.recibos.getByPublicToken() (empresaNome solto). Nunca recebe nem
   exibe UUIDs, company_id, client_id, payment_id ou raw_payload — apenas os
   campos textuais já mapeados pela camada DB.
   ========================================================================== */

window.ReceiptPDF = (() => {
  function ensureJsPDF() {
    if (!window.jspdf || typeof window.jspdf.jsPDF !== 'function') {
      throw new Error('Biblioteca de PDF não carregada');
    }
    return window.jspdf.jsPDF;
  }

  function normalize(recibo) {
    const pagamento = recibo?.pagamento || {};
    return {
      numero: recibo?.numero || 'RECIBO',
      empresaNome: recibo?.empresa?.nome || recibo?.empresaNome || 'Smart Billing',
      clienteNome: recibo?.cliente?.nome || 'Cliente',
      cobrancaCodigo: recibo?.cobranca?.codigo || '—',
      descricao: recibo?.cobranca?.descricao || '',
      valor: Number(pagamento.valor || 0),
      forma: pagamento.forma,
      parcelas: pagamento.parcelas || 1,
      dataHora: pagamento.dataHora || recibo?.geradoEm,
      codigoTransacao: pagamento.codigoTransacao,
    };
  }

  function generate(recibo) {
    const JsPDF = ensureJsPDF();
    const data = normalize(recibo);
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 48;
    const bottomLimit = pageHeight - 90;
    let y = 60;

    function addPageIfNeeded(nextHeight) {
      if (y + nextHeight > bottomLimit) {
        doc.addPage();
        y = 60;
      }
    }

    // ---------- Cabeçalho ----------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(20, 20, 20);
    doc.text(data.empresaNome, marginX, y);
    y += 26;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(13);
    doc.setTextColor(90, 90, 90);
    doc.text('Recibo de pagamento', marginX, y);
    y += 14;

    doc.setDrawColor(220, 220, 220);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 30;

    // ---------- Campos ----------
    const labelWidth = 150;
    const valueMaxWidth = pageWidth - marginX * 2 - labelWidth;

    function row(label, value) {
      const lines = doc.splitTextToSize(String(value ?? '—'), valueMaxWidth);
      addPageIfNeeded(lines.length * 14 + 6);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(90, 90, 90);
      doc.text(label, marginX, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30, 30, 30);
      doc.text(lines, marginX + labelWidth, y);
      y += Math.max(18, lines.length * 14);
    }

    row('Número do recibo', data.numero);
    row('Empresa', data.empresaNome);
    row('Cliente', data.clienteNome);
    row('Número da cobrança', data.cobrancaCodigo);
    row('Descrição', data.descricao);
    row('Forma de pagamento', SB_UI.paymentMethodLabel(data.forma, data.parcelas));
    row('Data e horário', SB_UI.formatDateTime(data.dataHora));
    if (data.codigoTransacao) row('Código da transação', data.codigoTransacao);

    // ---------- Valor em destaque ----------
    y += 10;
    addPageIfNeeded(72);
    doc.setFillColor(244, 247, 250);
    doc.roundedRect(marginX, y, pageWidth - marginX * 2, 62, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(90, 90, 90);
    doc.text('Valor pago', marginX + 20, y + 24);
    doc.setFontSize(20);
    doc.setTextColor(15, 118, 80);
    doc.text(SB_UI.formatCurrency(data.valor), marginX + 20, y + 47);
    y += 62 + 26;

    // ---------- Texto de confirmação ----------
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(60, 60, 60);
    const confirmLines = doc.splitTextToSize(
      `Confirmamos o recebimento do pagamento acima referente à cobrança ${data.cobrancaCodigo}, ` +
      `emitido em nome de ${data.clienteNome}.`,
      pageWidth - marginX * 2,
    );
    addPageIfNeeded(confirmLines.length * 14 + 10);
    doc.text(confirmLines, marginX, y);

    // ---------- Rodapé (todas as páginas) ----------
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(150, 150, 150);
      doc.text('Gerado pelo Smart Billing', marginX, pageHeight - 40);
    }

    return doc;
  }

  async function download(recibo) {
    const doc = generate(recibo);
    const numero = recibo?.numero || 'recibo';
    doc.save(`${numero}.pdf`);
  }

  return { generate, download };
})();
