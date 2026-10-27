import * as THREE from 'three';
import { lonLatToWorld, WIENER_NULL } from './geo.js';

const WFS = 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&srsName=EPSG:4326&outputFormat=json';

export async function fetchWfs(typeName, props, bbox, signal) {
  const url = `${WFS}&typeName=${typeName}${props ? `&propertyName=${props}` : ''}&bbox=${bbox.join(',')},EPSG:4326`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`WFS ${typeName} ${r.status}`);
  return (await r.json()).features || [];
}

/**
 * Build one merged mesh for all building parts (Baukörper) of the Vienna building model
 * (FMZKBKMOGD) whose footprint centroid lies inside the chunk.
 * O_KOTE = roof height, T_KOTE = terrain height, U_KOTE = underside (overhangs/bridges); all relative to Wiener Null.
 */
export function buildBuildings(features, b, terrain, covered = () => false) {
  const pos = [];
  const prisms = [];
  const vert = (x, y, z) => pos.push(x, y, z);

  for (const f of features) {
    const p = f.properties;
    if (p.O_KOTE == null || !f.geometry) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];

    for (const poly of polys) {
      const rings = [];
      for (const r of poly) {
        const pts = r.map(([lon, lat]) => lonLatToWorld(lon, lat));
        const a = pts[0], z = pts[pts.length - 1];
        if (pts.length > 1 && a[0] === z[0] && a[1] === z[1]) pts.pop();
        if (pts.length >= 3) rings.push(pts);
      }
      if (!rings.length) continue;
      const outer = rings[0];

      let cx = 0, cz = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of outer) {
        cx += x; cz += z;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      cx /= outer.length; cz /= outer.length;
      if (cx < b.xMin || cx >= b.xMax || cz < b.zMin || cz >= b.zMax) continue; // owned by neighbour chunk
      // replaced by the LOD2 roof model? (test centroid + a vertex pulled towards it, for L-shapes)
      const [vx, vz] = outer[0];
      if (covered(cx, cz) || covered(vx + (cx - vx) * 0.2, vz + (cz - vz) * 0.2)) continue;

      const top = WIENER_NULL + p.O_KOTE;
      const floating = p.U_KOTE != null && p.T_KOTE != null && p.U_KOTE > p.T_KOTE + 0.5;
      let bottom;
      if (floating) bottom = WIENER_NULL + p.U_KOTE;
      else {
        let g = p.T_KOTE != null ? WIENER_NULL + p.T_KOTE : Infinity;
        for (const [x, z] of outer) {
          const h = terrain.heightAt(x, z);
          if (h !== null && h < g) g = h;
        }
        bottom = (g === Infinity ? top - 10 : g) - 0.5;
      }
      if (top - bottom < 0.3) continue;

      // roof (and underside for floating parts)
      const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
      const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
      const all = contour.concat(...holes);
      let faces;
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        faces = [];
      }
      for (const [i, j, k] of faces) {
        vert(all[i].x, top, all[i].y);
        vert(all[j].x, top, all[j].y);
        vert(all[k].x, top, all[k].y);
        if (floating) {
          vert(all[k].x, bottom, all[k].y);
          vert(all[j].x, bottom, all[j].y);
          vert(all[i].x, bottom, all[i].y);
        }
      }

      // walls
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const [ax, az] = r[i];
          const [bx, bz] = r[(i + 1) % r.length];
          vert(ax, bottom, az); vert(bx, bottom, bz); vert(bx, top, bz);
          vert(ax, bottom, az); vert(bx, top, bz); vert(ax, top, az);
        }
      }

      prisms.push({ rings: rings.map((r) => Float64Array.from(r.flat())), minX, maxX, minZ, maxZ, bottom, top });
    }
  }

  if (!pos.length) return { geometry: null, prisms, count: prisms.length };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return { geometry, prisms, count: prisms.length };
}

// ---- Trees from the Vienna tree cadastre (BAUMKATOGD) --------------------------------------
// BAUMHOEHE / KRONENDURCHMESSER are classes: 1 = 0-5 m, 2 = 6-10 m, ... / 1 = 0-3 m, 2 = 4-6 m, ...
const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0);
const crownGeo = new THREE.IcosahedronGeometry(0.5, 1);
const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5b4632 });
const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });

export function buildTrees(features, b, terrain) {
  const items = [];
  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [x, z] = lonLatToWorld(...f.geometry.coordinates);
    if (x < b.xMin || x >= b.xMax || z < b.zMin || z >= b.zMax) continue;
    const g = terrain.heightAt(x, z);
    if (g === null) continue;
    const hc = f.properties.BAUMHOEHE || 2;
    const cc = f.properties.KRONENDURCHMESSER || 2;
    const h = Math.max(2.5, hc * 5 - 2);
    const d = Math.min(Math.max(1.5, cc * 3 - 1), h * 0.9);
    items.push({ x, z, g, h, d, props: f.properties });
  }
  if (!items.length) return null;

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, items.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const c = new THREE.Color();
  items.forEach((it, i) => {
    const trunkH = it.h * 0.4;
    const crownH = it.h - trunkH * 0.8;
    m.compose(t.set(it.x, it.g, it.z), q, s.set(1 + it.d * 0.05, trunkH, 1 + it.d * 0.05));
    trunks.setMatrixAt(i, m);
    q.setFromAxisAngle(t.set(0, 1, 0), Math.random() * Math.PI);
    m.compose(t.set(it.x, it.g + trunkH * 0.8 + crownH / 2, it.z), q, s.set(it.d, crownH, it.d));
    crowns.setMatrixAt(i, m);
    q.identity();
    crowns.setColorAt(i, c.setHSL(0.22 + Math.random() * 0.08, 0.45, 0.22 + Math.random() * 0.1));
  });
  trunks.computeBoundingSphere();
  crowns.computeBoundingSphere();
  const group = new THREE.Group();
  trunks.userData = crowns.userData = { pick: 'tree', items };
  crowns.castShadow = crowns.receiveShadow = trunks.castShadow = true;
  group.add(trunks, crowns);
  group.userData.dispose = () => {
    trunks.dispose();
    crowns.dispose();
  };
  return group;
}
