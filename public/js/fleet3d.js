/**
 * MapLibre custom layer üzərində three.js səhnəsi:
 * 3D taksi modelləri və sifariş mayakları.
 *
 * Koordinat çevrilməsi: Mercator başlanğıc nöqtəsi Bakının mərkəzidir,
 * səhnədə mövqe metrlə ölçülür — (şərq, yuxarı, cənub).
 */

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js";
import { maplibregl, BAKU_CENTER } from "./map.js";

const CAR_LENGTH = 4.3; // metr
const TARGET_CAR_PIXELS = 16; // ekranda taksinin təxmini uzunluğu

export const STATE_COLORS = {
  idle: 0x22d3ee, // boş — mavi
  pickup: 0xfbbf24, // sifarişə gedir — sarı
  busy: 0xe879f9, // sərnişinlə — çəhrayı
};

function carMaterial(color, emissiveIntensity = 0.35) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity,
    metalness: 0.3,
    roughness: 0.55,
  });
}

/** Sadə, stilizə edilmiş low-poly taksi. Model şimala (−Z) baxır. */
function createTaxiMesh() {
  const group = new THREE.Group();

  const bodyMat = carMaterial(0xf4c430, 0.25);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.62, CAR_LENGTH), bodyMat);
  body.position.y = 0.62;
  group.add(body);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.58, 0.52, 1.95),
    new THREE.MeshStandardMaterial({
      color: 0x0f1c2b,
      emissive: 0x16283d,
      emissiveIntensity: 0.6,
      metalness: 0.1,
      roughness: 0.3,
    })
  );
  cabin.position.set(0, 1.16, -0.1);
  group.add(cabin);

  // Damdakı işıq — sürücünün vəziyyətini göstərir
  const signMat = new THREE.MeshStandardMaterial({
    color: STATE_COLORS.idle,
    emissive: STATE_COLORS.idle,
    emissiveIntensity: 2.2,
  });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.26, 0.34), signMat);
  sign.position.set(0, 1.55, -0.1);
  group.add(sign);
  group.userData.signMaterial = signMat;

  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.9 });
  for (const [x, z] of [
    [0.92, -1.35],
    [-0.92, -1.35],
    [0.92, 1.35],
    [-0.92, 1.35],
  ]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.34, z);
    group.add(wheel);
  }

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfffbe8,
    emissive: 0xfff3c4,
    emissiveIntensity: 3,
  });
  for (const x of [0.58, -0.58]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.1), headMat);
    light.position.set(x, 0.72, -CAR_LENGTH / 2);
    group.add(light);
  }

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff4d4d,
    emissive: 0xff2222,
    emissiveIntensity: 2,
  });
  for (const x of [0.62, -0.62]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.08), tailMat);
    light.position.set(x, 0.75, CAR_LENGTH / 2);
    group.add(light);
  }

  return group;
}

/** Sifariş nöqtəsini göstərən şüa + halqa */
function createBeaconMesh(color) {
  const group = new THREE.Group();

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 42, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  beam.position.y = 21;
  group.add(beam);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.6, 2.6, 28),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.4;
  group.add(ring);
  group.userData.ring = ring;

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 14, 10),
    new THREE.MeshBasicMaterial({ color })
  );
  core.position.y = 2.4;
  group.add(core);

  return group;
}

export class Fleet3DLayer {
  constructor(map) {
    this.id = "fleet-3d";
    this.type = "custom";
    this.renderingMode = "3d";
    this.map = map;

    this.origin = maplibregl.MercatorCoordinate.fromLngLat(BAKU_CENTER, 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();

    this.taxis = new Map(); // driverId -> THREE.Group
    this.beacons = new Map(); // orderId -> THREE.Group
    this.clock = 0;
  }

  /** lng/lat → səhnə koordinatı (metr) */
  toScene(lng, lat) {
    const mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
    return {
      x: (mc.x - this.origin.x) / this.scale,
      z: (mc.y - this.origin.y) / this.scale,
    };
  }

  onAdd(map, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();

    this.scene.add(new THREE.AmbientLight(0x6688bb, 1.6));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-120, 300, -180);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x3fa7ff, 0.9);
    fill.position.set(200, 160, 220);
    this.scene.add(fill);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  addTaxi(driverId) {
    const mesh = createTaxiMesh();
    mesh.visible = false;
    this.scene.add(mesh);
    this.taxis.set(driverId, mesh);
    return mesh;
  }

  updateTaxi(driverId, lng, lat, bearingDeg, state) {
    const mesh = this.taxis.get(driverId) ?? this.addTaxi(driverId);
    const { x, z } = this.toScene(lng, lat);
    mesh.position.set(x, 0, z);
    mesh.rotation.y = (-bearingDeg * Math.PI) / 180;
    mesh.visible = true;

    const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
    const signMat = mesh.userData.signMaterial;
    if (signMat && signMat.color.getHex() !== color) {
      signMat.color.setHex(color);
      signMat.emissive.setHex(color);
    }
  }

  addBeacon(orderId, lng, lat, color = 0x22d3ee) {
    this.removeBeacon(orderId);
    const mesh = createBeaconMesh(color);
    const { x, z } = this.toScene(lng, lat);
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    this.beacons.set(orderId, mesh);
  }

  setBeaconColor(orderId, color) {
    const mesh = this.beacons.get(orderId);
    if (!mesh) return;
    mesh.traverse((child) => {
      if (child.material?.color) child.material.color.setHex(color);
    });
  }

  removeBeacon(orderId) {
    const mesh = this.beacons.get(orderId);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.traverse((child) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
    this.beacons.delete(orderId);
  }

  removeTaxi(driverId) {
    const mesh = this.taxis.get(driverId);
    if (!mesh) return;
    this.scene.remove(mesh);
    this.taxis.delete(driverId);
  }

  /** Zoom-dan asılı ölçü — taksilər hər məsafədə görünən qalsın */
  #currentCarScale() {
    const zoom = this.map.getZoom();
    const lat = this.map.getCenter().lat;
    const metersPerPixel =
      (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const raw = (TARGET_CAR_PIXELS * metersPerPixel) / CAR_LENGTH;
    return Math.min(Math.max(raw, 1), 30);
  }

  render(gl, args) {
    this.clock += 0.016;

    const carScale = this.#currentCarScale();
    for (const mesh of this.taxis.values()) {
      mesh.scale.setScalar(carScale);
    }

    // Mayaklar nəbz kimi yanıb-sönür
    const pulse = 1 + Math.sin(this.clock * 3.2) * 0.22;
    const beaconScale = Math.max(carScale * 0.5, 1);
    for (const mesh of this.beacons.values()) {
      mesh.scale.set(beaconScale, beaconScale, beaconScale);
      const ring = mesh.userData.ring;
      if (ring) ring.scale.setScalar(pulse);
    }

    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
    const l = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2));

    this.camera.projectionMatrix = m.multiply(l);

    this.renderer.resetState();
    // Xəritə həndəsəsi taksiləri örtməsin — dərinlik buferini təmizləyirik.
    // Modelin öz hissələri arasında dərinlik yoxlaması isə işləməyə davam edir.
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }
}
