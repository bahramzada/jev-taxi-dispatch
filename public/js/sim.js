/**
 * Simulyasiya nüvəsi: sürücülərin yol şəbəkəsində hərəkəti, sifarişlərin
 * yaranması və dispetçer qərarının tətbiqi.
 */

import { bearing, haversine } from "./graph.js";
import { setActiveRoutes } from "./map.js";

// Saxta sifariş qapıları: bu həddən yuxarı bloklanır / insan yoxlamasına düşür
export const FRAUD_BLOCK = 0.7;
export const FRAUD_REVIEW = 0.4;

const DRIVER_NAMES = [
  ["Elvin", "Toyota Prius"],
  ["Rəşad", "Hyundai Elantra"],
  ["Kamran", "Mercedes E-Class"],
  ["Tural", "LADA Vesta"],
  ["Orxan", "Kia Optima"],
  ["Səbuhi", "Toyota Corolla"],
  ["Nicat", "Hyundai Sonata"],
  ["Fərid", "Chevrolet Cobalt"],
  ["Anar", "Mercedes Vito"],
  ["Ramil", "Toyota Camry"],
];

/** Sifariş ünvanını adlandırmaq üçün tanınmış nöqtələr */
const LANDMARKS = [
  ["İçərişəhər", 49.8345, 40.3663],
  ["Fəvvarələr meydanı", 49.8368, 40.3706],
  ["Dənizkənarı bulvar", 49.847, 40.369],
  ["28 May metrosu", 49.849, 40.379],
  ["Gənclik metrosu", 49.852, 40.4],
  ["Nərimanov metrosu", 49.867, 40.404],
  ["Heydər Əliyev Sarayı", 49.837, 40.38],
  ["Elmlər Akademiyası", 49.814, 40.3745],
  ["Nizami metrosu", 49.8115, 40.3795],
  ["Xətai metrosu", 49.876, 40.384],
  ["Port Baku", 49.853, 40.376],
  ["Alov Qüllələri", 49.829, 40.3595],
  ["Şəhidlər Xiyabanı", 49.831, 40.356],
  ["Dəniz vağzalı", 49.858, 40.373],
];

/** Sifariş şablonları — model üçün əsl qərar materialı */
const ORDER_TEMPLATES = [
  { mesaj: "Salam, 28 May metrosuna gedirəm. Tələsmirəm.", tag: "adi" },
  { mesaj: "İşə gedirəm, adi sifariş. Küçənin tinində gözləyirəm.", tag: "adi" },
  { mesaj: "Bulvara gedirəm, hava gözəldir, tələsmirəm.", tag: "adi" },
  { mesaj: "Uşağı məktəbdən götürməliyəm, yarım saatım var.", tag: "adi" },
  {
    mesaj: "Təcili hava limanına çatmalıyam, təyyarəm 2 saatdan sonradır!",
    tag: "tecili",
  },
  { mesaj: "Xəstəxanaya tez çatmalıyam, vəziyyət ciddidir.", tag: "tecili" },
  { mesaj: "Görüşə 15 dəqiqə gecikirəm, xahiş edirəm sürətli olsun.", tag: "tecili" },
  { mesaj: "Qatarım 40 dəqiqəyə yola düşür, gecikə bilmərəm.", tag: "tecili" },
  { mesaj: "Biznes görüşünə gedirəm, rahat və təmiz maşın olsun.", tag: "komfort" },
  { mesaj: "Qonaqlarımı qarşılayıram, yüksək sinif maşın istəyirəm.", tag: "komfort" },
  { mesaj: "3 böyük çamadan var, baqaj yeri lazımdır.", tag: "yuk" },
  { mesaj: "Mebel parçası daşımalıyam, yük üçün geniş maşın lazımdır.", tag: "yuk" },
  {
    mesaj: "Maşını göndər, ünvan yoxdur, özüm zəng edəcəm, ödəniş etməyəcəyəm.",
    tag: "saxta",
  },
  { mesaj: "test test test salam salam yoxlayıram", tag: "saxta" },
  {
    mesaj: "Sifarişi təsdiqlə, pulu sonra qaytaracağam, indi kartım yoxdur.",
    tag: "saxta",
  },
];

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function nearestLandmark(lng, lat) {
  let best = LANDMARKS[0];
  let bestDist = Infinity;
  for (const lm of LANDMARKS) {
    const d = haversine([lng, lat], [lm[1], lm[2]]);
    if (d < bestDist) {
      bestDist = d;
      best = lm;
    }
  }
  return { name: best[0], distance: bestDist };
}

export class Simulation {
  /**
   * @param {object} deps graph, fleet, map və dispatch asılılıqları
   */
  constructor({ graph, fleet, map, dispatcher, driverCount = 9 }) {
    this.graph = graph;
    this.fleet = fleet;
    this.map = map;
    this.dispatcher = dispatcher;

    this.timeScale = 7; // simulyasiya real vaxtdan sürətlidir
    this.orderIntervalMs = 4500;
    this.maxPendingOrders = 4;
    this.running = false;

    this.drivers = [];
    this.orders = new Map();
    this.orderCounter = 0;
    this.lastOrderAt = 0;
    this.lastFrame = 0;

    this.listeners = {};

    this.#createDrivers(driverCount);
  }

  on(event, handler) {
    (this.listeners[event] ??= []).push(handler);
  }

  #emit(event, payload) {
    for (const handler of this.listeners[event] ?? []) handler(payload);
  }

  #createDrivers(count) {
    for (let i = 0; i < count; i++) {
      const [name, car] = DRIVER_NAMES[i % DRIVER_NAMES.length];
      const node = this.graph.randomNode();
      const [lng, lat] = this.graph.nodes[node];

      const driver = {
        id: `S${i + 1}`,
        name,
        car,
        rating: Math.round((4.0 + Math.random()) * 10) / 10,
        state: "idle",
        node,
        lng,
        lat,
        bearing: Math.random() * 360,
        route: null,
        routeProgress: 0,
        segmentIndex: 0,
        segmentProgress: 0,
        orderId: null,
      };
      this.drivers.push(driver);
      this.fleet.updateTaxi(driver.id, lng, lat, driver.bearing, "idle");
      this.#assignRoam(driver);
    }
  }

  /** Boş sürücüyə təsadüfi gəzinti marşrutu verir */
  #assignRoam(driver) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const target = this.graph.randomNode();
      if (target === driver.node) continue;
      const path = this.graph.findPath(driver.node, target);
      if (path && path.length > 3) {
        this.#setRoute(driver, path);
        return;
      }
    }
    // Marşrut tapılmadısa sürücünü başqa yerə köçürürük ki, ilişib qalmasın
    driver.node = this.graph.randomNode();
    [driver.lng, driver.lat] = this.graph.nodes[driver.node];
  }

  #setRoute(driver, pathNodes) {
    driver.route = this.graph.buildRoute(pathNodes);
    driver.routeNodes = pathNodes;
    driver.segmentIndex = 0;
    driver.segmentProgress = 0;
    this.#refreshRouteLayer();
  }

  /** Yalnız sifariş üzərində işləyən sürücülərin marşrutu xəritədə göstərilir */
  #refreshRouteLayer() {
    const features = [];
    for (const driver of this.drivers) {
      if (driver.state === "idle" || !driver.route) continue;
      features.push({
        type: "Feature",
        properties: { state: driver.state, driver: driver.id },
        geometry: {
          type: "LineString",
          coordinates: driver.route.coords.slice(driver.segmentIndex),
        },
      });
    }
    setActiveRoutes(this.map, features);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.lastOrderAt = performance.now();
    requestAnimationFrame(this.#loop);
  }

  pause() {
    this.running = false;
  }

  #loop = (now) => {
    if (!this.running) return;
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1) * this.timeScale;
    this.lastFrame = now;

    this.#moveDrivers(dt);

    // Marşrut xətti sürücünün arxasınca qısalsın — hər kadrda deyil, saniyədə ~3 dəfə
    if (now - (this.lastRouteRefresh ?? 0) > 320) {
      this.lastRouteRefresh = now;
      this.#refreshRouteLayer();
    }

    if (
      now - this.lastOrderAt > this.orderIntervalMs &&
      this.#pendingCount() < this.maxPendingOrders
    ) {
      this.lastOrderAt = now;
      this.#spawnOrder();
    }

    requestAnimationFrame(this.#loop);
  };

  #pendingCount() {
    let n = 0;
    for (const o of this.orders.values()) if (o.status === "pending") n++;
    return n;
  }

  #moveDrivers(dt) {
    for (const driver of this.drivers) {
      if (!driver.route) {
        this.#assignRoam(driver);
        continue;
      }

      const { coords, segments } = driver.route;
      let remaining = dt;

      while (remaining > 0 && driver.segmentIndex < segments.length) {
        const seg = segments[driver.segmentIndex];
        const travel = seg.speed * remaining;
        const left = seg.length - driver.segmentProgress;

        if (travel < left) {
          driver.segmentProgress += travel;
          remaining = 0;
        } else {
          remaining -= left / seg.speed;
          driver.segmentIndex++;
          driver.segmentProgress = 0;
        }
      }

      if (driver.segmentIndex >= segments.length) {
        // Marşrut bitdi
        const lastNode = driver.routeNodes[driver.routeNodes.length - 1];
        driver.node = lastNode;
        [driver.lng, driver.lat] = this.graph.nodes[lastNode];
        driver.route = null;
        this.#onRouteComplete(driver);
      } else {
        const i = driver.segmentIndex;
        const from = coords[i];
        const to = coords[i + 1];
        const t = segments[i].length > 0 ? driver.segmentProgress / segments[i].length : 0;
        driver.lng = from[0] + (to[0] - from[0]) * t;
        driver.lat = from[1] + (to[1] - from[1]) * t;
        driver.bearing = bearing(from, to);
        driver.node = driver.routeNodes[i];
      }

      this.fleet.updateTaxi(driver.id, driver.lng, driver.lat, driver.bearing, driver.state);
    }
  }

  #onRouteComplete(driver) {
    if (driver.state === "pickup") {
      // Sərnişin götürüldü — təyinata doğru
      const order = this.orders.get(driver.orderId);
      driver.state = "busy";
      this.fleet.removeBeacon(driver.orderId);

      const dropoff = order?.dropoffNode ?? this.graph.randomNode();
      const path = this.graph.findPath(driver.node, dropoff);
      if (path) {
        this.#setRoute(driver, path);
      } else {
        this.#finishRide(driver);
      }
      this.#emit("pickup", { driver, order });
    } else if (driver.state === "busy") {
      this.#finishRide(driver);
    } else {
      this.#assignRoam(driver);
    }
  }

  #finishRide(driver) {
    const order = this.orders.get(driver.orderId);
    if (order) {
      order.status = "completed";
      this.orders.delete(order.id);
    }
    driver.state = "idle";
    driver.orderId = null;
    this.#emit("completed", { driver, order });
    this.#assignRoam(driver);
    this.#refreshRouteLayer();
  }

  #spawnOrder() {
    const node = this.graph.randomNode();
    const [lng, lat] = this.graph.nodes[node];
    const template = randomOf(ORDER_TEMPLATES);
    const isFraud = template.tag === "saxta";

    // Saxta sifarişlərdə hesab siqnalları da şübhəli olur
    const accountAge = isFraud
      ? Math.floor(Math.random() * 3)
      : 30 + Math.floor(Math.random() * 900);
    const rating = isFraud
      ? Math.round((2.0 + Math.random() * 1.5) * 10) / 10
      : Math.round((4.0 + Math.random()) * 10) / 10;
    const cancels = isFraud ? 2 + Math.floor(Math.random() * 4) : Math.random() < 0.15 ? 1 : 0;

    const landmark = nearestLandmark(lng, lat);
    const dropoffNode = this.graph.randomNode();

    const order = {
      id: `O${++this.orderCounter}`,
      node,
      lng,
      lat,
      dropoffNode,
      template: template.tag,
      status: "pending",
      createdAt: performance.now(),
      state: {
        unvan: `${landmark.name} yaxınlığı`,
        mesaj: template.mesaj,
        odenis: Math.random() < 0.6 ? "kart" : "nağd",
        musteri_reytinqi: rating,
        hesab_yasi_gun: accountAge,
        son_saatda_legv_sayi: cancels,
      },
    };

    this.orders.set(order.id, order);
    this.fleet.addBeacon(order.id, lng, lat, 0x22d3ee);
    this.#emit("order", order);

    this.#dispatch(order);
  }

  /** Sifariş üçün ən yaxın boş sürücüləri namizəd kimi hazırlayır */
  #candidates(order, limit = 4) {
    const idle = this.drivers.filter((d) => d.state === "idle");
    if (idle.length < 2) return null;

    const scored = idle
      .map((d) => ({ driver: d, straight: haversine([d.lng, d.lat], [order.lng, order.lat]) }))
      .sort((a, b) => a.straight - b.straight)
      .slice(0, limit);

    const candidates = [];
    for (const { driver } of scored) {
      const path = this.graph.findPath(driver.node, order.node);
      if (!path) continue;
      const route = this.graph.buildRoute(path);
      const avgSpeed =
        route.segments.reduce((sum, s) => sum + s.speed * s.length, 0) /
        Math.max(route.totalLength, 1);
      const etaMin = Math.max(1, Math.round(route.totalLength / avgSpeed / 60));

      candidates.push({
        id: driver.id,
        name: driver.name,
        car: driver.car,
        rating: driver.rating,
        distanceKm: route.totalLength / 1000,
        etaMin,
        _path: path,
      });
    }

    return candidates.length >= 2 ? candidates : null;
  }

  async #dispatch(order) {
    const candidates = this.#candidates(order);
    if (!candidates) {
      // Boş sürücü yoxdursa sifariş növbədə qalır və növbəti dövrədə yenidən yoxlanır
      setTimeout(() => {
        if (this.orders.get(order.id)?.status === "pending" && this.running) {
          this.#dispatch(order);
        }
      }, 1500);
      return;
    }

    const payload = candidates.map(({ _path, ...rest }) => rest);
    let outcome;
    try {
      outcome = await this.dispatcher.decide(order.state, payload);
    } catch (err) {
      this.#emit("error", { order, message: err.message });
      this.fleet.removeBeacon(order.id);
      this.orders.delete(order.id);
      return;
    }

    if (!this.orders.has(order.id)) return; // simulyasiya sıfırlanıb

    const primary = outcome.results.jev ?? outcome.results.llm;
    this.#emit("decision", { order, outcome, candidates: payload });

    if (!primary?.decision) {
      this.fleet.removeBeacon(order.id);
      this.orders.delete(order.id);
      return;
    }

    order.decision = primary.decision;

    // Saxta sifariş — bloklanır
    if (primary.decision.saxta >= FRAUD_BLOCK) {
      order.status = "rejected";
      this.fleet.setBeaconColor(order.id, 0xef4444);
      this.#emit("rejected", { order, decision: primary.decision });
      setTimeout(() => {
        this.fleet.removeBeacon(order.id);
        this.orders.delete(order.id);
      }, 2500);
      return;
    }

    // Şübhəli, amma qəti deyil — insan yoxlamasına düşür və ən yaxın sürücüyə verilir.
    // Qapı sürücü seçiminə yox, saxta ehtimalına qoyulur: sürücü seçimində iki yaxın
    // namizəd arasında aşağı confidence normaldır və insana ötürməyə dəyməz.
    const needsReview = primary.decision.saxta >= FRAUD_REVIEW;
    if (needsReview) {
      order.status = "manual";
      this.fleet.setBeaconColor(order.id, 0xf97316);
      this.#emit("manual", { order, decision: primary.decision });
    }

    const chosenId = needsReview ? candidates[0].id : primary.decision.surucu;
    const chosen = candidates.find((c) => c.id === chosenId) ?? candidates[0];
    const driver = this.drivers.find((d) => d.id === chosen.id);

    if (!driver || driver.state !== "idle") {
      // Sürücü artıq başqa sifariş götürübsə, sifarişi yenidən paylayırıq
      order.status = "pending";
      setTimeout(() => {
        if (this.orders.get(order.id)?.status === "pending") this.#dispatch(order);
      }, 800);
      return;
    }

    order.status = "assigned";
    order.assignedTo = driver.id;
    driver.state = "pickup";
    driver.orderId = order.id;
    this.#setRoute(driver, chosen._path ?? this.graph.findPath(driver.node, order.node));
    this.fleet.setBeaconColor(order.id, needsReview ? 0xf97316 : 0xfbbf24);

    this.#emit("assigned", { order, driver, decision: primary.decision });
  }

  reset() {
    for (const id of [...this.orders.keys()]) this.fleet.removeBeacon(id);
    this.orders.clear();
    this.orderCounter = 0;
    for (const driver of this.drivers) {
      driver.state = "idle";
      driver.orderId = null;
      driver.route = null;
      this.#assignRoam(driver);
    }
  }
}
