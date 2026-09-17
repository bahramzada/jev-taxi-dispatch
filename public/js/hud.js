/**
 * HUD: statistika panelləri, qərar axını və vəziyyət sayğacları.
 */

import { FRAUD_BLOCK, FRAUD_REVIEW } from "./sim.js";

const $ = (id) => document.getElementById(id);

const SERVICE_LABEL = {
  standart: "standart",
  komfort: "komfort",
  yuk: "yük",
};

function fmtMs(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value)}`;
}

function fmtCost(usd) {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export class Hud {
  constructor() {
    this.decisionCount = 0;
    this.counters = { active: 0, manual: 0, fraud: 0, completed: 0 };
    this.maxStreamItems = 40;
  }

  splashStatus(text, kind = "") {
    const el = $("splashStatus");
    el.textContent = text;
    el.className = `splash-status ${kind}`;
  }

  setLive(running) {
    $("liveDot").classList.toggle("paused", !running);
    $("pauseBtn").textContent = running ? "Dayandır" : "Davam et";
  }

  setCompareMode(enabled, modelName) {
    $("llmCol").classList.toggle("inactive", !enabled);
    $("compareHint").textContent = enabled ? "hər iki model işləyir" : "yalnız JEV işləyir";
    if (modelName) {
      $("llmName").textContent = modelName.split("/").pop().replace(/-/g, " ");
    }
  }

  setCounters(patch) {
    Object.assign(this.counters, patch);
    $("activeOrders").textContent = this.counters.active;
    $("manualCount").textContent = this.counters.manual;
    $("fraudCount").textContent = this.counters.fraud;
    $("completedCount").textContent = this.counters.completed;
  }

  setStats(snapshot) {
    const { jev, llm, agreement, agreementTotal, compareMode } = snapshot;

    $("jevMedian").textContent = fmtMs(jev.median);
    $("jevP95").textContent = jev.p95 !== null ? `${fmtMs(jev.p95)}ms` : "—";
    $("jevCalls").textContent = jev.calls;
    $("jevIssues").textContent = jev.schemaIssues;
    $("jevCost").textContent = fmtCost(jev.costUsd);

    $("llmMedian").textContent = fmtMs(llm.median);
    $("llmP95").textContent = llm.p95 !== null ? `${fmtMs(llm.p95)}ms` : "—";
    $("llmCalls").textContent = llm.calls;
    $("llmIssues").textContent = llm.schemaIssues;
    $("llmCost").textContent = fmtCost(llm.costUsd);

    // Qalib sərhədi yalnız hər iki tərəfdə ölçmə olduqda görünür
    const bothMeasured = jev.median !== null && llm.median !== null;
    $("jevMedian").parentElement.classList.toggle(
      "winner",
      bothMeasured && jev.median < llm.median
    );
    $("llmCol").classList.toggle("winner", bothMeasured && llm.median < jev.median);

    this.#renderVerdict({ jev, llm, agreement, agreementTotal, compareMode, bothMeasured });
  }

  #renderVerdict({ jev, llm, agreement, agreementTotal, compareMode, bothMeasured }) {
    const el = $("verdict");

    if (!compareMode) {
      el.innerHTML =
        jev.calls > 0
          ? `JEV <b>${jev.calls}</b> qərar verdi, median <b>${fmtMs(jev.median)}ms</b>, sxem xətası <b>${jev.schemaIssues}</b>. Müqayisəni açın ki, LLM ilə eyni sifarişlərdə ölçülsün.`
          : "Müqayisəni açın ki, hər iki model eyni sifarişlərlə ölçülsün.";
      return;
    }

    if (!bothMeasured) {
      el.textContent = "Müqayisə üçün ilk sifarişlər gözlənilir…";
      return;
    }

    const speedup = llm.median / jev.median;
    const cheaper = jev.avgCost > 0 ? llm.avgCost / jev.avgCost : null;

    const parts = [
      `JEV <b>${speedup.toFixed(1)}×</b> sürətli`,
      cheaper ? `<b>${cheaper.toFixed(1)}×</b> ucuz` : null,
      agreement !== null
        ? `razılaşma <b>${Math.round(agreement * 100)}%</b> (${agreementTotal})`
        : null,
    ].filter(Boolean);

    let html = parts.join(" · ");
    if (llm.schemaIssues > 0) {
      html += ` · LLM-də <b>${llm.schemaIssues}</b> sxem pozuntusu`;
    }
    el.innerHTML = html;
  }

  pushDecision({ order, outcome }) {
    const stream = $("decisionStream");
    stream.querySelector(".stream-empty")?.remove();

    const jev = outcome.results.jev;
    const llm = outcome.results.llm;
    const primary = jev ?? llm;
    const decision = primary?.decision;
    if (!decision) return;

    this.decisionCount++;
    $("decisionCount").textContent = `${this.decisionCount} qərar`;

    const isFraud = decision.saxta >= FRAUD_BLOCK;
    const isManual = !isFraud && decision.saxta >= FRAUD_REVIEW;
    // Sürücü seçimində iki namizəd yaxın olanda confidence təbii olaraq aşağı düşür —
    // bu, bloklama səbəbi deyil, sadəcə məlumat nişanıdır
    const closeCall = decision.surucuConfidence < 0.4;

    const el = document.createElement("div");
    el.className = `decision${isFraud ? " is-fraud" : isManual ? " is-manual" : ""}`;

    const latencyClass = primary.latencyMs > 800 ? "slow" : "";
    const driverName = order.driverName ?? decision.surucu;

    const chips = [
      `<span class="chip ${closeCall ? "" : "chip-ok"}">əminlik ${Math.round(
        decision.surucuConfidence * 100
      )}%</span>`,
      `<span class="chip chip-cyan">təcililik ${Number(decision.tecililik).toFixed(1)}</span>`,
      `<span class="chip ${isFraud ? "chip-danger" : ""}">saxta ${Math.round(
        decision.saxta * 100
      )}%</span>`,
      `<span class="chip">${SERVICE_LABEL[decision.xidmetTipi] ?? decision.xidmetTipi}</span>`,
    ];

    if (isFraud) chips.push(`<span class="chip chip-danger">BLOKLANDI</span>`);
    else if (isManual) chips.push(`<span class="chip chip-warn">əl ilə yoxlama</span>`);
    if (!isFraud && closeCall) chips.push(`<span class="chip">yaxın nəticə</span>`);

    el.innerHTML = `
      <div class="decision-top">
        <span class="decision-id">${order.id} · ${order.state.unvan}</span>
        <span class="decision-lat ${latencyClass}">${primary.latencyMs}ms</span>
      </div>
      <div class="decision-main">${
        isFraud
          ? "Sifariş bloklandı"
          : `${driverName}<span class="arrow">←</span>${
              isManual ? "əl ilə təsdiq" : "təyin edildi"
            }`
      }</div>
      <div class="decision-msg">“${order.state.mesaj}”</div>
      <div class="decision-meta">${chips.join("")}</div>
      ${llm ? this.#versusBlock(jev, llm) : ""}
    `;

    stream.prepend(el);
    while (stream.children.length > this.maxStreamItems) {
      stream.lastElementChild.remove();
    }
  }

  #versusBlock(jev, llm) {
    if (!jev || !llm) return "";
    const max = Math.max(jev.latencyMs, llm.latencyMs, 1);
    const same = jev.decision?.surucu === llm.decision?.surucu;
    const llmBroken = !llm.ok;

    return `
      <div class="versus-mini">
        <div class="vs-row">
          <span class="vs-tag">JEV</span>
          <span class="vs-bar-track"><span class="vs-bar jev" style="width:${
            (jev.latencyMs / max) * 100
          }%"></span></span>
          <span class="vs-ms">${jev.latencyMs}ms</span>
        </div>
        <div class="vs-row">
          <span class="vs-tag">LLM</span>
          <span class="vs-bar-track"><span class="vs-bar llm" style="width:${
            (llm.latencyMs / max) * 100
          }%"></span></span>
          <span class="vs-ms">${llm.latencyMs}ms</span>
        </div>
        <div class="vs-same">${
          llmBroken
            ? `⚠ LLM sxem xətası: ${llm.schemaIssues[0] ?? "naməlum"}`
            : same
            ? "✓ eyni sürücünü seçdilər"
            : `✗ fərqli seçim — LLM: ${llm.decision?.surucu ?? "—"}`
        }</div>
      </div>
    `;
  }

  toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
  }

  clearStream() {
    const stream = $("decisionStream");
    stream.innerHTML = '<div class="stream-empty">Sifarişlər gözlənilir…</div>';
    this.decisionCount = 0;
    $("decisionCount").textContent = "0 qərar";
  }
}
