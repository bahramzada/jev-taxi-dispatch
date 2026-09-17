/**
 * MapLibre xəritəsi: OpenFreeMap "dark" stili üzərində gecə şəhəri görünüşü
 * və Bakının 3D binaları.
 */

import * as maplibregl from "https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.mjs";

export const BAKU_CENTER = [49.8445, 40.3835];

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** Stilin öz qatlarını gecə/neon palitrasına uyğunlaşdırır */
const RECOLOR = {
  background: ["background-color", "#04060c"],
  water: ["fill-color", "#06141f"],
  landcover_wood: ["fill-color", "#08130f"],
  landuse_park: ["fill-color", "#08130f"],
  landuse_residential: ["fill-color", "#070a11"],
  highway_path: ["line-color", "#101722"],
  highway_minor: ["line-color", "#16202e"],
  highway_major_casing: ["line-color", "#0b1520"],
  highway_major_inner: ["line-color", "#20384d"],
  highway_major_subtle: ["line-color", "#1b2f41"],
  highway_motorway_casing: ["line-color", "#0d1a26"],
  highway_motorway_inner: ["line-color", "#2c5573"],
  highway_motorway_subtle: ["line-color", "#1d3245"],
  railway: ["line-color", "#161b24"],
  railway_minor: ["line-color", "#141922"],
  railway_transit: ["line-color", "#141922"],
};

export async function createMap(container) {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: BAKU_CENTER,
    zoom: 13.6,
    pitch: 55,
    bearing: -18,
    antialias: true,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  await new Promise((resolve) => map.once("load", resolve));

  applyNightTheme(map);
  add3dBuildings(map);

  return map;
}

function applyNightTheme(map) {
  for (const [layerId, [prop, value]] of Object.entries(RECOLOR)) {
    if (!map.getLayer(layerId)) continue;
    try {
      map.setPaintProperty(layerId, prop, value);
    } catch {
      // Stil dəyişsə belə xəritə işləməyə davam etsin
    }
  }

  // Düz bina fill-i 3D ekstruziya ilə əvəz olunur
  if (map.getLayer("building")) {
    map.setLayoutProperty("building", "visibility", "none");
  }

  // Əsas yollara neon parıltısı
  if (map.getLayer("highway_motorway_inner")) {
    map.addLayer(
      {
        id: "motorway-glow",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2f7fb8",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 14],
          "line-blur": 8,
          "line-opacity": 0.35,
        },
      },
      "highway_motorway_casing"
    );
  }

  // Ekstruziya işığını azaldırıq — əks halda tünd bina rəngləri ağarır
  if (typeof map.setLight === "function") {
    try {
      map.setLight({ anchor: "viewport", color: "#9fd4ff", intensity: 0.18 });
    } catch {
      // Dəstəklənmirsə standart işıq qalır
    }
  }

  if (typeof map.setSky === "function") {
    try {
      map.setSky({
        "sky-color": "#02040a",
        "horizon-color": "#071426",
        "fog-color": "#04070e",
        "fog-ground-blend": 0.82,
        "horizon-fog-blend": 0.85,
        "sky-horizon-blend": 0.9,
      });
    } catch {
      // Sky dəstəklənmirsə xəritə yenə işləyir
    }
  }
}

function add3dBuildings(map) {
  if (!map.getSource("openmaptiles")) return;

  map.addLayer({
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "openmaptiles",
    "source-layer": "building",
    minzoom: 13,
    paint: {
      // Hündürlüyə görə rəng: alçaq binalar tünd, hündürlər neon-mavi
      "fill-extrusion-color": [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "render_height"], 5],
        0, "#0a1420",
        30, "#0d2334",
        80, "#123449",
        200, "#17455f",
      ],
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13, 0,
        14.5, ["coalesce", ["get", "render_height"], 5],
      ],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.96,
      // Gradient söndürülüb: dam üzləri açıq boz görünürdü və gecə palitrasını pozurdu
      "fill-extrusion-vertical-gradient": false,
    },
  });
}

export { maplibregl };
