const express = require("express");
const multer = require("multer");
const cors = require("cors");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["POST", "GET", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

app.get("/", (req, res) => { res.send(getHTML()); });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|docx|doc|xlsx|xls|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("Formato não suportado."), false);
  },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  try {
    if (ext === ".pdf") { const d = await pdfParse(fs.readFileSync(filePath)); return d.text; }
    if (ext === ".docx" || ext === ".doc") { const r = await mammoth.extractRawText({ path: filePath }); return r.value; }
    if (ext === ".xlsx" || ext === ".xls") {
      const wb = xlsx.readFile(filePath); let t = "";
      wb.SheetNames.forEach(s => { t += "\n" + xlsx.utils.sheet_to_csv(wb.Sheets[s]); });
      return t;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) { throw new Error("Falha ao extrair texto: " + err.message); }
}

app.post("/compare", upload.fields([{ name: "cliente", maxCount: 1 }, { name: "producao", maxCount: 1 }]), async (req, res) => {
  const toDelete = [];
  try {
    if (!req.files?.cliente || !req.files?.producao)
      return res.status(400).json({ error: "Envie os dois arquivos." });

    const fc = req.files.cliente[0];
    const fp = req.files.producao[0];
    toDelete.push(fc.path, fp.path);

    const [tc, tp] = await Promise.all([
      extractText(fc.path, fc.originalname),
      extractText(fp.path, fp.originalname),
    ]);

    if (!tc.trim()) return res.status(400).json({ error: "Não foi possível extrair texto do pedido do cliente." });
    if (!tp.trim()) return res.status(400).json({ error: "Não foi possível extrair texto do pedido de produção." });

    const promptCliente = `Você analisa pedidos de persianas entre vidros da empresa Acciardi.

Extraia APENAS os dados da tabela principal de itens do pedido abaixo.
A tabela tem colunas: COD, QUANT, LARGURA, ALTURA, COR, POS, P.P., T.COM, COLOCAÇÃO, VALOR.

Ignore completamente:
- Observações do rodapé
- Instruções de produção
- Tabela de códigos/descrições no final
- Qualquer texto após a tabela principal de itens
- Linhas que começam com "OBS", "INCLUIR", "Siglas", "Cod Abatex"

Para cada linha de item da tabela, extraia:
- quantidade: coluna QUANT
- largura: coluna LARGURA (em metros, ex: 0,879)
- altura: coluna ALTURA (em metros, ex: 2,690)
- cor: coluna COR (código numérico, ex: 4)
- lamina: identificado pelo código do produto (66/R = 16mm, etc)
- cor_botao: valor após "BOTÃO = COR" ou "Para Uso Interno: BOTÃO ="
- tamanho_cabo: coluna T.COM
- codigo_cor: coluna COR (mesmo valor)
- acionamento: não costuma aparecer no pedido do cliente, use null
- observacoes: APENAS observações diretamente ligadas ao item, NÃO copie observações gerais do rodapé

Retorne APENAS JSON válido sem texto extra:
{
  "itens": [
    {
      "item": "1",
      "quantidade": "2",
      "largura": "0,879",
      "altura": "2,690",
      "cor": "4",
      "lamina": "16mm",
      "cor_botao": "COR 04 ALUMINIO",
      "tamanho_cabo": "1,800",
      "codigo_cor": "4",
      "acionamento": null,
      "observacoes": null
    }
  ]
}

TEXTO DO PEDIDO DO CLIENTE:
`;

    const promptProducao = `Você analisa ordens de produção de persianas entre vidros.

Extraia APENAS os dados dos itens de persiana do documento abaixo.
Os itens têm campos: UN, Qtde, Larg, Alt, TC (tamanho do cabo), Mod, Acionamento.

Ignore completamente:
- Dados financeiros (valores, descontos, totais, IPI, ICMS)
- Dados do cliente (nome, endereço, CNPJ)
- Dados de entrega e transportadora
- Informações de vendedor, comissão
- Qualquer observação no rodapé que não seja diretamente sobre o item

Para cada item de persiana, extraia:
- quantidade: campo Qtde
- largura: campo Larg (em metros)
- altura: campo Alt (em metros)
- cor: código de cor no nome do produto (ex: "0004 ALUMINIO" → "0004" ou "ALUMINIO")
- lamina: identificado no nome do produto (ex: "PH16MM" → "16mm", "PH25MM" → "25mm")
- cor_botao: valor após "BOTÃO COR" nas observações do item
- tamanho_cabo: campo TC
- codigo_cor: código numérico da cor (ex: "0004")
- acionamento: campo Acionamento ou "D"=Direito, "E"=Esquerdo
- observacoes: APENAS observações diretamente sobre o item específico, NÃO inclua observações gerais de pagamento ou entrega

Retorne APENAS JSON válido sem texto extra:
{
  "itens": [
    {
      "item": "1",
      "quantidade": "2",
      "largura": "0,879",
      "altura": "2,690",
      "cor": "ALUMINIO",
      "lamina": "16mm",
      "cor_botao": "COR 04 ALUMINIO",
      "tamanho_cabo": "1,800",
      "codigo_cor": "0004",
      "acionamento": "Direito",
      "observacoes": null
    }
  ]
}

TEXTO DO PEDIDO DE PRODUÇÃO:
`;

    const promptComparacao = `Você compara pedidos de persianas entre vidros e identifica divergências.

DADOS DO PEDIDO DO CLIENTE:
CLIENTE_JSON

DADOS DO PEDIDO DE PRODUÇÃO:
PRODUCAO_JSON

Compare item a item, campo a campo. Retorne APENAS JSON válido:
{
  "status_geral": "APROVADO",
  "total_divergencias": 0,
  "resumo": "texto breve do resultado",
  "comparacoes": [
    {
      "item": "1",
      "status_item": "OK",
      "campos": [
        {"campo": "quantidade", "label": "Quantidade", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "largura", "label": "Largura", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "altura", "label": "Altura", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "cor", "label": "Cor da Persiana", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "lamina", "label": "Lâmina", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "cor_botao", "label": "Cor do Botão", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "tamanho_cabo", "label": "Tamanho do Cabo", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "codigo_cor", "label": "Código da Cor", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "acionamento", "label": "Acionamento", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"},
        {"campo": "observacoes", "label": "Observações", "valor_cliente": "valor", "valor_producao": "valor", "status": "OK"}
      ]
    }
  ]
}

Regras de comparação:
- status pode ser "OK", "DIVERGENTE" ou "AUSENTE"
- Compare semanticamente: "aluminio" = "ALUMINIO" = "0004 ALUMINIO" → OK se mesma cor
- "D" = "Direito", "E" = "Esquerdo"
- Números equivalentes: "0,879" = "0.879" → OK
- Se campo null nos dois, status OK
- Se campo existe em um e não no outro → AUSENTE
- status_item = "OK" somente se todos os campos são OK
- status_geral = "APROVADO" somente se todos os itens são OK
- total_divergencias = soma de campos DIVERGENTE e AUSENTE
`;

    // Extrair dados de cada pedido separadamente
    const [resC, resP] = await Promise.all([
      openai.chat.completions.create({
        model: "gpt-4o", temperature: 0, max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: promptCliente + tc }],
      }),
      openai.chat.completions.create({
        model: "gpt-4o", temperature: 0, max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: promptProducao + tp }],
      }),
    ]);

    const dadosC = JSON.parse(resC.choices[0].message.content);
    const dadosP = JSON.parse(resP.choices[0].message.content);

    const promptFinal = promptComparacao
      .replace("CLIENTE_JSON", JSON.stringify(dadosC, null, 2))
      .replace("PRODUCAO_JSON", JSON.stringify(dadosP, null, 2));

    const resComp = await openai.chat.completions.create({
      model: "gpt-4o", temperature: 0, max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: promptFinal }],
    });

    const comparacao = JSON.parse(resComp.choices[0].message.content);

    return res.json({
      success: true,
      comparacao,
      arquivos: { cliente: fc.originalname, producao: fp.originalname },
    });
  } catch (err) {
    console.error(err);
    if (err.status === 401) return res.status(500).json({ error: "Chave OpenAI inválida." });
    if (err.status === 429) return res.status(500).json({ error: "Limite OpenAI atingido. Tente em 1 minuto." });
    return res.status(500).json({ error: err.message || "Erro interno." });
  } finally {
    toDelete.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));

function getHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Comparador de Pedidos — Persianas Acciardi</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f8f9fc;--sf:#ffffff;--sf2:#f1f3f8;--br:#e2e6ef;--br2:#d0d5e8;--blu:#2563eb;--blg:rgba(37,99,235,.12);--bll:#1d4ed8;--ok:#059669;--okb:rgba(5,150,105,.07);--okr:rgba(5,150,105,.25);--wa:#d97706;--wab:rgba(217,119,6,.07);--war:rgba(217,119,6,.25);--er:#dc2626;--erb:rgba(220,38,38,.07);--err:rgba(220,38,38,.25);--tx:#111827;--tx2:#4b5563;--tx3:#9ca3af;--fn:'DM Sans',system-ui,sans-serif;--mo:'DM Mono',monospace}
html,body{min-height:100vh;background:var(--bg);color:var(--tx);font-family:var(--fn);-webkit-font-smoothing:antialiased}
.app{max-width:980px;margin:0 auto;padding:40px 24px 80px}
.ph{display:flex;align-items:center;gap:14px;margin-bottom:36px;padding-bottom:28px;border-bottom:2px solid var(--br)}
.phi{width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 4px 16px rgba(37,99,235,.25)}
.ph h1{font-size:1.4rem;font-weight:700;letter-spacing:-.02em;color:var(--tx)}
.ph p{font-size:.8rem;color:var(--tx2);margin-top:2px}
.pg{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
@media(max-width:600px){.pg{grid-template-columns:1fr}}
.pc{background:var(--sf);border:1.5px solid var(--br);border-radius:14px;padding:20px;transition:border-color .2s;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.pc.hf{border-color:var(--okr);background:#f0fdf8}
.pch{display:flex;align-items:center;gap:9px;margin-bottom:14px}
.pbg{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;font-size:.62rem;font-weight:700;flex-shrink:0}
.bc{background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe}
.bp{background:#ede9fe;color:#6d28d9;border:1px solid #ddd6fe}
.pch h3{font-size:.9rem;font-weight:600;color:var(--tx)}
.pch small{font-size:.72rem;color:var(--tx3)}
.pdz{border:2px dashed var(--br2);border-radius:10px;padding:28px 16px;text-align:center;cursor:pointer;transition:all .2s;position:relative;background:#fafbff}
.pdz:hover,.pdz.over{border-color:var(--blu);background:var(--blg)}
.pdz input[type=file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}
.dzi{font-size:28px;margin-bottom:8px;display:block;opacity:.5}
.dzt{font-size:.82rem;color:var(--tx2);margin-bottom:3px;font-weight:500}
.dzh{font-size:.68rem;color:var(--tx3);font-family:var(--mo)}
.pfi{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f0fdf8;border:1.5px solid var(--okr);border-radius:8px;margin-top:10px}
.pfn{font-size:.76rem;font-weight:600;color:var(--ok);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pfs{font-size:.67rem;color:var(--tx3);font-family:var(--mo)}
.prm{background:none;border:none;color:var(--tx3);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px;flex-shrink:0}
.prm:hover{color:var(--er)}
.pcta{display:flex;justify-content:center;margin-bottom:36px}
.bcmp{display:inline-flex;align-items:center;gap:9px;padding:13px 44px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:10px;font-family:var(--fn);font-size:.95rem;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 4px 16px rgba(37,99,235,.3);letter-spacing:-.01em}
.bcmp:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(37,99,235,.35)}
.bcmp:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.pld{display:none;flex-direction:column;align-items:center;gap:18px;padding:44px 20px;background:var(--sf);border:1.5px solid var(--br);border-radius:14px;margin-bottom:28px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.pld.on{display:flex}
.pspin{width:44px;height:44px;border:3px solid var(--br);border-top-color:var(--blu);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pstps{display:flex;flex-direction:column;gap:6px;width:100%;max-width:300px}
.pstp{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;font-size:.8rem;color:var(--tx3);transition:all .3s}
.pstp.active{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:500}
.pstp.done{color:var(--ok);font-weight:500}
.psdot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.pstp.active .psdot{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.perr{display:none;align-items:center;gap:11px;padding:14px 16px;background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;margin-bottom:18px}
.perr.on{display:flex}
.perr span{font-size:.82rem;color:var(--er);font-weight:500}
.pres{display:none}
.pres.on{display:block;animation:fadein .35s ease forwards}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.pbn{display:flex;align-items:center;gap:14px;padding:18px 22px;border-radius:14px;margin-bottom:22px;border:1.5px solid}
.pbn.ok{background:#f0fdf8;border-color:var(--okr)}
.pbn.fail{background:#fef2f2;border-color:#fecaca}
.pbn-ico{font-size:32px;flex-shrink:0}
.pbn h2{font-size:1.05rem;font-weight:700;letter-spacing:-.01em}
.pbn.ok h2{color:var(--ok)}
.pbn.fail h2{color:var(--er)}
.pbn p{font-size:.8rem;margin-top:3px;color:var(--tx2)}
.pchs{display:flex;gap:8px;margin-bottom:22px;flex-wrap:wrap}
.ch{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:600;font-family:var(--mo)}
.chd{background:#fef2f2;color:var(--er);border:1px solid #fecaca}
.cho{background:#f0fdf8;color:var(--ok);border:1px solid var(--okr)}
.chw{background:#fffbeb;color:var(--wa);border:1px solid #fde68a}
.pitms{display:flex;flex-direction:column;gap:14px}
.pitm{background:var(--sf);border:1.5px solid var(--br);border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.pitm.hdiv{border-color:#fecaca}
.pitm.aok{border-color:var(--okr)}
.pithd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;user-select:none;transition:background .15s}
.pithd:hover{background:var(--sf2)}
.pithl{display:flex;align-items:center;gap:10px}
.pinum{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--sf2);font-size:.72rem;font-weight:700;font-family:var(--mo);color:var(--tx2);border:1.5px solid var(--br);flex-shrink:0}
.pittl{font-size:.87rem;font-weight:600;color:var(--tx)}
.pitsb{font-size:.72rem;color:var(--tx3);font-family:var(--mo)}
.pibdg{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:.67rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.bdok{background:#f0fdf8;color:var(--ok);border:1px solid var(--okr)}
.bddiv{background:#fef2f2;color:var(--er);border:1px solid #fecaca}
.ptgl{font-size:16px;color:var(--tx3);transition:transform .2s;margin-left:8px}
.pitm.open .ptgl{transform:rotate(180deg)}
.ptblw{display:none;border-top:1.5px solid var(--br);overflow-x:auto}
.pitm.open .ptblw{display:block}
.ptbl{width:100%;border-collapse:collapse;font-size:.8rem}
.ptbl thead tr{background:var(--sf2)}
.ptbl th{padding:10px 14px;text-align:left;font-size:.67rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx2);white-space:nowrap;border-bottom:1.5px solid var(--br)}
.ptbl td{padding:11px 14px;border-bottom:1px solid var(--br);vertical-align:middle;color:var(--tx)}
.ptbl tbody tr:last-child td{border-bottom:none}
.ptbl tbody tr:hover{background:#fafbff}
.ptbl tbody tr.trd{background:#fef2f2}
.ptbl tbody tr.tra{background:#fffbeb}
.fn{font-weight:600;color:var(--tx)}
.fv{font-family:var(--mo);font-size:.79rem;color:var(--tx)}
.vnl{color:var(--tx3);font-style:italic;font-size:.75rem}
.pl{display:inline-flex;align-items:center;gap:3px;padding:2px 10px;border-radius:999px;font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.plo{background:#f0fdf8;color:var(--ok);border:1px solid var(--okr)}
.pld2{background:#fef2f2;color:var(--er);border:1px solid #fecaca}
.pla{background:#fffbeb;color:var(--wa);border:1px solid #fde68a}
.brst{display:inline-flex;align-items:center;gap:7px;padding:10px 22px;background:var(--sf2);color:var(--tx2);border:1.5px solid var(--br);border-radius:8px;font-family:var(--fn);font-size:.82rem;font-weight:500;cursor:pointer;transition:all .2s;margin-top:22px}
.brst:hover{background:var(--sf);color:var(--tx);border-color:var(--tx2)}
.pfoot{margin-top:48px;padding-top:20px;border-top:1.5px solid var(--br);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.pfootx{font-size:.72rem;color:var(--tx3)}
.pfmts{display:flex;gap:5px;flex-wrap:wrap}
.pfmt{padding:2px 8px;background:var(--sf2);border:1px solid var(--br);border-radius:4px;font-family:var(--mo);font-size:.65rem;color:var(--tx3)}
</style>
</head>
<body>
<div class="app">
  <div class="ph">
    <div class="phi">🪟</div>
    <div>
      <h1>Comparador de Pedidos</h1>
      <p>Persianas Acciardi — Verificação automática de divergências</p>
    </div>
  </div>
  <div class="perr" id="perr"><span>⚠️</span><span id="perr-t"></span></div>
  <div class="pg">
    <div class="pc" id="pc-c">
      <div class="pch"><span class="pbg bc">CLI</span><div><h3>Pedido do Cliente</h3><small>Formulário Acciardi</small></div></div>
      <div class="pdz" id="pdz-c">
        <input type="file" id="pin-c" accept=".pdf,.docx,.doc,.xlsx,.xls,.txt">
        <span class="dzi">📄</span>
        <p class="dzt">Clique ou arraste o arquivo</p>
        <p class="dzh">PDF · DOCX · XLS · XLSX · TXT</p>
      </div>
      <div class="pfi" id="pfi-c" style="display:none">
        <span>✅</span>
        <div style="flex:1;min-width:0"><div class="pfn" id="pfn-c"></div><div class="pfs" id="pfs-c"></div></div>
        <button class="prm" onclick="paRm('c')">✕</button>
      </div>
    </div>
    <div class="pc" id="pc-p">
      <div class="pch"><span class="pbg bp">INT</span><div><h3>Pedido Interno</h3><small>Ordem de produção Finestra</small></div></div>
      <div class="pdz" id="pdz-p">
        <input type="file" id="pin-p" accept=".pdf,.docx,.doc,.xlsx,.xls,.txt">
        <span class="dzi">📋</span>
        <p class="dzt">Clique ou arraste o arquivo</p>
        <p class="dzh">PDF · DOCX · XLS · XLSX · TXT</p>
      </div>
      <div class="pfi" id="pfi-p" style="display:none">
        <span>✅</span>
        <div style="flex:1;min-width:0"><div class="pfn" id="pfn-p"></div><div class="pfs" id="pfs-p"></div></div>
        <button class="prm" onclick="paRm('p')">✕</button>
      </div>
    </div>
  </div>
  <div class="pcta"><button class="bcmp" id="pbtn" disabled onclick="paComparar()">🔍 &nbsp;Comparar Pedidos</button></div>
  <div class="pld" id="pld">
    <div class="pspin"></div>
    <p style="font-size:.9rem;font-weight:600;color:#374151">Analisando pedidos...</p>
    <div class="pstps">
      <div class="pstp" id="ps1"><span class="psdot"></span>Lendo e extraindo texto</div>
      <div class="pstp" id="ps2"><span class="psdot"></span>Interpretando pedido do cliente</div>
      <div class="pstp" id="ps3"><span class="psdot"></span>Interpretando pedido de produção</div>
      <div class="pstp" id="ps4"><span class="psdot"></span>Comparando divergências</div>
    </div>
  </div>
  <div class="pres" id="pres">
    <div class="pbn" id="pbn"><span class="pbn-ico" id="pbico"></span><div><h2 id="pbtit"></h2><p id="pbsub"></p></div></div>
    <div class="pchs" id="pchs"></div>
    <div class="pitms" id="pitms"></div>
    <button class="brst" onclick="paReset()">🔄 Nova comparação</button>
  </div>
  <div class="pfoot">
    <span class="pfootx">Persianas Acciardi — Comparador de Pedidos</span>
    <div class="pfmts"><span class="pfmt">PDF</span><span class="pfmt">DOCX</span><span class="pfmt">XLS</span><span class="pfmt">XLSX</span><span class="pfmt">TXT</span></div>
  </div>
</div>
<script>
(function(){
  var st={fc:null,fp:null,ld:false};
  function fb(b){return b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(1)+' MB';}
  function esc(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function gi(id){return document.getElementById(id);}
  function showErr(m){gi('perr-t').textContent=m;gi('perr').classList.add('on');}
  function hideErr(){gi('perr').classList.remove('on');}
  function setStp(n){[1,2,3,4].forEach(function(i){var e=gi('ps'+i);e.classList.remove('active','done');if(i<n)e.classList.add('done');if(i===n)e.classList.add('active');});}
  function updBtn(){gi('pbtn').disabled=!(st.fc&&st.fp)||st.ld;}
  function setup(t){
    var inp=gi('pin-'+t);
    inp.addEventListener('change',function(e){var f=e.target.files&&e.target.files[0];if(f)setFile(f,t);});
    var dz=gi('pdz-'+t);
    dz.addEventListener('dragover',function(e){e.preventDefault();dz.classList.add('over');});
    dz.addEventListener('dragleave',function(){dz.classList.remove('over');});
    dz.addEventListener('drop',function(e){e.preventDefault();dz.classList.remove('over');var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)setFile(f,t);});
  }
  function setFile(f,t){
    if(!/\.(pdf|docx|doc|xlsx|xls|txt)$/i.test(f.name)){showErr('Formato não suportado.');return;}
    if(f.size>20*1024*1024){showErr('Arquivo muito grande (máx 20 MB).');return;}
    hideErr();
    if(t==='c'){st.fc=f;gi('pfn-c').textContent=f.name;gi('pfs-c').textContent=fb(f.size);gi('pfi-c').style.display='flex';gi('pc-c').classList.add('hf');}
    else{st.fp=f;gi('pfn-p').textContent=f.name;gi('pfs-p').textContent=fb(f.size);gi('pfi-p').style.display='flex';gi('pc-p').classList.add('hf');}
    updBtn();
  }
  window.paRm=function(t){
    if(t==='c'){st.fc=null;gi('pin-c').value='';gi('pfi-c').style.display='none';gi('pc-c').classList.remove('hf');}
    else{st.fp=null;gi('pin-p').value='';gi('pfi-p').style.display='none';gi('pc-p').classList.remove('hf');}
    updBtn();
  };
  window.paReset=function(){paRm('c');paRm('p');gi('pres').classList.remove('on');hideErr();gi('pld').classList.remove('on');st.ld=false;updBtn();window.scrollTo({top:0,behavior:'smooth'});};
  window.paComparar=async function(){
    if(!st.fc||!st.fp||st.ld)return;
    hideErr();gi('pres').classList.remove('on');
    st.ld=true;updBtn();gi('pld').classList.add('on');setStp(1);
    try{
      var fd=new FormData();fd.append('cliente',st.fc);fd.append('producao',st.fp);
      setTimeout(function(){setStp(2);},800);
      setTimeout(function(){setStp(3);},3500);
      setTimeout(function(){setStp(4);},8000);
      var r=await fetch('/compare',{method:'POST',body:fd});
      var d=await r.json();
      gi('pld').classList.remove('on');
      if(!r.ok)throw new Error(d.error||'Erro '+r.status);
      if(!d.success)throw new Error(d.error||'Comparação falhou.');
      render(d);
    }catch(e){gi('pld').classList.remove('on');showErr(e.message||'Erro desconhecido.');}
    finally{st.ld=false;updBtn();}
  };
  function mkTbl(campos){
    var lb={quantidade:'Quantidade',largura:'Largura',altura:'Altura',cor:'Cor da Persiana',lamina:'Lâmina',cor_botao:'Cor do Botão',tamanho_cabo:'Tamanho do Cabo',codigo_cor:'Código da Cor',acionamento:'Acionamento',observacoes:'Observações'};
    var rows=campos.map(function(c){
      var rc=c.status==='DIVERGENTE'?'trd':c.status==='AUSENTE'?'tra':'';
      var pc=c.status==='OK'?'plo':c.status==='DIVERGENTE'?'pld2':'pla';
      var ic=c.status==='OK'?'✓':c.status==='DIVERGENTE'?'✗':'!';
      var vc=c.valor_cliente!=null?'<span class="fv">'+esc(c.valor_cliente)+'</span>':'<span class="vnl">—</span>';
      var vp=c.valor_producao!=null?'<span class="fv">'+esc(c.valor_producao)+'</span>':'<span class="vnl">—</span>';
      return '<tr class="'+rc+'"><td><span class="fn">'+(lb[c.campo]||c.label||esc(c.campo))+'</span></td><td>'+vc+'</td><td>'+vp+'</td><td><span class="pl '+pc+'">'+ic+' '+esc(c.status)+'</span></td></tr>';
    });
    return '<table class="ptbl"><thead><tr><th>Campo</th><th>Pedido do Cliente</th><th>Pedido de Produção</th><th>Status</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>';
  }
  function render(data){
    var c=data.comparacao,apr=c.status_geral==='APROVADO',td=c.total_divergencias||0;
    gi('pbn').className='pbn '+(apr?'ok':'fail');
    gi('pbico').textContent=apr?'✅':'❌';
    gi('pbtit').textContent=apr?'PEDIDO APROVADO SEM DIVERGÊNCIAS':'PEDIDO REPROVADO — NECESSITA CORREÇÃO';
    gi('pbsub').textContent=c.resumo||'';
    var ti=(c.comparacoes||[]).length,tok=(c.comparacoes||[]).filter(function(i){return i.status_item==='OK';}).length,tdiv=ti-tok;
    gi('pchs').innerHTML='<span class="ch '+(td>0?'chd':'cho')+'">'+(td>0?'⚠ ':'✓ ')+td+' divergência'+(td!==1?'s':'')+'</span><span class="ch cho">✓ '+tok+' item'+(tok!==1?'s':'')+'</span>'+(tdiv>0?'<span class="ch chd">✗ '+tdiv+' item'+(tdiv!==1?'s':'')+'</span>':'')+'<span class="ch chw">📄 '+esc(data.arquivos.cliente)+'</span><span class="ch chw">📋 '+esc(data.arquivos.producao)+'</span>';
    gi('pitms').innerHTML='';
    (c.comparacoes||[]).forEach(function(item,idx){
      var hd=item.status_item!=='OK',dc=(item.campos||[]).filter(function(x){return x.status!=='OK';}).length;
      var div=document.createElement('div');
      div.className='pitm '+(hd?'hdiv':'aok');
      div.innerHTML='<div class="pithd"><div class="pithl"><div class="pinum">'+(esc(item.item)||idx+1)+'</div><div><div class="pittl">Item '+(esc(item.item)||idx+1)+'</div><div class="pitsb">'+(dc>0?dc+' campo'+(dc!==1?'s':'')+' divergente'+(dc!==1?'s':''):'Todos os campos conferem')+'</div></div></div><div style="display:flex;align-items:center;gap:6px"><span class="pibdg '+(hd?'bddiv':'bdok')+'">'+(hd?'✗ Divergente':'✓ OK')+'</span><span class="ptgl">▾</span></div></div><div class="ptblw">'+mkTbl(item.campos||[])+'</div>';
      div.querySelector('.pithd').addEventListener('click',function(){div.classList.toggle('open');});
      if(hd)div.classList.add('open');
      gi('pitms').appendChild(div);
    });
    gi('pres').classList.add('on');gi('pres').scrollIntoView({behavior:'smooth',block:'start'});
  }
  setup('c');setup('p');updBtn();
})();
</script>
</body>
</html>`;
}
