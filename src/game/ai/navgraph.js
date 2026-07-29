/**
 * Navigation graph, A* solver and local steering for the enemy AI (GAME_SPEC §4.3:
 * "waypoint graph per zone with A* over the graph, plus local steering and obstacle
 * avoidance; enemies strafe between cover nodes and never bunch closer than 1.6 m").
 *
 * Pure module: no three, no DOM, no Math.random. Everything here is unit-testable in
 * Node and safe to call every simulation tick.
 *
 * Allocation policy (AGENTS.md §5, "zero per-frame allocation in hot paths"):
 *   - `build()` freezes the mutable authoring graph into flat typed arrays (CSR
 *     adjacency + parallel search scratch).
 *   - A* never allocates: the open set is an indexed binary heap over typed arrays and
 *     per-node search state is invalidated by a generation stamp rather than by
 *     refilling `gScore`/`cameFrom` each search.
 *   - Every function that produces a vector or a list writes into a caller-owned `out`.
 *
 * Coordinate convention: node and agent positions are FOOT level (matching
 * `PlayerController.pos`). Sight probes add their own height offsets, which also keeps
 * rays off the exact plane of a floor collider where the slab test degenerates.
 */

import { clamp, EPS, v3, v3set } from '../../core/mathx.js';

/** Shared tuning. Values that come from the spec are marked. */
export const NAV = {
  losHeight: 1.0,          // edge / nearest-node visibility probe height
  coverProbeHeight: 1.2,   // chest height used to test whether cover is exposed
  avoidProbeHeight: 0.9,   // obstacle whisker height
  separationDistance: 1.6, // spec §4.3: enemies never bunch closer than 1.6 m
  arriveRadius: 0.45,
  avoidProbeDist: 2.5,
  agentRadius: 0.4,
};

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F64 = new Float64Array(0);
const GOLDEN_ANGLE = 2.399963229728653;
const DEDUPE_EPS = 1e-4;

function idHash(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return (Math.imul(v | 0, 2654435761) >>> 0) % 4096;
  const s = String(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 4096;
}

/** Accepts [{x,y,z}] or [[x,y,z]] and returns normalized {x,y,z} records. */
function normalizeDirs(dirs) {
  if (!dirs || !dirs.length) return [];
  const out = [];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (!d) continue;
    const x = Array.isArray(d) ? d[0] || 0 : d.x || 0;
    const y = Array.isArray(d) ? d[1] || 0 : d.y || 0;
    const z = Array.isArray(d) ? d[2] || 0 : d.z || 0;
    const l = Math.hypot(x, y, z);
    if (!(l > EPS)) continue;
    out.push({ x: x / l, y: y / l, z: z / l });
  }
  return out;
}

// ---------------------------------------------------------------------------
// NavGraph
// ---------------------------------------------------------------------------

export class NavGraph {
  constructor(opts = {}) {
    this.losHeight = opts.losHeight ?? NAV.losHeight;
    this.coverProbeHeight = opts.coverProbeHeight ?? NAV.coverProbeHeight;

    /** @type {Array<{id:*,index:number,x:number,y:number,z:number,zone:string,cover:boolean,coverDirs:Array,tags:Array}>} */
    this._nodes = [];
    this._index = new Map();
    /** Authoring-time adjacency: `_adj[i] = [{to, cost, w}]`. */
    this._adj = [];
    this._dirty = true;
    this._n = 0;

    // Flat form (build()).
    this._px = EMPTY_F64;
    this._py = EMPTY_F64;
    this._pz = EMPTY_F64;
    this._edgeStart = EMPTY_I32;
    this._edgeTo = EMPTY_I32;
    this._edgeW = EMPTY_F64;
    this._hScale = 1;

    // A* scratch (build()).
    this._g = EMPTY_F64;
    this._f = EMPTY_F64;
    this._cameFrom = EMPTY_I32;
    this._stamp = EMPTY_I32;      // visitedStamp, compared against _searchId
    this._closed = new Uint8Array(0);
    this._heap = EMPTY_I32;       // binary heap of node indices, keyed by _f
    this._heapPos = EMPTY_I32;    // node index -> heap slot, -1 when not open
    this._heapSize = 0;
    this._searchId = 0;

    // coverNodesNear scratch.
    this._coverIdx = EMPTY_I32;
    this._coverScore = EMPTY_F64;
    this.lastCoverScores = EMPTY_F64;

    this._stats = { searches: 0, nodesExpanded: 0, lastSearchExpanded: 0, failures: 0 };
    this._scratchPt = v3();
  }

  // -- authoring ------------------------------------------------------------

  /**
   * @param {*} id unique key (string or number)
   * @param {object} [opts] {zone, cover, coverDirs, tags}
   * @returns {object} the node record
   */
  addNode(id, x, y, z, opts = {}) {
    if (id === undefined || id === null) throw new Error('NavGraph.addNode: id is required');
    if (this._index.has(id)) throw new Error(`NavGraph.addNode: duplicate id "${String(id)}"`);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`NavGraph.addNode: non-finite position for "${String(id)}"`);
    }
    const index = this._nodes.length;
    const node = {
      id,
      index,
      x: +x,
      y: +y,
      z: +z,
      zone: opts.zone || '',
      cover: !!opts.cover,
      coverDirs: normalizeDirs(opts.coverDirs),
      tags: opts.tags ? opts.tags.slice() : [],
    };
    this._nodes.push(node);
    this._adj.push([]);
    this._index.set(id, index);
    this._dirty = true;
    return node;
  }

  /**
   * Link two nodes. Edge weight is Euclidean distance times `opts.cost`, so a cost
   * multiplier > 1 models "slow / exposed / noisy" ground.
   * Bidirectional unless `opts.oneWay`. Re-connecting an existing pair overwrites it.
   */
  connect(idA, idB, opts = {}) {
    const a = this.indexOf(idA);
    const b = this.indexOf(idB);
    if (a < 0) throw new Error(`NavGraph.connect: unknown node "${String(idA)}"`);
    if (b < 0) throw new Error(`NavGraph.connect: unknown node "${String(idB)}"`);
    if (a === b) throw new Error(`NavGraph.connect: self edge on "${String(idA)}"`);
    const cost = opts.cost === undefined ? 1 : +opts.cost;
    if (!Number.isFinite(cost) || cost <= 0) throw new Error('NavGraph.connect: cost must be > 0');
    const w = this._distIdx(a, b) * cost;
    this._link(a, b, cost, w);
    if (!opts.oneWay) this._link(b, a, cost, w);
    this._dirty = true;
    return this;
  }

  /**
   * Link every unordered pair within `maxDist` that has clear line of sight.
   * Existing edges are left alone so hand-authored costs survive a re-run.
   * @param {object} world CollisionWorld (optional; without one every pair links)
   * @returns {number} edges created (unordered pairs)
   */
  autoConnect(maxDist, world = null, opts = {}) {
    const h = opts.probeHeight ?? this.losHeight;
    const cost = opts.cost === undefined ? 1 : +opts.cost;
    const maxRise = opts.maxRise ?? Infinity;
    const nodes = this._nodes;
    const n = nodes.length;
    let added = 0;
    for (let i = 0; i < n; i++) {
      const A = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const B = nodes[j];
        if (Math.abs(A.y - B.y) > maxRise) continue;
        const d = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
        if (d > maxDist || d < EPS) continue;
        if (this._findEdge(i, j) >= 0 || this._findEdge(j, i) >= 0) continue;
        if (world && !world.lineOfSight(A.x, A.y + h, A.z, B.x, B.y + h, B.z)) continue;
        this._link(i, j, cost, d * cost);
        this._link(j, i, cost, d * cost);
        added++;
      }
    }
    if (added) this._dirty = true;
    return added;
  }

  /** Freeze the authoring graph into flat typed arrays. Idempotent. */
  build() {
    const n = this._nodes.length;
    this._n = n;

    let m = 0;
    for (let i = 0; i < n; i++) m += this._adj[i].length;

    this._px = new Float64Array(n);
    this._py = new Float64Array(n);
    this._pz = new Float64Array(n);
    this._edgeStart = new Int32Array(n + 1);
    this._edgeTo = new Int32Array(m);
    this._edgeW = new Float64Array(m);

    let k = 0;
    let minMul = 1;
    for (let i = 0; i < n; i++) {
      const nd = this._nodes[i];
      this._px[i] = nd.x;
      this._py[i] = nd.y;
      this._pz[i] = nd.z;
      this._edgeStart[i] = k;
      const list = this._adj[i];
      for (let e = 0; e < list.length; e++) {
        this._edgeTo[k] = list[e].to;
        this._edgeW[k] = list[e].w;
        if (list[e].cost < minMul) minMul = list[e].cost;
        k++;
      }
    }
    this._edgeStart[n] = k;

    // Euclidean distance is only admissible if no edge is cheaper than its length;
    // scaling by the smallest multiplier keeps h admissible for "fast lane" edges too.
    this._hScale = Math.min(1, minMul);

    this._g = new Float64Array(n);
    this._f = new Float64Array(n);
    this._cameFrom = new Int32Array(n);
    this._stamp = new Int32Array(n);
    this._closed = new Uint8Array(n);
    this._heap = new Int32Array(n);
    this._heapPos = new Int32Array(n);
    this._heapSize = 0;
    this._searchId = 0;

    this._coverIdx = new Int32Array(n);
    this._coverScore = new Float64Array(n);
    this.lastCoverScores = new Float64Array(n);

    this._dirty = false;
    return this;
  }

  dispose() {
    this._nodes.length = 0;
    this._adj.length = 0;
    this._index.clear();
    this._n = 0;
    this._dirty = true;
    this._px = this._py = this._pz = EMPTY_F64;
    this._edgeStart = this._edgeTo = EMPTY_I32;
    this._edgeW = EMPTY_F64;
    this._g = this._f = EMPTY_F64;
    this._cameFrom = this._stamp = this._heap = this._heapPos = EMPTY_I32;
    this._closed = new Uint8Array(0);
    this._coverIdx = EMPTY_I32;
    this._coverScore = this.lastCoverScores = EMPTY_F64;
    this._heapSize = 0;
  }

  // -- accessors ------------------------------------------------------------

  get nodeCount() {
    return this._nodes.length;
  }

  get edgeCount() {
    let m = 0;
    for (let i = 0; i < this._adj.length; i++) m += this._adj[i].length;
    return m;
  }

  get built() {
    return !this._dirty;
  }

  get stats() {
    return this._stats;
  }

  /** @returns {object|null} the node record for `id` */
  node(id) {
    const i = this.indexOf(id);
    return i < 0 ? null : this._nodes[i];
  }

  /** @returns {object|null} the node record at a flat index */
  nodeAt(index) {
    return index >= 0 && index < this._nodes.length ? this._nodes[index] : null;
  }

  indexOf(id) {
    const i = this._index.get(id);
    return i === undefined ? -1 : i;
  }

  hasEdge(idA, idB) {
    const a = this.indexOf(idA);
    const b = this.indexOf(idB);
    return a >= 0 && b >= 0 && this._findEdge(a, b) >= 0;
  }

  /** Traversal weight (distance x cost multiplier) of a directed edge, or -1. */
  edgeWeight(idA, idB) {
    const a = this.indexOf(idA);
    const b = this.indexOf(idB);
    if (a < 0 || b < 0) return -1;
    const e = this._findEdge(a, b);
    return e < 0 ? -1 : this._adj[a][e].w;
  }

  /** Writes neighbour ids into `out`. @returns {number} count */
  neighbours(id, out = []) {
    const a = this.indexOf(id);
    if (a < 0) {
      out.length = 0;
      return 0;
    }
    const list = this._adj[a];
    out.length = list.length;
    for (let i = 0; i < list.length; i++) out[i] = this._nodes[list[i].to].id;
    return list.length;
  }

  /** Total traversal cost of a sequence of node ids. -1 if any hop is not an edge. */
  pathCost(ids, len = ids ? ids.length : 0) {
    if (len <= 1) return 0;
    let total = 0;
    for (let i = 1; i < len; i++) {
      const w = this.edgeWeight(ids[i - 1], ids[i]);
      if (w < 0) return -1;
      total += w;
    }
    return total;
  }

  /** Copies a node position into `out`. @returns {object|null} */
  positionOf(id, out = v3()) {
    const nd = this.node(id);
    if (!nd) return null;
    return v3set(out, nd.x, nd.y, nd.z);
  }

  /** Converts a node-id path into positions, reusing objects already in `out`. */
  pathPoints(ids, len = ids ? ids.length : 0, out = []) {
    let c = 0;
    for (let i = 0; i < len; i++) {
      const nd = this.node(ids[i]);
      if (!nd) continue;
      if (out[c]) v3set(out[c], nd.x, nd.y, nd.z);
      else out[c] = v3(nd.x, nd.y, nd.z);
      c++;
    }
    out.length = c;
    return c;
  }

  // -- queries --------------------------------------------------------------

  /**
   * Nearest node to a world position.
   * @param {object} [opts] {maxDist, requireLos: CollisionWorld, strictLos, zone,
   *                         requireCover, probeHeight}
   * @returns {*} node id, or -1 when nothing qualifies
   */
  nearestNode(x, y, z, opts = {}) {
    const i = this._nearestIndex(x, y, z, opts);
    return i < 0 ? -1 : this._nodes[i].id;
  }

  _nearestIndex(x, y, z, opts = {}) {
    const maxDist = opts.maxDist ?? Infinity;
    const maxSq = maxDist === Infinity ? Infinity : maxDist * maxDist;
    const world = opts.requireLos || null;
    const h = opts.probeHeight ?? this.losHeight;
    const zone = opts.zone || null;
    const nodes = this._nodes;
    let bestAny = -1;
    let bestAnyD = Infinity;
    let bestLos = -1;
    let bestLosD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (zone && nd.zone !== zone) continue;
      if (opts.requireCover && !nd.cover) continue;
      const dx = nd.x - x;
      const dy = nd.y - y;
      const dz = nd.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxSq) continue;
      if (d2 < bestAnyD) {
        bestAnyD = d2;
        bestAny = i;
      }
      if (world && d2 < bestLosD && world.lineOfSight(x, y + h, z, nd.x, nd.y + h, nd.z)) {
        bestLosD = d2;
        bestLos = i;
      }
    }
    if (bestLos >= 0) return bestLos;              // prefer visible nodes
    if (world && opts.strictLos) return -1;
    return bestAny;
  }

  /**
   * A* over the graph.
   * @param {Array} out receives node ids
   * @returns {number} path length in nodes; 0 when unreachable
   */
  findPath(fromId, toId, out = []) {
    this._ensureBuilt();
    const s = this.indexOf(fromId);
    const t = this.indexOf(toId);
    this._stats.searches++;
    this._stats.lastSearchExpanded = 0;
    if (s < 0 || t < 0) {
      out.length = 0;
      this._stats.failures++;
      return 0;
    }
    return this._search(s, t, out);
  }

  /** Nearest-node snap on both ends, then A*. */
  pathToPosition(fromX, fromY, fromZ, toX, toY, toZ, out = [], opts = {}) {
    this._ensureBuilt();
    const s = this._nearestIndex(fromX, fromY, fromZ, opts);
    const t = this._nearestIndex(toX, toY, toZ, opts);
    this._stats.searches++;
    this._stats.lastSearchExpanded = 0;
    if (s < 0 || t < 0) {
      out.length = 0;
      this._stats.failures++;
      return 0;
    }
    return this._search(s, t, out);
  }

  /**
   * Cover nodes within `radius`, best first.
   * Ranking: hard bonus when the threat has no line of sight to the node, a softer
   * bonus when the threat lies inside one of the node's protected arcs, minus travel
   * distance, plus a small preference for not hugging the threat.
   * Scores land in `graph.lastCoverScores` parallel to `out`.
   * @returns {number} count written into `out` (node ids)
   */
  coverNodesNear(x, y, z, radius, threatPos = null, world = null, out = []) {
    this._ensureBuilt();
    const nodes = this._nodes;
    const idxs = this._coverIdx;
    const scores = this._coverScore;
    const h = this.coverProbeHeight;
    const r2 = radius * radius;
    let cnt = 0;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (!nd.cover) continue;
      const dx = nd.x - x;
      const dy = nd.y - y;
      const dz = nd.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      let score = -2 * Math.sqrt(d2);
      if (threatPos) {
        const tx = threatPos.x - nd.x;
        const ty = threatPos.y - nd.y;
        const tz = threatPos.z - nd.z;
        const td = Math.hypot(tx, ty, tz);
        if (world && !world.lineOfSight(
          threatPos.x, threatPos.y + h, threatPos.z, nd.x, nd.y + h, nd.z,
        )) {
          score += 100;
        }
        if (nd.coverDirs.length && td > EPS) {
          const ux = tx / td;
          const uy = ty / td;
          const uz = tz / td;
          let best = -1;
          for (let c = 0; c < nd.coverDirs.length; c++) {
            const dir = nd.coverDirs[c];
            const dp = dir.x * ux + dir.y * uy + dir.z * uz;
            if (dp > best) best = dp;
          }
          score += 25 * Math.max(0, best);
        }
        score += 0.5 * Math.min(td, 30);
      }
      // Insertion sort, descending: cover sets are a handful of nodes.
      let p = cnt;
      while (p > 0 && scores[p - 1] < score) {
        scores[p] = scores[p - 1];
        idxs[p] = idxs[p - 1];
        p--;
      }
      scores[p] = score;
      idxs[p] = i;
      cnt++;
    }
    out.length = cnt;
    for (let k = 0; k < cnt; k++) {
      out[k] = nodes[idxs[k]].id;
      this.lastCoverScores[k] = scores[k];
    }
    return cnt;
  }

  /**
   * String pulling. A waypoint is dropped only when the segment that would replace it
   * has clear line of sight, so the smoothed path can never cut a corner through
   * geometry. Without a `world` nothing is dropped (we cannot prove it is safe).
   * @param {Array<{x,y,z}>} points
   * @param {Array} out receives {x,y,z} (objects already in `out` are reused)
   * @returns {number} count
   */
  smoothPath(points, world = null, out = [], opts = {}) {
    const n = points ? points.length : 0;
    if (n === 0) {
      out.length = 0;
      return 0;
    }
    const h = opts.height ?? this.losHeight;
    let cnt = 0;
    cnt = writePoint(out, cnt, points[0]);
    let anchor = 0;
    while (anchor < n - 1) {
      let next = anchor + 1;
      if (world) {
        const a = points[anchor];
        for (let j = n - 1; j > anchor + 1; j--) {
          const b = points[j];
          if (world.lineOfSight(a.x, a.y + h, a.z, b.x, b.y + h, b.z)) {
            next = j;
            break;
          }
        }
      }
      const p = points[next];
      // Collapse duplicates, but never drop the destination.
      const last = out[cnt - 1];
      const dup = last
        && Math.abs(last.x - p.x) < DEDUPE_EPS
        && Math.abs(last.y - p.y) < DEDUPE_EPS
        && Math.abs(last.z - p.z) < DEDUPE_EPS;
      if (!dup || next === n - 1) cnt = writePoint(out, cnt, p);
      anchor = next;
    }
    out.length = cnt;
    return cnt;
  }

  // -- internals ------------------------------------------------------------

  _ensureBuilt() {
    if (this._dirty) this.build();
  }

  _distIdx(a, b) {
    const A = this._nodes[a];
    const B = this._nodes[b];
    return Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
  }

  _findEdge(a, b) {
    const list = this._adj[a];
    for (let i = 0; i < list.length; i++) if (list[i].to === b) return i;
    return -1;
  }

  _link(a, b, cost, w) {
    const e = this._findEdge(a, b);
    if (e >= 0) {
      this._adj[a][e].cost = cost;
      this._adj[a][e].w = w;
    } else {
      this._adj[a].push({ to: b, cost, w });
    }
  }

  /** Euclidean heuristic, scaled to stay admissible under sub-unit cost multipliers. */
  _h(i, t) {
    const dx = this._px[i] - this._px[t];
    const dy = this._py[i] - this._py[t];
    const dz = this._pz[i] - this._pz[t];
    return this._hScale * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _nextSearchId() {
    if (this._searchId >= 0x7ffffffe) {
      this._stamp.fill(0);
      this._searchId = 0;
    }
    return ++this._searchId;
  }

  /** Allocation-free A* between two flat indices. */
  _search(s, t, out) {
    if (s === t) {
      out.length = 1;
      out[0] = this._nodes[s].id;
      return 1;
    }
    const sid = this._nextSearchId();
    const g = this._g;
    const f = this._f;
    const cf = this._cameFrom;
    const stamp = this._stamp;
    const closed = this._closed;
    const heapPos = this._heapPos;
    const edgeStart = this._edgeStart;
    const edgeTo = this._edgeTo;
    const edgeW = this._edgeW;

    this._heapSize = 0;
    stamp[s] = sid;
    closed[s] = 0;
    g[s] = 0;
    f[s] = this._h(s, t);
    cf[s] = -1;
    heapPos[s] = -1;
    this._heapPush(s);

    let expanded = 0;
    let found = false;
    while (this._heapSize > 0) {
      const cur = this._heapPop();
      if (cur === t) {
        found = true;
        break;
      }
      closed[cur] = 1;
      expanded++;
      const e1 = edgeStart[cur + 1];
      for (let e = edgeStart[cur]; e < e1; e++) {
        const nb = edgeTo[e];
        if (stamp[nb] !== sid) {
          stamp[nb] = sid;
          closed[nb] = 0;
          g[nb] = Infinity;
          cf[nb] = -1;
          heapPos[nb] = -1;
        }
        if (closed[nb]) continue;
        const tentative = g[cur] + edgeW[e];
        if (tentative < g[nb]) {
          g[nb] = tentative;
          cf[nb] = cur;
          f[nb] = tentative + this._h(nb, t);
          if (heapPos[nb] >= 0) this._heapUp(heapPos[nb]);
          else this._heapPush(nb);
        }
      }
    }

    this._stats.nodesExpanded += expanded;
    this._stats.lastSearchExpanded = expanded;

    if (!found) {
      out.length = 0;
      this._stats.failures++;
      return 0;
    }

    let len = 0;
    for (let c = t; c !== -1; c = cf[c]) len++;
    out.length = len;
    let w = len - 1;
    for (let c = t; c !== -1; c = cf[c]) out[w--] = this._nodes[c].id;
    return len;
  }

  // Indexed binary min-heap over `_f`. Size is bounded by nodeCount because
  // decrease-key updates in place instead of pushing duplicates.
  _heapPush(node) {
    const i = this._heapSize++;
    this._heap[i] = node;
    this._heapPos[node] = i;
    this._heapUp(i);
  }

  _heapPop() {
    const heap = this._heap;
    const top = heap[0];
    this._heapPos[top] = -1;
    const last = --this._heapSize;
    if (last > 0) {
      heap[0] = heap[last];
      this._heapPos[heap[0]] = 0;
      this._heapDown(0);
    }
    return top;
  }

  _heapUp(i) {
    const heap = this._heap;
    const f = this._f;
    const pos = this._heapPos;
    const node = heap[i];
    const key = f[node];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pn = heap[parent];
      if (f[pn] <= key) break;
      heap[i] = pn;
      pos[pn] = i;
      i = parent;
    }
    heap[i] = node;
    pos[node] = i;
  }

  _heapDown(i) {
    const heap = this._heap;
    const f = this._f;
    const pos = this._heapPos;
    const size = this._heapSize;
    const node = heap[i];
    const key = f[node];
    for (;;) {
      const l = i * 2 + 1;
      if (l >= size) break;
      const r = l + 1;
      let c = l;
      if (r < size && f[heap[r]] < f[heap[l]]) c = r;
      const cn = heap[c];
      if (f[cn] >= key) break;
      heap[i] = cn;
      pos[cn] = i;
      i = c;
    }
    heap[i] = node;
    pos[node] = i;
  }
}

function writePoint(out, k, p) {
  if (out[k]) v3set(out[k], p.x, p.y, p.z);
  else out[k] = v3(p.x, p.y, p.z);
  return k + 1;
}

// ---------------------------------------------------------------------------
// PathFollower
// ---------------------------------------------------------------------------

/**
 * Walks an agent along a node path. Waypoints live in one flat Float64Array so
 * following costs nothing per tick; `advance()` returns a reused steering target.
 */
export class PathFollower {
  constructor(navGraph = null, opts = {}) {
    this.graph = navGraph;
    this.arriveRadius = opts.arriveRadius ?? NAV.arriveRadius;
    this._cap = 0;
    this._pts = EMPTY_F64;   // xyz triples
    this._cum = EMPTY_F64;   // cumulative distance at each waypoint
    this._count = 0;
    this._i = 0;
    this._total = 0;
    this._travelled = 0;
    this._target = v3();
  }

  _reserve(n) {
    if (n <= this._cap) return;
    const cap = Math.max(16, n * 2);
    this._pts = new Float64Array(cap * 3);
    this._cum = new Float64Array(cap);
    this._cap = cap;
  }

  /** @param {Array} nodeIds ids resolvable in the bound NavGraph */
  setPath(nodeIds, len = nodeIds ? nodeIds.length : 0) {
    if (!this.graph) throw new Error('PathFollower.setPath: no NavGraph bound');
    this._reserve(len);
    let c = 0;
    for (let i = 0; i < len; i++) {
      const nd = this.graph.node(nodeIds[i]);
      if (!nd) continue;
      this._pts[c * 3] = nd.x;
      this._pts[c * 3 + 1] = nd.y;
      this._pts[c * 3 + 2] = nd.z;
      c++;
    }
    this._commit(c);
    return this;
  }

  /** @param {Array<{x,y,z}>} points */
  setPathPoints(points, len = points ? points.length : 0) {
    this._reserve(len);
    for (let i = 0; i < len; i++) {
      const p = points[i];
      this._pts[i * 3] = p.x;
      this._pts[i * 3 + 1] = p.y;
      this._pts[i * 3 + 2] = p.z;
    }
    this._commit(len);
    return this;
  }

  _commit(count) {
    this._count = count;
    this._i = 0;
    this._travelled = 0;
    let acc = 0;
    if (count > 0) this._cum[0] = 0;
    for (let i = 1; i < count; i++) {
      acc += Math.hypot(
        this._pts[i * 3] - this._pts[(i - 1) * 3],
        this._pts[i * 3 + 1] - this._pts[(i - 1) * 3 + 1],
        this._pts[i * 3 + 2] - this._pts[(i - 1) * 3 + 2],
      );
      this._cum[i] = acc;
    }
    this._total = acc;
  }

  get active() {
    return this._count > 0 && this._i < this._count;
  }

  get waypointCount() {
    return this._count;
  }

  /** Index of the waypoint currently being steered toward. */
  get index() {
    return this._i;
  }

  get totalDistance() {
    return this._total;
  }

  get progress() {
    if (this._count === 0) return 0;
    if (!this.active) return 1;
    if (this._total <= EPS) return 0;
    return clamp(this._travelled / this._total, 0, 1);
  }

  get remainingDistance() {
    if (!this.active) return 0;
    return Math.max(0, this._total - this._travelled);
  }

  /** Copies the current waypoint into `out`, or null when finished. */
  peek(out = v3()) {
    if (!this.active) return null;
    const i = this._i;
    return v3set(out, this._pts[i * 3], this._pts[i * 3 + 1], this._pts[i * 3 + 2]);
  }

  /**
   * @param {{x,y,z}} currentPos agent position
   * @returns {{x,y,z}|null} reused steering target, null once the path is finished
   */
  advance(currentPos, arriveRadius = this.arriveRadius) {
    if (this._count === 0 || this._i >= this._count) return null;
    const pts = this._pts;
    const r2 = arriveRadius * arriveRadius;
    // Consume every waypoint already reached this tick (handles fast agents and
    // duplicated / co-located waypoints in one pass).
    while (this._i < this._count) {
      const i = this._i;
      const dx = pts[i * 3] - currentPos.x;
      const dy = pts[i * 3 + 1] - currentPos.y;
      const dz = pts[i * 3 + 2] - currentPos.z;
      if (dx * dx + dy * dy + dz * dz > r2) break;
      this._i++;
    }
    if (this._i >= this._count) {
      this._travelled = this._total;
      return null;
    }
    const i = this._i;
    const tx = pts[i * 3];
    const ty = pts[i * 3 + 1];
    const tz = pts[i * 3 + 2];
    const d = Math.hypot(tx - currentPos.x, ty - currentPos.y, tz - currentPos.z);
    const base = this._cum[i];
    const legStart = i > 0 ? this._cum[i - 1] : 0;
    this._travelled = clamp(base - d, legStart, base);
    return v3set(this._target, tx, ty, tz);
  }

  reset() {
    this._count = 0;
    this._i = 0;
    this._total = 0;
    this._travelled = 0;
    return this;
  }

  dispose() {
    this.reset();
    this._pts = EMPTY_F64;
    this._cum = EMPTY_F64;
    this._cap = 0;
    this.graph = null;
  }
}

// ---------------------------------------------------------------------------
// Steering primitives — pure, allocation-free, always write into `out`.
// ---------------------------------------------------------------------------

/** Desired velocity straight at `target`, magnitude `maxSpeed`. */
export function seek(out, pos, target, maxSpeed = 1) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dz = target.z - pos.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d > EPS)) return v3set(out, 0, 0, 0);
  const s = maxSpeed / d;
  return v3set(out, dx * s, dy * s, dz * s);
}

/**
 * Three forward whiskers (centre plus one at each shoulder). Each hit contributes a
 * push along the surface normal plus a tangential component in the direction that
 * preserves forward motion, so agents slide around corners instead of stalling.
 * Output magnitude is in [0,1] and is never NaN.
 */
export function avoidObstacles(
  out, pos, velocity, world, probeDist = NAV.avoidProbeDist, radius = NAV.agentRadius,
) {
  v3set(out, 0, 0, 0);
  if (!world || typeof world.raycast !== 'function' || !(probeDist > 0)) return out;
  let fx = velocity.x;
  let fz = velocity.z;
  const fl = Math.hypot(fx, fz);
  if (!(fl > EPS)) return out;
  fx /= fl;
  fz /= fl;
  const px = -fz;  // left perpendicular in XZ
  const pz = fx;
  const oy = pos.y + NAV.avoidProbeHeight;
  let ax = 0;
  let az = 0;
  for (let k = -1; k <= 1; k++) {
    const ox = pos.x + px * radius * k;
    const oz = pos.z + pz * radius * k;
    const r = world.raycast(ox, oy, oz, fx, 0, fz, probeDist);
    if (!r || !r.hit) continue;
    const w = 1 - clamp(r.dist / probeDist, 0, 1);
    ax += r.normal.x * w;
    az += r.normal.z * w;
    let lx = -r.normal.z;
    let lz = r.normal.x;
    if (lx * fx + lz * fz < 0) {
      lx = -lx;
      lz = -lz;
    }
    ax += lx * w * 0.75;
    az += lz * w * 0.75;
  }
  const l = Math.hypot(ax, az);
  if (!(l > EPS)) return v3set(out, 0, 0, 0);
  const s = Math.min(1, l) / l;
  return v3set(out, ax * s, 0, az * s);
}

/**
 * Push away from neighbours closer than `minDistance` (spec §4.3: 1.6 m).
 * Falls off linearly to zero at `minDistance`; beyond it the result is exactly zero.
 * Exactly co-located agents get a deterministic golden-angle fan keyed on the
 * neighbour's id (never Math.random, which is banned in src/).
 */
export function separation(out, pos, neighbours, minDistance = NAV.separationDistance) {
  v3set(out, 0, 0, 0);
  if (!neighbours || !neighbours.length || !(minDistance > 0)) return out;
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 0; i < neighbours.length; i++) {
    const nb = neighbours[i];
    if (!nb) continue;
    let dx = pos.x - nb.x;
    let dy = pos.y - nb.y;
    let dz = pos.z - nb.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d < minDistance)) continue;
    let w;
    if (d < DEDUPE_EPS) {
      const a = (nb.id !== undefined ? idHash(nb.id) : i) * GOLDEN_ANGLE;
      dx = Math.cos(a);
      dy = 0;
      dz = Math.sin(a);
      w = 1;
    } else {
      const inv = 1 / d;
      dx *= inv;
      dy *= inv;
      dz *= inv;
      w = 1 - d / minDistance;
    }
    ax += dx * w;
    ay += dy * w;
    az += dz * w;
  }
  const l = Math.hypot(ax, ay, az);
  if (!(l > EPS)) return v3set(out, 0, 0, 0);
  const s = Math.min(1, l) / l;
  return v3set(out, ax * s, ay * s, az * s);
}

/**
 * Weighted sum of steering vectors, truncated to unit length.
 * Accepts either varargs or a single array: `blendSteering(out, [{v,weight},...])`.
 * Null entries and non-finite components are ignored, so one bad input can never
 * poison the blend.
 */
export function blendSteering(out, ...parts) {
  const list = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts;
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.v) continue;
    const w = p.weight === undefined ? 1 : p.weight;
    if (!Number.isFinite(w)) continue;
    const v = p.v;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
    ax += v.x * w;
    ay += v.y * w;
    az += v.z * w;
  }
  const l = Math.hypot(ax, ay, az);
  if (!(l > EPS)) return v3set(out, 0, 0, 0);
  const s = Math.min(1, l) / l;
  return v3set(out, ax * s, ay * s, az * s);
}
