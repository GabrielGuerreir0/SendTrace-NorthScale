/**
 * Gera uma planilha Excel (.xlsx) NO NAVEGADOR, sem biblioteca: um .xlsx é um zip de XMLs; aqui o zip é do tipo "armazenado" (sem compressão),
 * que o Excel, o LibreOffice e o Google Planilhas abrem normalmente. Textos vão como inlineStr; números como números; cabeçalho em negrito e largura de colunas.
 *   baixarXlsx('pedidos.xlsx', 'Pedidos', [['Pedido','Valor'], ['A1', 12.5]], { larguras: [18, 12] })
 */
const enc = new TextEncoder();
const TABELA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i += 1) c = TABELA_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const u16 = (n) => [n & 255, (n >>> 8) & 255];
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

export function montarZip(arquivos) {
  const partes = []; const central = []; let deslocamento = 0;
  const agora = new Date(); const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
  const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
  for (const { nome, dados } of arquivos) {
    const n = enc.encode(nome); const crc = crc32(dados);
    const local = Uint8Array.from([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(hora), ...u16(data), ...u32(crc), ...u32(dados.length), ...u32(dados.length), ...u16(n.length), ...u16(0)]);
    partes.push(local, n, dados);
    central.push(Uint8Array.from([0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(hora), ...u16(data), ...u32(crc), ...u32(dados.length), ...u32(dados.length),
      ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(deslocamento)]), n);
    deslocamento += local.length + n.length + dados.length;
  }
  const tamCentral = central.reduce((s, p) => s + p.length, 0);
  const fim = Uint8Array.from([0x50, 0x4B, 5, 6, ...u16(0), ...u16(0), ...u16(arquivos.length), ...u16(arquivos.length), ...u32(tamCentral), ...u32(deslocamento), ...u16(0)]);
  const todos = [...partes, ...central, fim]; const saida = new Uint8Array(todos.reduce((s, p) => s + p.length, 0)); let pos = 0;
  for (const p of todos) { saida.set(p, pos); pos += p.length; }
  return saida;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const coluna = (i) => { let s = ''; let n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

export function gerarXlsx(nomePlanilha, linhas, { larguras = [] } = {}) {
  const celula = (v, i, j, cab) => {
    const ref = `${coluna(j)}${i + 1}`; const estilo = cab ? ' s="1"' : '';
    if (v === null || v === undefined || v === '') return `<c r="${ref}"${estilo}/>`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${estilo}><v>${v}</v></c>`;
    return `<c r="${ref}"${estilo} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  const dados = linhas.map((l, i) => `<row r="${i + 1}">${l.map((v, j) => celula(v, i, j, i === 0)).join('')}</row>`).join('');
  const cols = larguras.length ? `<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const ultima = `${coluna(Math.max(0, (linhas[0]?.length ?? 1) - 1))}${linhas.length || 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${dados}</sheetData><autoFilter ref="A1:${ultima}"/></worksheet>`;
  const arq = (nome, xml) => ({ nome, dados: enc.encode(xml) });
  const nomeSeguro = esc(String(nomePlanilha).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Planilha');
  return montarZip([
    arq('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    arq('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    arq('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nomeSeguro}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    arq('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    arq('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'),
    arq('xl/worksheets/sheet1.xml', sheet),
  ]);
}

export function baixarXlsx(nomeArquivo, nomePlanilha, linhas, opcoes) {
  const blob = new Blob([gerarXlsx(nomePlanilha, linhas, opcoes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nomeArquivo; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
