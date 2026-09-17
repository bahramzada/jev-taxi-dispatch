/**
 * Bakının yol qrafı: yükləmə, ən yaxın node axtarışı və A* marşrutlaşdırma.
 * Qraf `data/baku-roads.json` faylından gəlir (OSM / Overpass).
 */

const MAX_SPEED = 22; // m/s — A* evristikası üçün yuxarı hədd

/** Sadə ikili heap — A* üçün prioritet növbəsi */
class MinHeap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }
  get size() {
    return this.ids.length;
  }
  push(id, key) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.#swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const top = this.ids[0];
    const lastId = this.ids.pop();
    const lastKey = this.keys.pop();
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.keys.length && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.#swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }
  #swap(a, b) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

export class RoadGraph {
  constructor(raw) {
    this.nodes = raw.nodes; // [[lon, lat], ...]
    this.bbox = raw.bbox;

    // Qonşuluq siyahısı: hər node üçün [hədəf, məsafə(m), sürət(m/s)]
    this.adj = Array.from({ length: this.nodes.length }, () => []);
    for (const [a, b, dist, speed] of raw.edges) {
      this.adj[a].push([b, dist, speed]);
    }

    this.#buildSpatialIndex();

    // A* üçün təkrar istifadə olunan buferlər — hər çağırışda yenidən ayırmırıq
    this.gScore = new Float64Array(this.nodes.length);
    this.cameFrom = new Int32Array(this.nodes.length);
    this.visitGen = new Int32Array(this.nodes.length);
    this.generation = 0;
  }

  static async load(url = "/data/baku-roads.json") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yol şəbəkəsi yüklənmədi: HTTP ${res.status}`);
    return new RoadGraph(await res.json());
  }

  /** Ən yaxın node-u sürətlə tapmaq üçün bərabər ölçülü şəbəkə indeksi */
  #buildSpatialIndex() {
    const { south, west, north, east } = this.bbox;
    this.cellsX = 80;
    this.cellsY = 80;
    this.west = west;
    this.south = south;
    this.spanLon = east - west;
    this.spanLat = north - south;
    this.grid = Array.from({ length: this.cellsX * this.cellsY }, () => []);

    for (let i = 0; i < this.nodes.length; i++) {
      const [lon, lat] = this.nodes[i];
      const cell = this.#cellIndex(lon, lat);
      if (cell >= 0) this.grid[cell].push(i);
    }
  }

  #cellIndex(lon, lat) {
    const cx = Math.floor(((lon - this.west) / this.spanLon) * this.cellsX);
    const cy = Math.floor(((lat - this.south) / this.spanLat) * this.cellsY);
    if (cx < 0 || cy < 0 || cx >= this.cellsX || cy >= this.cellsY) return -1;
    return cy * this.cellsX + cx;
  }

  /** Verilmiş koordinata ən yaxın yol node-u */
  nearestNode(lon, lat) {
    const cx = Math.floor(((lon - this.west) / this.spanLon) * this.cellsX);
    const cy = Math.floor(((lat - this.south) / this.spanLat) * this.cellsY);

    let best = -1;
    let bestDist = Infinity;

    // Nəticə tapılana qədər axtarış halqasını genişləndiririk
    for (let ring = 0; ring < Math.max(this.cellsX, this.cellsY); ring++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          // Yalnız halqanın kənarına baxırıq — daxili hissə artıq yoxlanılıb
          if (ring > 0 && Math.abs(y - cy) !== ring && Math.abs(x - cx) !== ring) continue;
          if (x < 0 || y < 0 || x >= this.cellsX || y >= this.cellsY) continue;

          for (const idx of this.grid[y * this.cellsX + x]) {
            const [nLon, nLat] = this.nodes[idx];
            const d = (nLon - lon) ** 2 + (nLat - lat) ** 2;
            if (d < bestDist) {
              bestDist = d;
              best = idx;
            }
          }
        }
      }
      if (best >= 0 && ring >= 1) break;
    }
    return best;
  }

  randomNode() {
    return Math.floor(Math.random() * this.nodes.length);
  }

  /** İki node arasında düz xətt məsafəsi (metr) */
  straightDistance(a, b) {
    return haversine(this.nodes[a], this.nodes[b]);
  }

  /**
   * A* — ən sürətli marşrutu tapır (çəki: keçid vaxtı).
   * Nəticə: node indekslərindən ibarət massiv, və ya tapılmasa null.
   */
  findPath(start, goal) {
    if (start === goal) return [start];

    const gen = ++this.generation;
    const { gScore, cameFrom, visitGen, adj, nodes } = this;
    const open = new MinHeap();

    const heuristic = (n) => haversine(nodes[n], nodes[goal]) / MAX_SPEED;

    gScore[start] = 0;
    cameFrom[start] = -1;
    visitGen[start] = gen;
    open.push(start, heuristic(start));

    const closed = new Set();

    while (open.size > 0) {
      const current = open.pop();
      if (current === goal) {
        const path = [];
        for (let n = goal; n !== -1; n = cameFrom[n]) path.push(n);
        return path.reverse();
      }
      if (closed.has(current)) continue;
      closed.add(current);

      for (const [next, dist, speed] of adj[current]) {
        const tentative = gScore[current] + dist / speed;
        if (visitGen[next] !== gen || tentative < gScore[next]) {
          visitGen[next] = gen;
          gScore[next] = tentative;
          cameFrom[next] = current;
          open.push(next, tentative + heuristic(next));
        }
      }
    }
    return null;
  }

  /**
   * Node marşrutunu hərəkət üçün hazır formata çevirir:
   * koordinatlar + hər seqmentin uzunluğu və sürəti.
   */
  buildRoute(pathNodes) {
    const coords = pathNodes.map((n) => this.nodes[n]);
    const segments = [];
    let total = 0;

    for (let i = 0; i < pathNodes.length - 1; i++) {
      const from = pathNodes[i];
      const to = pathNodes[i + 1];
      const edge = this.adj[from].find(([target]) => target === to);
      const length = edge ? edge[1] : haversine(this.nodes[from], this.nodes[to]);
      const speed = edge ? edge[2] : 9;
      segments.push({ length, speed });
      total += length;
    }

    return { coords, segments, totalLength: total };
  }
}

export function haversine([aLon, aLat], [bLon, bLat]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** İki koordinat arasında istiqamət bucağı (dərəcə, 0 = şimal) */
export function bearing([aLon, aLat], [bLon, bLat]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(aLat);
  const φ2 = toRad(bLat);
  const Δλ = toRad(bLon - aLon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
