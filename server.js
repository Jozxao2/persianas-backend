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

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: "*",
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// ─── MULTER ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/plain",
    ];
    if (
      allowed.includes(file.mimetype) ||
      /\.(pdf|docx|doc|xlsx|xls|txt)$/i.test(file.originalname)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Formato de arquivo não suportado."), false);
    }
  },
});

// ─── OPENAI ────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── EXTRAÇÃO DE TEXTO ─────────────────────────────────────────────────────────
async function extractText(filePath, mimetype, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  try {
    // PDF
    if (ext === ".pdf" || mimetype === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }

    // DOCX / DOC
    if (
      ext === ".docx" ||
      ext === ".doc" ||
      mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    // XLSX / XLS
    if (
      ext === ".xlsx" ||
      ext === ".xls" ||
      mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimetype === "application/vnd.ms-excel"
    ) {
      const workbook = xlsx.readFile(filePath);
      let fullText = "";
      workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const csv = xlsx.utils.sheet_to_csv(sheet);
        fullText += `\n--- Aba: ${sheetName} ---\n${csv}`;
      });
      return fullText;
    }

    // TXT
    if (ext === ".txt" || mimetype === "text/plain") {
      return fs.readFileSync(filePath, "utf-8");
    }

    throw new Error("Formato não reconhecido.");
  } catch (err) {
    throw new Error(`Falha ao extrair texto: ${err.message}`);
  }
}

// ─── PROMPT DE EXTRAÇÃO ────────────────────────────────────────────────────────
function buildExtractionPrompt(text, tipo) {
  return `Você é um especialista em análise de pedidos de persianas entre vidros.

Analise o texto abaixo (${tipo}) e extraia TODOS os itens do pedido.

Para cada item/persiana encontrada, retorne um objeto JSON com estes campos exatos:
- item: número ou identificador do item
- quantidade: número inteiro
- largura: valor em mm ou cm (inclua a unidade)
- altura: valor em mm ou cm (inclua a unidade)
- cor: nome ou código da cor da persiana
- lamina: "16mm" ou "25mm" (tamanho da lâmina)
- cor_botao: cor do botão de acionamento
- tamanho_cabo: comprimento do cabo em metros ou cm
- codigo_cor: código alfanumérico da cor (ex: B01, W03, etc.)
- acionamento: tipo de acionamento (ex: direito, esquerdo, manual, motorizado)
- observacoes: qualquer observação especial

Responda APENAS com um JSON válido no formato:
{
  "itens": [
    { ... campos acima ... },
    ...
  ],
  "resumo": "breve descrição do pedido"
}

Se um campo não estiver presente no texto, use null.
Não inclua explicações, apenas o JSON.

TEXTO DO PEDIDO:
${text}`;
}

// ─── PROMPT DE COMPARAÇÃO ──────────────────────────────────────────────────────
function buildComparisonPrompt(clienteJSON, producaoJSON) {
  return `Você é um especialista em controle de qualidade de pedidos de persianas entre vidros.

Compare os dois pedidos abaixo e identifique divergências campo a campo.

PEDIDO DO CLIENTE:
${JSON.stringify(clienteJSON, null, 2)}

PEDIDO DE PRODUÇÃO (interno):
${JSON.stringify(producaoJSON, null, 2)}

Retorne um JSON com a comparação detalhada. Para cada item do pedido, compare todos os campos.

Formato de resposta:
{
  "comparacoes": [
    {
      "item": "1",
      "campos": [
        {
          "campo": "quantidade",
          "label": "Quantidade",
          "valor_cliente": "valor do cliente",
          "valor_producao": "valor da produção",
          "status": "OK" | "DIVERGENTE" | "AUSENTE"
        },
        ... (repita para todos os campos: quantidade, largura, altura, cor, lamina, cor_botao, tamanho_cabo, codigo_cor, acionamento, observacoes)
      ],
      "status_item": "OK" | "DIVERGENTE"
    }
  ],
  "status_geral": "APROVADO" | "REPROVADO",
  "total_divergencias": número,
  "resumo": "texto explicando o resultado"
}

Regras:
- Compare valores semanticamente (ex: "direito" e "Direito" = OK; "16mm" e "25mm" = DIVERGENTE)
- Se um campo está em um pedido mas não no outro, marque como AUSENTE
- Se valores são equivalentes mesmo com formatação diferente, marque OK
- status_geral é APROVADO somente se TODOS os campos de TODOS os itens são OK
- Responda APENAS com JSON válido, sem explicações extras.`;
}

// ─── ROTA PRINCIPAL ────────────────────────────────────────────────────────────
app.post(
  "/compare",
  upload.fields([
    { name: "cliente", maxCount: 1 },
    { name: "producao", maxCount: 1 },
  ]),
  async (req, res) => {
    const filesToDelete = [];

    try {
      // Validar uploads
      if (!req.files || !req.files.cliente || !req.files.producao) {
        return res.status(400).json({
          error: "Envie os dois arquivos: 'cliente' e 'producao'.",
        });
      }

      const arquivoCliente = req.files.cliente[0];
      const arquivoProducao = req.files.producao[0];
      filesToDelete.push(arquivoCliente.path, arquivoProducao.path);

      // Extrair texto dos arquivos
      const [textoCliente, textoProducao] = await Promise.all([
        extractText(
          arquivoCliente.path,
          arquivoCliente.mimetype,
          arquivoCliente.originalname
        ),
        extractText(
          arquivoProducao.path,
          arquivoProducao.mimetype,
          arquivoProducao.originalname
        ),
      ]);

      if (!textoCliente.trim()) {
        return res
          .status(400)
          .json({ error: "Não foi possível extrair texto do pedido do cliente." });
      }
      if (!textoProducao.trim()) {
        return res
          .status(400)
          .json({ error: "Não foi possível extrair texto do pedido de produção." });
      }

      // Extrair dados estruturados via OpenAI
      const [respostaCliente, respostaProducao] = await Promise.all([
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: buildExtractionPrompt(textoCliente, "Pedido do Cliente"),
            },
          ],
          temperature: 0,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: buildExtractionPrompt(textoProducao, "Pedido de Produção"),
            },
          ],
          temperature: 0,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
      ]);

      let dadosCliente, dadosProducao;

      try {
        dadosCliente = JSON.parse(respostaCliente.choices[0].message.content);
      } catch {
        return res
          .status(500)
          .json({ error: "Falha ao interpretar dados do pedido do cliente." });
      }

      try {
        dadosProducao = JSON.parse(respostaProducao.choices[0].message.content);
      } catch {
        return res
          .status(500)
          .json({ error: "Falha ao interpretar dados do pedido de produção." });
      }

      // Comparar via OpenAI
      const respostaComparacao = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: buildComparisonPrompt(dadosCliente, dadosProducao),
          },
        ],
        temperature: 0,
        max_tokens: 6000,
        response_format: { type: "json_object" },
      });

      let comparacao;
      try {
        comparacao = JSON.parse(respostaComparacao.choices[0].message.content);
      } catch {
        return res
          .status(500)
          .json({ error: "Falha ao interpretar resultado da comparação." });
      }

      // Retornar resultado completo
      return res.json({
        success: true,
        dados_cliente: dadosCliente,
        dados_producao: dadosProducao,
        comparacao,
        arquivos: {
          cliente: arquivoCliente.originalname,
          producao: arquivoProducao.originalname,
        },
      });
    } catch (err) {
      console.error("Erro na rota /compare:", err);

      if (err.message?.includes("multer")) {
        return res.status(400).json({ error: err.message });
      }

      if (err.status === 401) {
        return res
          .status(500)
          .json({ error: "Chave da OpenAI inválida ou expirada." });
      }

      if (err.status === 429) {
        return res
          .status(500)
          .json({ error: "Limite de requisições da OpenAI atingido. Tente novamente." });
      }

      return res.status(500).json({
        error: err.message || "Erro interno do servidor.",
      });
    } finally {
      // Limpar arquivos temporários
      filesToDelete.forEach((filePath) => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      });
    }
  }
);

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Servidor de comparação de persianas rodando." });
});

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
