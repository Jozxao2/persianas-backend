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

// ── Serve a página do comparador diretamente ──────────────────────────────────
app.get("/", (req, res) => {
  res.send(getHTML());
});

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
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

// ── OpenAI ────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Extração de texto ─────────────────────────────────────────────────────────
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  try {
    if (ext === ".pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      return data.text;
    }
    if (ext === ".docx" || ext === ".doc") {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    if (ext === ".xlsx" || ext === ".xls") {
      const wb = xlsx.readFile(filePath);
      let text = "";
      wb.SheetNames.forEach(s => { text += "\n" + xlsx.utils.sheet_to_csv(wb.Sheets[s]); });
      return text;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error("Falha ao extrair texto: " + err.message);
  }
}

// ── Rota compare ──────────────────────────────────────────────────────────────
app.post("/compare", upload.fields([{ name: "cliente", maxCount: 1 }, { name: "producao", maxCount: 1 }]), async (req, res) => {
  const toDelete = [];
  try {
    if (!req.files?.cliente || !req.files?.producao) {
      return res.status(400).json({ error: "Envie os dois arquivos." });
    }
    const fc = req.files.cliente[0];
    const fp = req.files.producao[0];
    toDelete.push(fc.path, fp.path);

    const [tc, tp] = await Promise.all([
      extractText(fc.path, fc.originalname),
      extractText(fp.path, fp.originalname),
    ]);

    if (!tc.trim()) return res.status(400).json({ error: "Não foi possível extrair texto do pedido do cliente." });
    if (!tp.trim()) return res.status(400).json({ error: "Não foi possível extrair texto do pedido de produção." });

    const prompt = `Você é especialista em pedidos de persianas entre vidros.

Compare os dois pedidos e retorne APENAS um JSON válido, sem texto extra.

PEDIDO DO CLIENTE:
${tc}

PEDIDO DE PRODUÇÃO:
${tp}

Formato exato da resposta:
{
  "status_geral": "APROVADO",
  "total_divergencias": 0,
  "resumo": "texto breve",
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

Regras:
- status: "OK", "DIVERGENTE" ou "AUSENTE"
- Compare semanticamente (Direito = direito = OK)
- Se campo ausente nos dois, valor null
- status_geral APROVADO só se todos OK`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    });

    const comparacao = JSON.parse(resp.choices[0].message.content);

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

// ── HTML do comparador ────────────────────────────────────────────────────────
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
:root{--bg:#0d0f14;--sf:#151820;--sf2:#1c2030;--br:#252a38;--br2:#2e3448;--blu:#2563eb;--blg:rgba(37,99,235,.25);--bll:#3b82f6;--ok:#10b981;--okb:rgba(16,185,129,.08);--okr:rgba(16,185,129,.25);--wa:#f59e0b;--wab:rgba(245,158,11,.08);--war:rgba(245,158,11,.25);--er:#ef4444;--erb:rgba(239,68,68,.08);--err:rgba(239,68,68,.25);--tx:#e8ecf4;--tx2:#8b95ad;--tx3:#555f7a;--fn:'DM Sans',system-ui,sans-serif;--mo:'DM Mono',monospace}
html,body{min-height:100vh;background:var(--bg);color:var(--tx);font-family:var(--fn);-webkit-font-smoothing:antialiased}
.app{max-width:960px;margin:0 auto;padding:40px 24px 80px}
.ph{display:flex;align-items:center;gap:14px;margin-bottom:36px;padding-bottom:28px;border-bottom:1px solid var(--br)}
.phi{width:48px;height:48px;background:linear-gradient(135deg,var(--blu),#1d4ed8);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 0 24px var(--blg)}
.ph h1{font-size:1.4rem;font-weight:700;letter-spacing:-.02em}
.ph p{font-size:.8rem;color:var(--tx2);margin-top:2px}
.pg{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
@media(max-width:600px){.pg{grid-template-columns:1fr}}
.pc{background:var(--sf);border:1px solid var(--br);border-radius:16px;padding:20px;transition:border-color .2s}
.pc.hf{border-color:var(--okr);background:var(--okb)}
.pch{display:flex;align-items:center;gap:9px;margin-bottom:14px}
.pbg{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;font-size:.62rem;font-weight:700;flex-shrink:0}
.bc{background:rgba(37,99,235,.15);color:var(--bll);border:1px solid rgba(37,99,235,.3)}
.bp{background:rgba(139,92,246,.15);color:#a78bfa;border:1px solid rgba(139,92,246,.3)}
.pch h3{font-size:.9rem;font-weight:600}
.pch small{font-size:.72rem;color:var(--tx3)}
.pdz{border:2px dashed var(--br2);border-radius:12px;padding:28px 16px;text-align:center;cursor:pointer;transition:all .2s;position:relative}
.pdz:hover,.pdz.over{border-color:var(--blu);background:var(--blg)}
.pdz input[type=file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:0}
.dzi{font-size:28px;margin-bottom:8px;display:block;opacity:.55}
.dzt{font-size:.82rem;color:var(--tx2);margin-bottom:3px}
.dzh{font-size:.68rem;color:var(--tx3);font-family:var(--mo)}
.pfi{display:flex;align-items:center;gap:8px;padding:11px 13px;background:var(--okb);border:1px solid var(--okr);border-radius:8px;margin-top:10px}
.pfn{font-size:.76rem;font-weight:500;color:var(--ok);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pfs{font-size:.67rem;color:var(--tx3);font-family:var(--mo)}
.prm{background:none;border:none;color:var(--tx3);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px;flex-shrink:0}
.prm:hover{color:var(--er)}
.pcta{display:flex;justify-content:center;margin-bottom:36px}
.bcmp{display:inline-flex;align-items:center;gap:9px;padding:13px 40px;background:linear-gradient(135deg,var(--blu),#1d4ed8);color:#fff;border:none;border-radius:12px;font-family:var(--fn);font-size:.95rem;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 4px 24px var(--blg);letter-spacing:-.01em}
.bcmp:hover{transform:translateY(-1px);box-shadow:0 8px 32px var(--blg)}
.bcmp:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.pld{display:none;flex-direction:column;align-items:center;gap:18px;padding:44px 20px;background:var(--sf);border:1px solid var(--br);border-radius:16px;margin-bottom:28px;text-align:center}
.pld.on{display:flex}
.pspin{width:44px;height:44px;border:3px solid var(--br2);border-top-color:var(--blu);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pstps{display:flex;flex-direction:column;gap:6px;width:100%;max-width:300px}
.pstp{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;font-size:.8rem;color:var(--tx3);transition:all .3s}
.pstp.active{background:var(--blg);color:var(--tx);border:1px solid rgba(37,99,235,.2)}
.pstp.done{color:var(--ok)}
.psdot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.pstp.active .psdot{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.perr{display:none;align-items:center;gap:11px;padding:14px 16px;background:var(--erb);border:1px solid var(--err);border-radius:10px;margin-bottom:18px}
.perr.on{display:flex}
.perr span{font-size:.82rem;color:var(--er)}
.pres{display:none}
.pres.on{display:block;animation:fadein .35s ease forwards}
@keyframes fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.pbn{display:flex;align-items:center;gap:14px;padding:18px 22px;border-radius:16px;margin-bottom:24px;border:1px solid}
.pbn.ok{background:var(--okb);border-color:var(--okr)}
.pbn.fail{background:var(--erb);border-color:var(--err)}
.pbn-ico{font-size:32px;flex-shrink:0}
.pbn h2{font-size:1.05rem;font-weight:700;letter-spacing:-.01em}
.pbn.ok h2{color:var(--ok)}
.pbn.fail h2{color:var(--er)}
.pbn p{font-size:.8rem;margin-top:2px}
.pbn.ok p{color:rgba(16,185,129,.7)}
.pbn.fail p{color:rgba(239,68,68,.7)}
.pchs{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
.ch{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:500;font-family:var(--mo)}
.chd{background:var(--erb);color:var(--er);border:1px solid var(--err)}
.cho{background:var(--okb);color:var(--ok);border:1px solid var(--okr)}
.chw{background:var(--wab);color:var(--wa);border:1px solid var(--war)}
.pitms{display:flex;flex-direction:column;gap:14px}
.pitm{background:var(--sf);border:1px solid var(--br);border-radius:16px;overflow:hidden;transition:border-color .2s}
.pitm.hdiv{border-color:var(--err)}
.pitm.aok{border-color:var(--okr)}
.pithd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;user-select:none;transition:background .2s}
.pithd:hover{background:var(--sf2)}
.pithl{display:flex;align-items:center;gap:10px}
.pinum{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--sf2);font-size:.72rem;font-weight:600;font-family:var(--mo);color:var(--tx2);border:1px solid var(--br2);flex-shrink:0}
.pittl{font-size:.87rem;font-weight:600}
.pitsb{font-size:.72rem;color:var(--tx3);font-family:var(--mo)}
.pibdg{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;font-size:.67rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.bdok{background:var(--okb);color:var(--ok);border:1px solid var(--okr)}
.bddiv{background:var(--erb);color:var(--er);border:1px solid var(--err)}
.ptgl{font-size:16px;color:var(--tx3);transition:transform .2s;margin-left:8px}
.pitm.open .ptgl{transform:rotate(180deg)}
.ptblw{display:none;border-top:1px solid var(--br);overflow-x:auto}
.pitm.open .ptblw{display:block}
.ptbl{width:100%;border-collapse:collapse;font-size:.8rem}
.ptbl thead tr{background:var(--sf2)}
.ptbl th{padding:9px 14px;text-align:left;font-size:.67rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);white-space:nowrap;border-bottom:1px solid var(--br)}
.ptbl td{padding:10px 14px;border-bottom:1px solid var(--br);vertical-align:middle}
.ptbl tbody tr:last-child td{border-bottom:none}
.ptbl tbody tr:hover{background:rgba(255,255,255,.02)}
.ptbl tbody tr.trd{background:var(--erb)}
.ptbl tbody tr.tra{background:var(--wab)}
.fn{font-weight:500;color:var(--tx)}
.fv{font-family:var(--mo);font-size:.78rem}
.vnl{color:var(--tx3);font-style:italic;font-size:.75rem}
.pl{display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:999px;font-size:.66rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
.plo{background:var(--okb);color:var(--ok);border:1px solid var(--okr)}
.pld2{background:var(--erb);color:var(--er);border:1px solid var(--err)}
.pla{background:var(--wab);color:var(--wa);border:1px solid var(--war)}
.brst{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;background:var(--sf2);color:var(--tx2);border:1px solid var(--br2);border-radius:8px;font-family:var(--fn);font-size:.82rem;font-weight:500;cursor:pointer;transition:all .2s;margin-top:22px}
.brst:hover{background:var(--sf);color:var(--tx);border-color:var(--tx3)}
.pfoot{margin-top:48px;padding-top:20px;border-top:1px solid var(--br);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.pfootx{font-size:.72rem;color:var(--tx3)}
.pfmts{display:flex;gap:5px;flex-wrap:wrap}
.pfmt{padding:2px 7px;background:var(--sf2);border:1px solid var(--br);border-radius:4px;font-family:var(--mo);font-size:.65rem;color:var(--tx3)}
</style>
</head>
<body>
<div class="app">
  <div class="ph">
    <div class="phi">🪟</div>
    <div>
      <h1>Comparador de Pedidos</h1>
      <p>Persianas entre vidros — Verificação automática de divergências</p>
    </div>
  </div>
  <div class="perr" id="perr"><span>⚠️</span><span id="perr-t"></span></div>
  <div class="pg">
    <div class="pc" id="pc-c">
      <div class="pch"><span class="pbg bc">CLI</span><div><h3>Pedido do Cliente</h3><small>Documento enviado pelo cliente</small></div></div>
      <div class="pdz" id="pdz-c">
        <input type="file" id="pin-c" accept=".pdf,.docx,.doc,.xlsx,.xls,.txt">
        <span class="dzi">📄</span>
        <p class="dzt">Clique ou arraste o arquivo aqui</p>
        <p class="dzh">PDF · DOCX · XLS · XLSX · TXT</p>
      </div>
      <div class="pfi" id="pfi-c" style="display:none">
        <span>✅</span>
        <div style="flex:1;min-width:0"><div class="pfn" id="pfn-c"></div><div class="pfs" id="pfs-c"></div></div>
        <button class="prm" onclick="paRm('c')">✕</button>
      </div>
    </div>
    <div class="pc" id="pc-p">
      <div class="pch"><span class="pbg bp">INT</span><div><h3>Pedido Interno</h3><small>Documento gerado pela produção</small></div></div>
      <div class="pdz" id="pdz-p">
        <input type="file" id="pin-p" accept=".pdf,.docx,.doc,.xlsx,.xls,.txt">
        <span class="dzi">📋</span>
        <p class="dzt">Clique ou arraste o arquivo aqui</p>
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
    <p style="font-size:.9rem;font-weight:600">Analisando pedidos...</p>
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
    if(!/\.(pdf|docx|doc|xlsx|xls|txt)$/i.test(f.name)){showErr('Formato não suportado. Use PDF, DOCX, XLS, XLSX ou TXT.');return;}
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

  window.paReset=function(){
    paRm('c');paRm('p');
    gi('pres').classList.remove('on');hideErr();
    gi('pld').classList.remove('on');
    st.ld=false;updBtn();
    window.scrollTo({top:0,behavior:'smooth'});
  };

  window.paComparar=async function(){
    if(!st.fc||!st.fp||st.ld)return;
    hideErr();gi('pres').classList.remove('on');
    st.ld=true;updBtn();
    gi('pld').classList.add('on');setStp(1);
    try{
      var fd=new FormData();
      fd.append('cliente',st.fc);
      fd.append('producao',st.fp);
      setTimeout(function(){setStp(2);},800);
      setTimeout(function(){setStp(3);},3000);
      setTimeout(function(){setStp(4);},7000);
      var r=await fetch('/compare',{method:'POST',body:fd});
      var d=await r.json();
      gi('pld').classList.remove('on');
      if(!r.ok)throw new Error(d.error||'Erro '+r.status);
      if(!d.success)throw new Error(d.error||'Comparação falhou.');
      render(d);
    }catch(e){
      gi('pld').classList.remove('on');
      showErr(e.message||'Erro desconhecido.');
    }finally{st.ld=false;updBtn();}
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
    gi('pres').classList.add('on');
    gi('pres').scrollIntoView({behavior:'smooth',block:'start'});
  }

  setup('c');setup('p');updBtn();
})();
</script>
</body>
</html>`;
}
