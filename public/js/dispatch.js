/**
 * Backend ilə əlaqə və müqayisə statistikası.
 * JEV həmişə əsas qərar verəndir; müqayisə rejimində eyni sorğu paralel
 * olaraq ənənəvi LLM-ə də göndərilir.
 */

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

// Canlı panel üçün median son N sorğu üzrə hesablanır — ilk (soyuq) çağırış
// bütün sessiyanın rəqəmini uzun müddət təhrif etməsin
const ROLLING_WINDOW = 25;

class EngineStats {
  constructor() {
    this.latencies = [];
    this.calls = 0;
    this.failures = 0;
    this.schemaIssues = 0;
    this.costUsd = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  record(result) {
    this.calls++;
    if (typeof result.latencyMs === "number") this.latencies.push(result.latencyMs);
    if (!result.ok) this.failures++;
    this.schemaIssues += result.schemaIssues?.length ?? 0;
    this.costUsd += result.usage?.costUsd ?? 0;
    this.inputTokens += result.usage?.inputTokens ?? 0;
    this.outputTokens += result.usage?.outputTokens ?? 0;
  }

  get recent() {
    return this.latencies.slice(-ROLLING_WINDOW);
  }
  get median() {
    return percentile(this.recent, 50);
  }
  get p95() {
    return percentile(this.recent, 95);
  }
  get avgCost() {
    return this.calls > 0 ? this.costUsd / this.calls : 0;
  }
}

export class Dispatcher {
  constructor() {
    this.compareMode = false;
    this.stats = { jev: new EngineStats(), llm: new EngineStats() };
    this.agreements = { total: 0, same: 0 };
    this.listeners = [];
    // Sorğular növbə ilə gedir: eyni anda 8 sorğu (4 sifariş × 2 model) uçuşda
    // olanda ölçülən gecikmə şəbəkə növbəsindən şişir və müqayisəni təhrif edir
    this.queue = Promise.resolve();
  }

  onUpdate(handler) {
    this.listeners.push(handler);
  }

  #notify() {
    for (const handler of this.listeners) handler(this.snapshot());
  }

  decide(orderState, drivers) {
    const run = () => this.#request(orderState, drivers);
    // Növbənin bir həlqəsi uğursuz olsa belə, zəncir qırılmamalıdır
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async #request(orderState, drivers) {
    const engines = this.compareMode ? ["jev", "llm"] : ["jev"];

    const res = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: orderState, drivers, engines }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server xətası (${res.status})`);
    }

    const data = await res.json();

    for (const [engine, result] of Object.entries(data.results)) {
      this.stats[engine]?.record(result);
    }

    // Razılaşma: hər iki model eyni sürücünü seçdimi?
    const jevChoice = data.results.jev?.decision?.surucu;
    const llmChoice = data.results.llm?.decision?.surucu;
    if (jevChoice && llmChoice) {
      this.agreements.total++;
      if (jevChoice === llmChoice) this.agreements.same++;
    }

    this.#notify();
    return data;
  }

  snapshot() {
    const { jev, llm } = this.stats;
    return {
      jev: {
        calls: jev.calls,
        median: jev.median,
        p95: jev.p95,
        costUsd: jev.costUsd,
        avgCost: jev.avgCost,
        schemaIssues: jev.schemaIssues,
        failures: jev.failures,
      },
      llm: {
        calls: llm.calls,
        median: llm.median,
        p95: llm.p95,
        costUsd: llm.costUsd,
        avgCost: llm.avgCost,
        schemaIssues: llm.schemaIssues,
        failures: llm.failures,
      },
      agreement:
        this.agreements.total > 0
          ? this.agreements.same / this.agreements.total
          : null,
      agreementTotal: this.agreements.total,
      compareMode: this.compareMode,
    };
  }

  reset() {
    this.stats = { jev: new EngineStats(), llm: new EngineStats() };
    this.agreements = { total: 0, same: 0 };
    this.#notify();
  }
}
