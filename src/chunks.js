import * as THREE from 'three';
import { tileBounds, tileLonLatBBox, worldToTile } from './geo.js';
import { fetchWfs, buildBuildings, buildTrees } from './buildings.js';
import { structuresReady, buildStructures, tunnelPolygons, sideMaterial } from './structures.js';
import polygonClipping from 'polygon-clipping';
import { lod2Buildings, buildLod2 } from './lod2.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// BVH-accelerated raycasting for picking on the big merged meshes
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
function pickable(mesh, kind) {
  mesh.geometry.computeBoundsTree();
  mesh.userData.pick = kind;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// Walls: Viennese plaster tones per facade plane plus a procedural window grid that fades out with distance.
const facadeMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
facadeMaterial.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNrm = mat3(modelMatrix) * normal;');
  s.fragmentShader = s.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying vec3 vWPos;
varying vec3 vWNrm;
float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
vec2 nh = normalize(vWNrm.xz + 1e-5);
float along = dot(vWPos.xz, vec2(-nh.y, nh.x));
float plane = dot(vWPos.xz, nh);
float h = fhash(vec2(floor(plane * 0.5), floor(along / 60.0)));
vec3 plaster = h < 0.3 ? vec3(0.86, 0.82, 0.74) : h < 0.5 ? vec3(0.90, 0.80, 0.58) : h < 0.65 ? vec3(0.80, 0.80, 0.78)
  : h < 0.8 ? vec3(0.88, 0.76, 0.70) : vec3(0.93, 0.91, 0.87);
plaster *= 0.82;
vec2 cell = vec2(along / 3.4, vWPos.y / 3.6);
vec2 f = fract(cell);
float win = step(0.32, f.x) * step(f.x, 0.68) * step(0.28, f.y) * step(f.y, 0.78);
float fade = smoothstep(0.12, 0.45, max(fwidth(cell.x), fwidth(cell.y)));
diffuseColor.rgb = mix(mix(plaster, vec3(0.22, 0.24, 0.27), win * 0.7), plaster * 0.88, fade);`
    );
};

// A chunk is one z16 web-mercator tile (~407 m wide in Vienna).
export const CZ = 16;
export const RANGE_DEFAULT = 3; // chunks with buildings, trees and bridges around the player (setting)
const TERRAIN_EXTRA = 3; // ground reaches this many chunks further
export const CHUNK_M = 407;
const GROUND_SEG = 48;

// basemap.at orthophoto (free, no key)
const ORTHO = (z, x, y) => `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${z}/${y}/${x}.jpeg`;
const orthoZoomFor = (d) => (d <= 1 ? 19 : d <= 2 ? 18 : d <= 4 ? 17 : 16);

class Scheduler {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.tasks = [];
  }
  get pending() {
    return this.tasks.length + this.active;
  }
  add(chunk, run) {
    this.tasks.push({ chunk, run });
    this.pump();
  }
  pump() {
    while (this.active < this.limit) {
      this.tasks = this.tasks.filter((t) => !t.chunk.disposed);
      if (!this.tasks.length) return;
      let bi = 0;
      for (let i = 1; i < this.tasks.length; i++) if (this.tasks[i].chunk.dist < this.tasks[bi].chunk.dist) bi = i;
      const t = this.tasks.splice(bi, 1)[0];
      this.active++;
      t.run()
        .catch((e) => {
          if (e.name !== 'AbortError') console.warn(e);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

async function loadImage(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return createImageBitmap(await r.blob());
}

/**
 * Remove tunnel footprints from the ground grid so tunnels can be entered.
 * Triangles touching a tunnel are clipped exactly; height and uv come from the original triangle's plane.
 */
function cutTunnels(pos, uv, idx, b) {
  const tunnels = tunnelPolygons(b);
  if (!tunnels.length) return { pos, uv, idx };
  const P = Array.from(pos), UV = Array.from(uv), out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    const v = tri.map((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
    const minX = Math.min(v[0][0], v[1][0], v[2][0]), maxX = Math.max(v[0][0], v[1][0], v[2][0]);
    const minZ = Math.min(v[0][2], v[1][2], v[2][2]), maxZ = Math.max(v[0][2], v[1][2], v[2][2]);
    const hits = tunnels.filter(({ s }) => s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ);
    let res = null;
    if (hits.length) {
      try {
        res = polygonClipping.difference([[...v.map((p) => [p[0], p[2]]), [v[0][0], v[0][2]]]], ...hits.map((h) => h.poly));
      } catch (e) {
        console.warn('tunnel cut failed', e);
      }
    }
    if (!res) {
      out.push(...tri);
      continue;
    }
    // barycentric interpolation on the original triangle
    const [A, B, C] = v;
    const det = (B[2] - C[2]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[2] - C[2]);
    for (const poly of res) {
      const rings = poly.map((r) => r.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z)));
      const base = P.length / 3;
      for (const p of rings.flat()) {
        const l1 = ((B[2] - C[2]) * (p.x - C[0]) + (C[0] - B[0]) * (p.y - C[2])) / det;
        const l2 = ((C[2] - A[2]) * (p.x - C[0]) + (A[0] - C[0]) * (p.y - C[2])) / det;
        const l3 = 1 - l1 - l2;
        P.push(p.x, l1 * A[1] + l2 * B[1] + l3 * C[1], p.y);
        for (let c = 0; c < 2; c++) UV.push(l1 * UV[tri[0] * 2 + c] + l2 * UV[tri[1] * 2 + c] + l3 * UV[tri[2] * 2 + c]);
      }
      for (const f of THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1))) out.push(base + f[0], base + f[1], base + f[2]);
    }
  }
  return { pos: P, uv: UV, idx: out };
}

/** Keep the part of a convex polygon (list of [x, y, z]) with s * (p[axis] - v) >= 0. */
function clipPoly(poly, axis, v, s) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    const da = s * (a[axis] - v), dc = s * (c[axis] - v);
    if (da >= 0) out.push(a);
    if (da < 0 !== dc < 0) {
      const f = da / (da - dc);
      out.push([a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f]);
    }
  }
  return out;
}

/**
 * Buildings are owned by the chunk holding their centroid but may reach into neighbouring tiles, where this
 * chunk's ortho texture would only repeat its clamped edge pixels. Clip a triangle soup at the tile edges and
 * give every piece the uv of the tile it lies in, one geometry group per tile; `cells` are the tile offsets.
 */
function splitByTile(src, b) {
  const p = src.attributes.position.array;
  const cells = new Map(); // "dx,dy" -> positions
  const out = (dx, dy) => {
    const k = `${dx},${dy}`;
    let a = cells.get(k);
    if (!a) cells.set(k, (a = []));
    return a;
  };
  const cx = (x) => Math.floor((x - b.xMin) / b.size), cz = (z) => Math.floor((z - b.zMin) / b.size);
  const walls = [];
  for (let t = 0; t < p.length; t += 9) {
    // steep faces get the facade material: a top-down photo would only smear into vertical streaks there
    const ax = p[t + 3] - p[t], ay = p[t + 4] - p[t + 1], az = p[t + 5] - p[t + 2];
    const bx = p[t + 6] - p[t], by = p[t + 7] - p[t + 1], bz = p[t + 8] - p[t + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (Math.abs(ny) < 0.3 * Math.hypot(nx, ny, nz)) {
      for (let i = 0; i < 9; i++) walls.push(p[t + i]);
      continue;
    }
    const x0 = cx(Math.min(p[t], p[t + 3], p[t + 6])), x1 = cx(Math.max(p[t], p[t + 3], p[t + 6]));
    const z0 = cz(Math.min(p[t + 2], p[t + 5], p[t + 8])), z1 = cz(Math.max(p[t + 2], p[t + 5], p[t + 8]));
    if (x0 === x1 && z0 === z1) {
      for (let i = 0; i < 9; i++) out(x0, z0).push(p[t + i]);
      continue;
    }
    const tri = [[p[t], p[t + 1], p[t + 2]], [p[t + 3], p[t + 4], p[t + 5]], [p[t + 6], p[t + 7], p[t + 8]]];
    for (let dy = z0; dy <= z1; dy++)
      for (let dx = x0; dx <= x1; dx++) {
        const xa = b.xMin + dx * b.size, za = b.zMin + dy * b.size;
        let poly = clipPoly(tri, 0, xa, 1);
        poly = clipPoly(poly, 0, xa + b.size, -1);
        poly = clipPoly(poly, 2, za, 1);
        poly = clipPoly(poly, 2, za + b.size, -1);
        for (let i = 1; i + 1 < poly.length; i++) out(dx, dy).push(...poly[0], ...poly[i], ...poly[i + 1]);
      }
  }
  if (walls.length) cells.set('wall', walls);
  let n = 0;
  for (const a of cells.values()) n += a.length / 3;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), list = [];
  const g = new THREE.BufferGeometry();
  let v = 0;
  for (const [k, a] of cells) {
    g.addGroup(v, a.length / 3, list.length);
    pos.set(a, v * 3);
    if (k === 'wall') {
      v += a.length / 3; // facade shader works in world space, uv stays 0
      list.push(null);
      continue;
    }
    const [dx, dy] = k.split(',').map(Number);
    const xa = b.xMin + dx * b.size, za = b.zMin + dy * b.size;
    for (let i = 0; i < a.length; i += 3, v++) (uv[v * 2] = (a[i] - xa) / b.size), (uv[v * 2 + 1] = 1 - (a[i + 2] - za) / b.size);
    list.push([dx, dy]);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals(); // non-indexed => flat normals
  return { geometry: g, cells: list };
}

class Chunk {
  constructor(mgr, x, y) {
    this.mgr = mgr;
    this.x = x;
    this.y = y;
    this.b = tileBounds(CZ, x, y);
    this.dist = 0;
    this.disposed = false;
    this.abort = new AbortController();
    this.group = new THREE.Group();
    this.material = new THREE.MeshLambertMaterial({ color: 0x8a8f86, side: THREE.DoubleSide });
    this.textures = new Map(); // zoom -> texture
    this.texLoading = new Set();
    this.prisms = [];
    this.groundReq = false;
    this.buildReq = false;
    this.bgroup = null; // buildings, roofs, bridges, trees: unloaded again when they fall out of range
    this.babort = null;
    this.rev = 0; // bumped (globally unique) whenever pickable geometry is added
    mgr.scene.add(this.group);
  }

  touch() {
    this.rev = ++this.mgr.rev;
  }

  /** Pickable meshes (ground, buildings, structures, trees), cached per revision. */
  pickables() {
    if (this.pickRev !== this.rev) {
      this.pickRev = this.rev;
      this.pick = [];
      this.group.traverse((o) => o.userData.pick && this.pick.push(o));
    }
    return this.pick;
  }

  sync() {
    const m = this.mgr;
    if (!this.groundReq) {
      this.groundReq = true;
      m.sGround.add(this, () => this.loadGround());
    }
    const want = orthoZoomFor(this.dist);
    for (const z of [CZ, want]) {
      if (!this.textures.has(z) && !this.texLoading.has(z)) {
        this.texLoading.add(z);
        m.sTex.add(this, () => this.loadTexture(z));
      }
    }
    // drop textures that are clearly too detailed now (with hysteresis)
    const keep = orthoZoomFor(Math.max(0, this.dist - 1));
    for (const [z, t] of this.textures)
      if (z > keep) {
        t.dispose();
        this.textures.delete(z);
        this.applyTexture();
      }
    if (this.dist <= m.range && !this.buildReq) {
      this.buildReq = true;
      this.babort = new AbortController();
      m.sNet.add(this, () => this.loadBuildings(this.babort.signal));
    } else if (this.dist > m.range + 1 && this.buildReq) this.unloadBuildings();
  }

  async loadGround() {
    await Promise.all([this.mgr.terrain.ensure(this.b), structuresReady]);
    if (this.disposed) return;
    const { xMin, zMin, size } = this.b;
    const n = GROUND_SEG + 1;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = xMin + (i / GROUND_SEG) * size, z = zMin + (j / GROUND_SEG) * size;
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.mgr.terrain.heightAt(x, z) ?? 170;
        pos[k * 3 + 2] = z;
        uv[k * 2] = i / GROUND_SEG;
        uv[k * 2 + 1] = 1 - j / GROUND_SEG;
      }
    const idx = [];
    for (let j = 0; j < GROUND_SEG; j++)
      for (let i = 0; i < GROUND_SEG; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    const cut = cutTunnels(pos, uv, idx, this.b);
    g.setAttribute('position', new THREE.Float32BufferAttribute(cut.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(cut.uv, 2));
    g.setIndex(cut.idx);
    g.computeVertexNormals();
    this.ground = new THREE.Mesh(g, this.material);
    this.ground.userData.pick = 'ground';
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
    this.touch();
  }

  async loadTexture(z) {
    try {
      const f = 2 ** (z - CZ);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256 * f;
      const ctx = canvas.getContext('2d');
      const jobs = [];
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++)
          jobs.push(
            loadImage(ORTHO(z, this.x * f + i, this.y * f + j), this.abort.signal)
              .then((img) => ctx.drawImage(img, i * 256, j * 256))
              .catch((e) => {
                if (e.name === 'AbortError') throw e;
              })
          );
      await Promise.all(jobs);
      if (this.disposed) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.mgr.maxAniso;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      this.textures.set(z, tex);
      this.applyTexture();
    } finally {
      this.texLoading.delete(z);
    }
  }

  applyTexture() {
    let best = null, bz = -1;
    for (const [z, t] of this.textures) if (z > bz) (bz = z), (best = t);
    if (this.material.map === best) return;
    this.material.map = best;
    this.material.color.set(best ? 0xffffff : 0x8a8f86);
    this.material.needsUpdate = true;
  }

  /**
   * Mesh textured with the ortho of whichever tile each part lies in. Neighbour chunks outlive our buildings
   * (ground reaches TERRAIN_EXTRA further), so borrowing their materials is safe.
   */
  orthoMesh(geometry) {
    const { geometry: g, cells } = splitByTile(geometry, this.b);
    geometry.dispose();
    const mats = cells.map((c) => (c ? this.mgr.chunks.get(`${this.x + c[0]},${this.y + c[1]}`)?.material ?? this.material : facadeMaterial));
    return new THREE.Mesh(g, mats);
  }

  async loadBuildings(signal) {
    const bbox = tileLonLatBBox(CZ, this.x, this.y);
    const [bk, trees, l2] = await Promise.all([
      fetchWfs('ogdwien:FMZKBKMOGD', 'O_KOTE,U_KOTE,T_KOTE,SHAPE', bbox, signal),
      fetchWfs('ogdwien:BAUMKATOGD', null, bbox, signal).catch(() => []),
      lod2Buildings(bbox, signal).catch(() => []),
      this.mgr.terrain.ensure(this.b),
    ]);
    await structuresReady;
    if (signal.aborted) return;
    const g = new THREE.Group();
    const lod2 = buildLod2(l2, this.b);
    if (lod2.geometry) g.add(pickable(this.orthoMesh(lod2.geometry), 'building'));
    const { geometry, prisms, count } = buildBuildings(bk, this.b, this.mgr.terrain, lod2.covered);
    this.count = count + lod2.count;
    prisms.push(...lod2.prisms);
    const st = buildStructures(this.b, this.mgr.terrain);
    if (st.top) g.add(pickable(this.orthoMesh(st.top), 'structure'));
    if (st.side) g.add(pickable(new THREE.Mesh(st.side, sideMaterial), 'structure'));
    prisms.push(...st.prisms);
    if (geometry) g.add(pickable(this.orthoMesh(geometry), 'building'));
    this.prisms = prisms;
    this.mgr.collision.add(prisms);
    const t = buildTrees(trees, this.b, this.mgr.terrain);
    if (t) g.add(t);
    this.bgroup = g;
    this.group.add(g);
    this.mgr.stats.buildings += this.count;
    this.touch();
  }

  unloadBuildings() {
    this.buildReq = false;
    this.babort?.abort();
    if (this.bgroup) {
      this.group.remove(this.bgroup);
      // trees: instanced meshes over shared geometry, released by their own dispose
      this.bgroup.traverse((o) => (o.userData.dispose ? o.userData.dispose() : o.isMesh && !o.isInstancedMesh && o.geometry.dispose()));
      this.bgroup = null;
      this.touch();
    }
    this.mgr.collision.remove(this.prisms);
    this.prisms = [];
    this.mgr.stats.buildings -= this.count || 0;
    this.count = 0;
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.unloadBuildings();
    this.mgr.scene.remove(this.group);
    this.ground?.geometry.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.material.dispose();
  }
}

export class ChunkManager {
  constructor({ scene, terrain, collision, renderer }) {
    this.scene = scene;
    this.terrain = terrain;
    this.collision = collision;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.chunks = new Map();
    this.sGround = new Scheduler(4);
    this.sTex = new Scheduler(6);
    this.sNet = new Scheduler(3);
    this.stats = { buildings: 0 };
    this.rev = 0;
    this.center = null;
    this.setRange(RANGE_DEFAULT);
  }

  /** Building radius in chunks; the ground reaches TERRAIN_EXTRA further. Applied on the next update. */
  setRange(r) {
    this.range = r;
    this.terrainRange = r + TERRAIN_EXTRA;
    const R = this.terrainRange;
    // offsets sorted by distance so near chunks get created first
    this.offsets = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) this.offsets.push([dx, dy]);
    this.offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    this.center = null;
  }

  get pending() {
    return this.sGround.pending + this.sTex.pending + this.sNet.pending;
  }

  /** Loaded chunks whose tile overlaps the square (x, z) ± pad. */
  around(x, z, pad) {
    const [x0, y0] = worldToTile(CZ, x - pad, z - pad), [x1, y1] = worldToTile(CZ, x + pad, z + pad);
    const out = [];
    for (let ty = Math.floor(Math.min(y0, y1)); ty <= Math.floor(Math.max(y0, y1)); ty++)
      for (let tx = Math.floor(Math.min(x0, x1)); tx <= Math.floor(Math.max(x0, x1)); tx++) {
        const c = this.chunks.get(`${tx},${ty}`);
        if (c?.rev) out.push(c);
      }
    return out;
  }

  update(pos) {
    const [fx, fy] = worldToTile(CZ, pos.x, pos.z);
    const cx = Math.floor(fx), cy = Math.floor(fy);
    const key = `${cx},${cy}`;
    if (this.center === key) return;
    this.center = key;

    for (const [dx, dy] of this.offsets) {
      const x = cx + dx, y = cy + dy, k = `${x},${y}`;
      let c = this.chunks.get(k);
      if (!c) this.chunks.set(k, (c = new Chunk(this, x, y)));
    }
    for (const [k, c] of this.chunks) {
      c.dist = Math.max(Math.abs(c.x - cx), Math.abs(c.y - cy));
      if (c.dist > this.terrainRange + 1) {
        c.dispose();
        this.chunks.delete(k);
      } else c.sync();
    }
  }
}
