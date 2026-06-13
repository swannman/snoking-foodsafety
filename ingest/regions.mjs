// Point-in-polygon tract tagging. Loads the census tracts GeoJSON and returns a
// tagger that maps a (lon,lat) to its tract region_id (or null). Uses a per-feature
// bounding-box prefilter so tagging ~15k points against ~670 tracts is fast.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function rings(geom) {            // -> array of rings (each [ [lon,lat], ... ]) across Polygon/MultiPolygon
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function loadTagger(path) {
  const file = path || join(dirname(fileURLToPath(import.meta.url)), "..", "regions", "tracts.geojson");
  const g = JSON.parse(readFileSync(file, "utf8"));
  const feats = g.features.map((f) => {
    const rs = rings(f.geometry);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rs) for (const [x, y] of r) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { id: f.properties.region_id, rings: rs, bbox: [minX, minY, maxX, maxY] };
  });
  return function tag(lon, lat) {
    if (lon == null || lat == null) return null;
    for (const f of feats) {
      const b = f.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      // even-odd across all rings handles polygons-with-holes well enough for census tracts
      let inside = false;
      for (const r of f.rings) if (pointInRing(lon, lat, r)) inside = !inside;
      if (inside) return f.id;
    }
    return null;
  };
}
