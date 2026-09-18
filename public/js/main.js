/**
 * Bütün modulları birləşdirir: xəritə, 3D flot, yol qrafı, simulyasiya və HUD.
 */

import { createMap } from "./map.js";
import { Fleet3DLayer } from "./fleet3d.js";
import { RoadGraph } from "./graph.js";
import { Simulation } from "./sim.js";
import { Dispatcher } from "./dispatch.js";
import { Hud } from "./hud.js";

const $ = (id) => document.getElementById(id);

const hud = new Hud();
const dispatcher = new Dispatcher();

let sim = null;
let completed = 0;
let manualTotal = 0;
let fraudTotal = 0;

async function boot() {
  try {
    hud.splashStatus("Server konfiqurasiyası oxunur…");
    const config = await fetch("/api/config").then((r) => r.json());
    hud.setCompareMode(false, config.llmModel);

    if (!config.llmEnabled) {
      $("compareToggle").disabled = true;
      $("compareToggle").closest(".switch").title =
        "OPENROUTER_API_KEY tapılmadı — müqayisə deaktivdir";
    }

    hud.splashStatus("Bakının yol şəbəkəsi yüklənir…");
    const graph = await RoadGraph.load();

    hud.splashStatus("Xəritə hazırlanır…");
    const map = await createMap("map");

    const fleet = new Fleet3DLayer(map);
    map.addLayer(fleet);

    sim = new Simulation({ graph, fleet, map, dispatcher });
    wireSimulation();

    hud.splashStatus(
      `Hazırdır — ${graph.nodes.length.toLocaleString("az")} yol node-u yükləndi`,
      "ready"
    );
    $("startBtn").disabled = false;

    // ?auto=1 — ekran yazısı və demo üçün özü başlasın, ?compare=1 müqayisəni açır
    const params = new URLSearchParams(location.search);
    if (params.get("compare") === "1" && config.llmEnabled) {
      $("compareToggle").checked = true;
      $("compareToggle").dispatchEvent(new Event("change"));
    }
    if (params.get("auto") === "1") {
      $("startBtn").click();
    }
  } catch (err) {
    console.error(err);
    hud.splashStatus(`Xəta: ${err.message}`, "error");
  }
}

function wireSimulation() {
  sim.on("order", () => {
    hud.setCounters({ active: sim.orders.size });
  });

  sim.on("decision", ({ order, outcome }) => {
    const chosen = outcome.results.jev?.decision?.surucu ?? outcome.results.llm?.decision?.surucu;
    const driver = sim.drivers.find((d) => d.id === chosen);
    hud.pushDecision({
      order: { ...order, driverName: driver ? `${driver.name} (${driver.id})` : chosen },
      outcome,
    });
    hud.setCounters({ active: sim.orders.size });
  });

  sim.on("manual", () => {
    manualTotal++;
    hud.setCounters({ manual: manualTotal });
  });

  sim.on("rejected", () => {
    fraudTotal++;
    hud.setCounters({ fraud: fraudTotal, active: sim.orders.size });
  });

  sim.on("completed", () => {
    completed++;
    hud.setCounters({ completed, active: sim.orders.size });
  });

  sim.on("error", ({ message }) => {
    hud.toast(`Dispetçer xətası: ${message}`);
  });

  dispatcher.onUpdate((snapshot) => hud.setStats(snapshot));
}

// ---------------------------------------------------------- idarəetmə

$("startBtn").addEventListener("click", () => {
  $("splash").classList.add("hidden");
  sim.start();
  hud.setLive(true);
});

$("pauseBtn").addEventListener("click", () => {
  if (!sim) return;
  if (sim.running) {
    sim.pause();
    hud.setLive(false);
  } else {
    sim.start();
    hud.setLive(true);
  }
});

$("compareToggle").addEventListener("change", (e) => {
  dispatcher.compareMode = e.target.checked;
  hud.setCompareMode(e.target.checked);
  hud.setStats(dispatcher.snapshot());
});

$("speedRange").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  $("speedValue").textContent = `${value}×`;
  if (sim) sim.timeScale = value;
});

for (const id of ["learnBtn", "splashLearnBtn"]) {
  $(id).addEventListener("click", () => $("drawer").classList.add("open"));
}
$("drawerClose").addEventListener("click", () => $("drawer").classList.remove("open"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("drawer").classList.remove("open");
  const simulationVisible = $("splash").classList.contains("hidden");
  if (e.key === " " && simulationVisible) {
    e.preventDefault();
    $("pauseBtn").click();
  }
});

boot();
