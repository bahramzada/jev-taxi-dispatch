import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Agent, fetch as undiciFetch } from "undici";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3100;

const LLM_MODEL = process.env.LLM_MODEL || "google/gemini-3.5-flash-lite";
const LLM_ENABLED = Boolean(process.env.OPENROUTER_API_KEY);

// Qiymətlər (USD / 1M token) — xərc müqayisəsi üçün
const PRICING = {
  jev: { input: 0.042, output: 0 },
  llm: { input: 0.3, output: 2.5 },
};

// Score rubrikası hər iki model üçün eynidir
const URGENCY_LEVELS = [
  "Adi sifariş, sərnişin tələsmir",
  "Yüngül tələsmə hiss olunur",
  "Açıq şəkildə tələsir, gecikmə problem yaradır",
  "Fövqəladə hal — uçuş, tibbi və ya bənzər kritik səbəb",
];

const SERVICE_TYPES = {
  standart: "Adi sərnişin gedişi",
  komfort: "Biznes sinif, yüksək rahatlıq tələbi",
  yuk: "Baqaj, əşya və ya yük daşınması",
};

const INSTRUCTIONS = {
  surucu: "Bu sifarişi hansı sürücü götürməlidir? Məsafə, gözlənilən çatma vaxtı və reytinqi birlikdə nəzərə al.",
  tecililik: "Sərnişinin mesajına əsasən sifariş nə qədər təcilidir?",
  saxta_sifaris: "Bu sifariş saxta, zarafat və ya sui-istifadə cəhdidir?",
  xidmet_tipi: "Sərnişinə hansı xidmət tipi uyğundur?",
};

if (!process.env.JEV_API_KEY) {
  console.warn("XƏBƏRDARLIQ: .env faylında JEV_API_KEY tapılmadı.");
}
if (!LLM_ENABLED) {
  console.warn("XƏBƏRDARLIQ: OPENROUTER_API_KEY yoxdur — LLM müqayisəsi deaktivdir.");
}

/**
 * Hər iki model üçün eyni keep-alive agent.
 *
 * Standart bağlantı bir neçə saniyə boşdan sonra bağlanır; sifarişlər arasında
 * 4-5 saniyə fasilə olduğu üçün hər çağırış yenidən TLS əl sıxması ödəyirdi və
 * ölçülən gecikməyə ~800ms əlavə edirdi. İsti bağlantı həm real istehsal
 * quruluşudur, həm də müqayisəni ədalətli saxlayır — parametrlər eynidir.
 */
const keepAliveAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 180_000,
  connections: 8,
});

const warmFetch = (url, options = {}) =>
  undiciFetch(url, { ...options, dispatcher: keepAliveAgent });

const jev = new TypeSafeClient({
  apiKey: process.env.JEV_API_KEY,
  fetch: warmFetch,
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/data", express.static(path.join(__dirname, "data")));

/** Sürücü siyahısını hər iki model üçün eyni mətnə çevirir */
function driverCriteria(drivers) {
  const criteria = {};
  for (const d of drivers) {
    criteria[d.id] =
      `${d.name}, ${d.car}, ${d.distanceKm.toFixed(1)} km məsafədə, ` +
      `təxmini çatma ${d.etaMin} dəqiqə, reytinq ${d.rating.toFixed(1)}`;
  }
  return criteria;
}

function cost(inputTokens, outputTokens, rates) {
  return (
    (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output
  );
}

// ---------------------------------------------------------------- JEV

async function callJev(order, drivers) {
  const started = performance.now();

  const result = await jev.systemOne({
    state: order,
    questions: {
      surucu: {
        type: "choice",
        instructions: INSTRUCTIONS.surucu,
        criteria: driverCriteria(drivers),
      },
      tecililik: {
        type: "score",
        instructions: INSTRUCTIONS.tecililik,
        criteria: URGENCY_LEVELS,
      },
      saxta_sifaris: {
        type: "noul",
        instructions: INSTRUCTIONS.saxta_sifaris,
      },
      xidmet_tipi: {
        type: "choice",
        instructions: INSTRUCTIONS.xidmet_tipi,
        criteria: SERVICE_TYPES,
      },
    },
  });

  const latencyMs = Math.round(performance.now() - started);
  const a = result.answers;

  return {
    engine: "jev",
    model: result.model,
    latencyMs,
    ok: true,
    // JEV tipli cavab qaytardığı üçün sxem pozuntusu konstruksiyaya görə mümkün deyil
    schemaIssues: [],
    decision: {
      surucu: a.surucu.choice,
      surucuConfidence: a.surucu.confidence,
      surucuProbabilities: a.surucu.probabilities,
      tecililik: a.tecililik.score,
      tecililikConfidence: a.tecililik.confidence,
      saxta: a.saxta_sifaris.noul,
      xidmetTipi: a.xidmet_tipi.choice,
      xidmetConfidence: a.xidmet_tipi.confidence,
    },
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      costUsd: cost(
        result.usage?.input_tokens ?? 0,
        result.usage?.output_tokens ?? 0,
        PRICING.jev
      ),
    },
  };
}

// ---------------------------------------------------------------- LLM (OpenRouter)

function llmPrompt(order, drivers) {
  const driverLines = Object.entries(driverCriteria(drivers))
    .map(([id, desc]) => `  ${id}: ${desc}`)
    .join("\n");

  const urgencyLines = URGENCY_LEVELS.map((t, i) => `  ${i} = ${t}`).join("\n");
  const serviceLines = Object.entries(SERVICE_TYPES)
    .map(([id, desc]) => `  ${id}: ${desc}`)
    .join("\n");

  return [
    {
      role: "system",
      content:
        "Sən taksi dispetçerisən. Sənə sifariş məlumatı və sürücü siyahısı verilir. " +
        "Yalnız JSON obyekt qaytar, izahat yazma.",
    },
    {
      role: "user",
      content:
        `SİFARİŞ:\n${JSON.stringify(order, null, 2)}\n\n` +
        `SÜRÜCÜLƏR:\n${driverLines}\n\n` +
        `SUALLAR:\n` +
        `1. surucu — ${INSTRUCTIONS.surucu} Cavab: yuxarıdakı sürücü ID-lərindən biri.\n` +
        `2. tecililik — ${INSTRUCTIONS.tecililik} Şkala:\n${urgencyLines}\n` +
        `3. saxta_sifaris — ${INSTRUCTIONS.saxta_sifaris} Cavab: 0 ilə 1 arası ehtimal.\n` +
        `4. xidmet_tipi — ${INSTRUCTIONS.xidmet_tipi} Variantlar:\n${serviceLines}\n` +
        `5. etibar — seçdiyin sürücüyə nə qədər əminsən (0-1).`,
    },
  ];
}

function llmSchema(drivers) {
  return {
    name: "dispatch_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        surucu: { type: "string", enum: drivers.map((d) => d.id) },
        tecililik: { type: "integer", minimum: 0, maximum: URGENCY_LEVELS.length - 1 },
        saxta_sifaris: { type: "number", minimum: 0, maximum: 1 },
        xidmet_tipi: { type: "string", enum: Object.keys(SERVICE_TYPES) },
        etibar: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["surucu", "tecililik", "saxta_sifaris", "xidmet_tipi", "etibar"],
      additionalProperties: false,
    },
  };
}

/** LLM cavabını yoxlayır — sxem pozuntularını konkret şəkildə sayır */
function validateLlm(parsed, drivers) {
  const issues = [];
  const driverIds = new Set(drivers.map((d) => d.id));

  if (!parsed || typeof parsed !== "object") {
    return { issues: ["cavab obyekt deyil"] };
  }
  if (typeof parsed.surucu !== "string" || !driverIds.has(parsed.surucu)) {
    issues.push(`mövcud olmayan sürücü: ${JSON.stringify(parsed.surucu)}`);
  }
  const t = parsed.tecililik;
  if (!Number.isInteger(t) || t < 0 || t > URGENCY_LEVELS.length - 1) {
    issues.push(`diapazondan kənar tecililik: ${JSON.stringify(t)}`);
  }
  const s = parsed.saxta_sifaris;
  if (typeof s !== "number" || Number.isNaN(s) || s < 0 || s > 1) {
    issues.push(`etibarsız saxta_sifaris: ${JSON.stringify(s)}`);
  }
  if (!Object.keys(SERVICE_TYPES).includes(parsed.xidmet_tipi)) {
    issues.push(`etibarsız xidmet_tipi: ${JSON.stringify(parsed.xidmet_tipi)}`);
  }
  const c = parsed.etibar;
  if (typeof c !== "number" || Number.isNaN(c) || c < 0 || c > 1) {
    issues.push(`etibarsız etibar: ${JSON.stringify(c)}`);
  }
  return { issues };
}

async function callLlm(order, drivers) {
  const started = performance.now();

  const res = await warmFetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/bahramzada/jev-taxi-dispatch",
      "X-Title": "JEV Taxi Dispatch",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: llmPrompt(order, drivers),
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_schema", json_schema: llmSchema(drivers) },
    }),
  });

  const latencyMs = Math.round(performance.now() - started);

  if (!res.ok) {
    const body = await res.text();
    return {
      engine: "llm",
      model: LLM_MODEL,
      latencyMs,
      ok: false,
      schemaIssues: [`HTTP ${res.status}`],
      error: body.slice(0, 200),
    };
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "";

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    parseError = err.message;
  }

  const { issues } = parsed
    ? validateLlm(parsed, drivers)
    : { issues: [`JSON parse xətası: ${parseError}`] };

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  return {
    engine: "llm",
    model: json.model || LLM_MODEL,
    latencyMs,
    ok: issues.length === 0,
    schemaIssues: issues,
    raw: issues.length > 0 ? content.slice(0, 300) : undefined,
    decision: parsed
      ? {
          surucu: parsed.surucu,
          surucuConfidence: parsed.etibar,
          tecililik: parsed.tecililik,
          saxta: parsed.saxta_sifaris,
          xidmetTipi: parsed.xidmet_tipi,
        }
      : null,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: cost(inputTokens, outputTokens, PRICING.llm),
    },
  };
}

// ---------------------------------------------------------------- Routes

app.get("/api/config", (_req, res) => {
  res.json({
    llmEnabled: LLM_ENABLED,
    llmModel: LLM_MODEL,
    pricing: PRICING,
    urgencyLevels: URGENCY_LEVELS,
    serviceTypes: SERVICE_TYPES,
  });
});

app.post("/api/dispatch", async (req, res) => {
  const { order, drivers, engines = ["jev"] } = req.body || {};

  if (!order || !Array.isArray(drivers) || drivers.length < 2) {
    return res.status(400).json({ error: "order və ən azı 2 sürücü tələb olunur." });
  }

  const wanted = engines.filter((e) => e === "jev" || (e === "llm" && LLM_ENABLED));
  if (wanted.length === 0) {
    return res.status(400).json({ error: "İşlək engine seçilməyib." });
  }

  // Hər iki model eyni anda, eyni girişlə çağırılır — müqayisə ədalətli olsun
  const settled = await Promise.allSettled(
    wanted.map((e) => (e === "jev" ? callJev(order, drivers) : callLlm(order, drivers)))
  );

  const results = {};
  settled.forEach((outcome, i) => {
    const engine = wanted[i];
    if (outcome.status === "fulfilled") {
      results[engine] = outcome.value;
    } else {
      console.error(`${engine} xətası:`, outcome.reason?.message);
      results[engine] = {
        engine,
        ok: false,
        latencyMs: null,
        schemaIssues: [outcome.reason?.message || "naməlum xəta"],
      };
    }
  });

  if (!results.jev?.ok && wanted.includes("jev")) {
    const detail = results.jev?.schemaIssues?.[0];
    if (detail && !results.llm) {
      return res.status(502).json({ error: `JEV xətası: ${detail}` });
    }
  }

  res.json({ results });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    jev: Boolean(process.env.JEV_API_KEY),
    llm: LLM_ENABLED,
  });
});

app.listen(PORT, () => {
  console.log(`JEV Taxi Dispatch: http://localhost:${PORT}`);
  console.log(`  JEV: ${process.env.JEV_API_KEY ? "hazır" : "AÇAR YOXDUR"}`);
  console.log(`  LLM: ${LLM_ENABLED ? LLM_MODEL : "deaktiv"}`);
});
