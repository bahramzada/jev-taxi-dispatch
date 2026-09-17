/**
 * Mərkəzi Bakının sürülə bilən yol şəbəkəsini OpenStreetMap-dən (Overpass API)
 * bir dəfəlik çıxarıb `data/baku-roads.json` faylına yazır.
 *
 * İstifadə:  npm run fetch-roads
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, "..", "data", "baku-roads.json");

// Mərkəzi Bakı: Bayıldan Nərimanova, İçərişəhərdən Heydər Əliyev Mərkəzinə qədər
const BBOX = { south: 40.355, west: 49.802, north: 40.416, east: 49.886 };

const DRIVABLE =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|" +
  "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const QUERY = `
[out:json][timeout:240];
way["highway"~"^(${DRIVABLE})$"]
   ["access"!~"^(private|no)$"]
   (${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
out geom;
`;

// Qonşu koordinatları eyni node kimi tanımaq üçün yuvarlaqlaşdırma (~1 m)
const PRECISION = 5;
const key = (lon, lat) => `${lon.toFixed(PRECISION)},${lat.toFixed(PRECISION)}`;

function haversine(aLon, aLat, bLon, bLat) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchOverpass() {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      process.stdout.write(`Sorğu göndərilir: ${endpoint} ... `);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Overpass User-Agent olmayan sorğuları 406 ilə rədd edir
          "User-Agent": "jev-taxi-dispatch/1.0 (github.com/bahramzada/jev-taxi-dispatch)",
        },
        body: new URLSearchParams({ data: QUERY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`OK (${json.elements?.length ?? 0} yol)`);
      return json;
    } catch (err) {
      console.log(`uğursuz (${err.message})`);
      lastError = err;
    }
  }
  throw lastError ?? new Error("Overpass serverlərinin heç birinə qoşulmaq alınmadı.");
}

/** Sürət limitini yol tipindən təxmin edir (m/s) */
function speedFor(highway) {
  switch (highway) {
    case "motorway":
    case "motorway_link":
      return 22; // ~80 km/s
    case "trunk":
    case "trunk_link":
      return 19; // ~68 km/s
    case "primary":
    case "primary_link":
      return 15; // ~54 km/s
    case "secondary":
    case "secondary_link":
      return 13;
    case "tertiary":
    case "tertiary_link":
      return 11;
    case "living_street":
      return 6;
    default:
      return 9; // residential / unclassified
  }
}

function buildGraph(elements) {
  const nodeIndex = new Map(); // key -> index
  const nodes = []; // [lon, lat]
  const edges = []; // [from, to, distance(m), speed(m/s)]
  const seenEdge = new Set();

  const getNode = (lon, lat) => {
    const k = key(lon, lat);
    let idx = nodeIndex.get(k);
    if (idx === undefined) {
      idx = nodes.length;
      nodeIndex.set(k, idx);
      nodes.push([Number(lon.toFixed(PRECISION)), Number(lat.toFixed(PRECISION))]);
    }
    return idx;
  };

  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const tags = el.tags ?? {};
    const speed = speedFor(tags.highway);

    // OSM oneway qaydaları
    const onewayTag = tags.oneway;
    const forwardOnly =
      onewayTag === "yes" ||
      onewayTag === "1" ||
      onewayTag === "true" ||
      tags.junction === "roundabout" ||
      tags.highway === "motorway";
    const backwardOnly = onewayTag === "-1" || onewayTag === "reverse";

    const pts = el.geometry.filter((p) => p && Number.isFinite(p.lon) && Number.isFinite(p.lat));

    for (let i = 0; i < pts.length - 1; i++) {
      const a = getNode(pts[i].lon, pts[i].lat);
      const b = getNode(pts[i + 1].lon, pts[i + 1].lat);
      if (a === b) continue;

      const dist = haversine(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]);
      if (dist < 0.5) continue;

      const push = (from, to) => {
        const ek = `${from}>${to}`;
        if (seenEdge.has(ek)) return;
        seenEdge.add(ek);
        edges.push([from, to, Math.round(dist * 10) / 10, speed]);
      };

      if (!backwardOnly) push(a, b);
      if (!forwardOnly) push(b, a);
    }
  }

  return { nodes, edges };
}

/**
 * Ən böyük əlaqəli komponenti seçir — təcrid olunmuş yol parçaları simulyasiyada
 * marşrut tapılmamasına səbəb olur.
 */
function largestComponent({ nodes, edges }) {
  const undirected = new Map();
  const link = (a, b) => {
    if (!undirected.has(a)) undirected.set(a, []);
    undirected.get(a).push(b);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
  }

  const seen = new Uint8Array(nodes.length);
  let best = [];

  for (let start = 0; start < nodes.length; start++) {
    if (seen[start]) continue;
    const stack = [start];
    const component = [];
    seen[start] = 1;
    while (stack.length) {
      const cur = stack.pop();
      component.push(cur);
      for (const next of undirected.get(cur) ?? []) {
        if (!seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (component.length > best.length) best = component;
  }

  const keep = new Set(best);
  const remap = new Map();
  const newNodes = [];
  for (const old of best) {
    remap.set(old, newNodes.length);
    newNodes.push(nodes[old]);
  }

  const newEdges = [];
  for (const [a, b, d, s] of edges) {
    if (keep.has(a) && keep.has(b)) newEdges.push([remap.get(a), remap.get(b), d, s]);
  }

  return { nodes: newNodes, edges: newEdges };
}

async function main() {
  const raw = await fetchOverpass();
  const graph = buildGraph(raw.elements ?? []);
  console.log(`Xam qraf: ${graph.nodes.length} node, ${graph.edges.length} kənar`);

  const clean = largestComponent(graph);
  console.log(`Əlaqəli komponent: ${clean.nodes.length} node, ${clean.edges.length} kənar`);

  const output = {
    generatedAt: new Date().toISOString(),
    source: "OpenStreetMap contributors (ODbL) — Overpass API",
    bbox: BBOX,
    nodes: clean.nodes,
    edges: clean.edges,
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(output));

  const { size } = await fs.stat(OUTPUT);
  console.log(`Yazıldı: ${OUTPUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error("Xəta:", err.message);
  process.exit(1);
});
