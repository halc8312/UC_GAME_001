/**
 * Undercurrent Station — level definition.
 *
 * Pure data plus collider construction. No Three.js here: `levelbuild.js` turns this
 * into meshes, and the unit suite validates the geometry (connectivity, no gaps in
 * the floor, spawn points standing on solid ground) without a browser.
 *
 * Coordinate system: Y up, metres. The player starts on the dock at +Z and works
 * north (−Z) through the facility, then east and up onto the catwalks and helipad.
 */
import { box, ramp, SURFACE } from './collision.js';

export const SEA_LEVEL = -2.0;
export const CATWALK_Y = 6.4;

/** A wall with a doorway punched through it, returned as three boxes. */
function wallWithDoor(min, max, axis, doorMin, doorMax, doorTop, surface) {
  const out = [];
  if (axis === 'x') {
    out.push(box([min[0], min[1], min[2]], [doorMin, max[1], max[2]], surface));
    out.push(box([doorMax, min[1], min[2]], [max[0], max[1], max[2]], surface));
    out.push(box([doorMin, doorTop, min[2]], [doorMax, max[1], max[2]], surface));
  } else {
    out.push(box([min[0], min[1], min[2]], [max[0], max[1], doorMin], surface));
    out.push(box([min[0], min[1], doorMax], [max[0], max[1], max[2]], surface));
    out.push(box([min[0], doorTop, doorMin], [max[0], max[1], doorMax], surface));
  }
  return out;
}

/** Shared options for railing colliders (see `railing()` below). */
const RAILING_OPTS = { tag: 'railing', blocksSight: false };

/** Railing run: a solid 1.1 m barrier. Solid on purpose — the player must not fall. */
function railing(min, max, y = 0) {
  return box([min[0], y, min[1]], [max[0], y + 1.1, max[1]], SURFACE.METAL, {
    tag: 'railing',
    // Solid to movement, transparent to sight and gunfire — the visual is open
    // posts and rails, so blocking shots with the collision slab would read as
    // bullets hitting thin air.
    blocksSight: false,
  });
}

export const ZONES = {
  DOCK: 'dock',
  APRON: 'apron',
  PUMP_HALL: 'pump_hall',
  CORRIDOR: 'corridor',
  SERVER_ROOM: 'server_room',
  STAIR_TOWER: 'stair_tower',
  CATWALK: 'catwalk',
  HELIPAD: 'helipad',
};

/** Axis-aligned volumes used for zone lookup and beat gating. */
export const ZONE_VOLUMES = [
  { zone: ZONES.DOCK, min: [-9, -3, 33], max: [9, 6, 59] },
  { zone: ZONES.APRON, min: [-15, -3, 27], max: [21, 6, 35] },
  { zone: ZONES.PUMP_HALL, min: [-21, -1, -3], max: [15, 10, 27] },
  { zone: ZONES.CORRIDOR, min: [-5, -1, -17], max: [3, 4, -1] },
  { zone: ZONES.SERVER_ROOM, min: [-23, -1, -37], max: [7, 6, -15] },
  { zone: ZONES.STAIR_TOWER, min: [7, -1, -33], max: [19, 9, -21] },
  { zone: ZONES.CATWALK, min: [19, 5, -26], max: [31, 9, 3] },
  { zone: ZONES.HELIPAD, min: [29, 5, -7], max: [45, 9, 9] },
];

export function zoneAt(x, y, z) {
  for (const v of ZONE_VOLUMES) {
    if (
      x >= v.min[0] && x <= v.max[0] &&
      y >= v.min[1] && y <= v.max[1] &&
      z >= v.min[2] && z <= v.max[2]
    ) {
      return v.zone;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

export function buildColliders() {
  const C = [];
  const push = (...items) => {
    for (const i of items) Array.isArray(i) ? C.push(...i) : C.push(i);
  };

  // ===== DOCK =====================================================
  push(box([-8, -0.6, 34], [8, 0, 58], SURFACE.WOOD, { tag: 'dock_deck' }));
  push(railing([-8.4, 34], [-8, 58]));
  push(railing([8, 34], [8.4, 58]));
  push(box([-8.4, 0, 58], [8.4, 2.6, 58.4], SURFACE.METAL, { tag: 'dock_end' }));
  // Mooring bollards + crates: cover on the approach.
  push(box([-6.6, 0, 44], [-5.4, 1.2, 46.4], SURFACE.WOOD, { tag: 'crate' }));
  push(box([-6.6, 1.2, 44.6], [-5.6, 2.3, 45.8], SURFACE.WOOD, { tag: 'crate' }));
  push(box([4.8, 0, 40], [6.4, 1.2, 42.6], SURFACE.WOOD, { tag: 'crate' }));
  push(box([1.8, 0, 37.4], [3.4, 1.1, 39.0], SURFACE.METAL, { tag: 'crate' }));

  // ===== APRON (quay in front of the facility) =====================
  push(box([-14, -0.6, 28], [20, 0, 34], SURFACE.CONCRETE, { tag: 'apron' }));
  push(railing([-14.4, 28], [-14, 34]));
  push(railing([20, 28], [20.4, 34]));
  push(box([-14.4, 0, 33.9], [-8, 1.1, 34.3], SURFACE.METAL, RAILING_OPTS));
  push(box([8, 0, 33.9], [20.4, 1.1, 34.3], SURFACE.METAL, RAILING_OPTS));
  push(box([2.4, 0, 29.2], [4.4, 1.3, 31.6], SURFACE.METAL, { tag: 'crate' }));
  push(box([-7.4, 0, 29.6], [-5.0, 1.3, 31.4], SURFACE.METAL, { tag: 'crate' }));

  // ===== PUMP HALL =================================================
  push(box([-22, -1, -4], [16, 0, 28], SURFACE.CONCRETE, { tag: 'hall_floor' }));
  push(box([-22, 9, -2], [16, 10, 26], SURFACE.CONCRETE, { tag: 'hall_ceiling' }));
  push(box([-22, 0, -4], [-20, 9, 28], SURFACE.CONCRETE, { tag: 'hall_w' }));
  push(box([14, 0, -4], [16, 9, 28], SURFACE.CONCRETE, { tag: 'hall_e' }));
  // South wall with the entry door from the apron.
  push(wallWithDoor([-22, 0, 26], [20, 9, 28], 'x', -3, 3, 2.7, SURFACE.CONCRETE));
  // North wall with the door into the corridor.
  push(wallWithDoor([-22, 0, -4], [16, 9, -2], 'x', -4, 2, 2.7, SURFACE.CONCRETE));

  // Pump machinery — cover and sightline breakers.
  const pumps = [[-9, 8], [-9, 19], [4, 8], [4, 19]];
  for (const [px, pz] of pumps) {
    push(box([px - 2.1, 0, pz - 2.1], [px + 2.1, 3.0, pz + 2.1], SURFACE.METAL, { tag: 'pump' }));
    push(box([px - 0.6, 3.0, pz - 0.6], [px + 0.6, 5.4, pz + 0.6], SURFACE.METAL, { tag: 'pump_stack' }));
  }
  // Low crates for combat cover.
  push(box([-3.4, 0, 12.4], [-1.0, 1.25, 15.2], SURFACE.METAL, { tag: 'crate' }));
  push(box([8.2, 0, 12.0], [10.6, 1.25, 14.0], SURFACE.METAL, { tag: 'crate' }));
  push(box([-16.5, 0, 21.0], [-14.1, 1.25, 23.4], SURFACE.WOOD, { tag: 'crate' }));
  push(box([9.0, 0, 22.0], [11.4, 1.4, 24.4], SURFACE.WOOD, { tag: 'crate' }));
  push(box([-1.2, 0, 3.0], [1.6, 1.1, 5.2], SURFACE.METAL, { tag: 'crate' }));

  // Mezzanine along the west wall, reached by a 35° stair ramp at the south end.
  push(ramp([-19, 0, 20], [-15.5, 4.2, 26], 'z', -1, SURFACE.GRATE, { tag: 'mezz_stair' }));
  push(box([-19.2, 0, 19.6], [-15.3, 5.3, 20], SURFACE.METAL, RAILING_OPTS));
  push(box([-15.5, 1.0, 20], [-15.2, 5.3, 26], SURFACE.METAL, RAILING_OPTS));
  push(box([-20, 4.0, 2], [-14.8, 4.2, 20], SURFACE.GRATE, { tag: 'mezzanine' }));
  push(box([-15.1, 4.2, 2], [-14.8, 5.3, 20], SURFACE.METAL, RAILING_OPTS));
  push(box([-20, 4.2, 1.7], [-14.8, 5.3, 2], SURFACE.METAL, RAILING_OPTS));

  // Overhead pipe runs (visual + sight blockers, walkable on top of nothing).
  push(box([-20, 7.4, 5.0], [16, 8.1, 6.2], SURFACE.METAL, { tag: 'pipe' }));
  push(box([-20, 7.4, 15.0], [16, 8.1, 16.2], SURFACE.METAL, { tag: 'pipe' }));

  // ===== CORRIDOR ==================================================
  push(box([-6, -1, -18], [4, 0, -2], SURFACE.CONCRETE, { tag: 'corr_floor' }));
  push(box([-6, 3.2, -18], [4, 4, -2], SURFACE.CONCRETE, { tag: 'corr_ceiling' }));
  push(box([-6, 0, -18], [-4, 3.2, -2], SURFACE.PANEL, { tag: 'corr_w' }));
  push(box([2, 0, -18], [4, 3.2, -2], SURFACE.CONCRETE, { tag: 'corr_e' }));

  // ===== SERVER ROOM ===============================================
  push(box([-24, -1, -38], [8, 0, -14], SURFACE.RUBBER, { tag: 'server_floor' }));
  push(box([-24, 5, -36], [8, 6, -16], SURFACE.CONCRETE, { tag: 'server_ceiling' }));
  push(box([-24, 0, -38], [-22, 5, -14], SURFACE.CONCRETE, { tag: 'server_w' }));
  push(box([-24, 0, -38], [8, 5, -36], SURFACE.CONCRETE, { tag: 'server_n' }));
  // South wall with the corridor door.
  push(wallWithDoor([-24, 0, -16], [8, 5, -14], 'x', -4, 2, 2.7, SURFACE.CONCRETE));
  // East wall with the door to the stair tower.
  push(wallWithDoor([6, 0, -38], [8, 5, -14], 'z', -30, -24, 2.7, SURFACE.CONCRETE));

  // Server racks in two aisles.
  for (let i = 0; i < 4; i++) {
    const x = -19 + i * 5.2;
    push(box([x, 0, -34], [x + 1.4, 2.3, -26.5], SURFACE.METAL, { tag: 'rack' }));
    push(box([x, 0, -24.5], [x + 1.4, 2.3, -18], SURFACE.METAL, { tag: 'rack' }));
  }
  // Data core pedestal.
  push(box([-10.9, 0, -30.9], [-9.1, 1.0, -29.1], SURFACE.METAL, { tag: 'core_pedestal' }));
  push(box([-2.2, 0, -17.4], [-0.6, 0.7, -16.2], SURFACE.METAL, { tag: 'weapon_table' }));

  // ===== STAIR TOWER ===============================================
  push(box([8, -1, -34], [20, 0, -20], SURFACE.CONCRETE, { tag: 'tower_floor' }));
  push(box([8, 0, -34], [20, 9, -32], SURFACE.CONCRETE, { tag: 'tower_n' }));
  push(box([8, 0, -22], [20, 9, -20], SURFACE.CONCRETE, { tag: 'tower_s' }));
  push(box([8, 8.6, -32], [20, 9, -22], SURFACE.CONCRETE, { tag: 'tower_ceiling' }));
  // East wall: solid except a 6.4–8.6 m doorway onto the catwalk.
  push(box([18, 0, -34], [20, 9, -24.5], SURFACE.CONCRETE, { tag: 'tower_e' }));
  push(box([18, 0, -22.5], [20, 9, -20], SURFACE.CONCRETE, { tag: 'tower_e' }));
  push(box([18, 0, -24.5], [20, CATWALK_Y, -22.5], SURFACE.CONCRETE, { tag: 'tower_e_sill' }));
  // Two flights with a mid landing.
  push(ramp([8.5, 0, -28.5], [12.5, 3.2, -24], 'z', -1, SURFACE.GRATE, { tag: 'stair_1' }));
  push(box([8.5, 3.0, -31.8], [17.5, 3.2, -28.5], SURFACE.GRATE, { tag: 'stair_landing' }));
  push(ramp([13.5, 3.2, -28.5], [17.5, CATWALK_Y, -24], 'z', 1, SURFACE.GRATE, { tag: 'stair_2' }));
  push(box([13.5, CATWALK_Y - 0.2, -24], [18, CATWALK_Y, -22.6], SURFACE.GRATE, { tag: 'stair_top' }));
  push(box([12.5, 0, -28.5], [13.5, CATWALK_Y, -22.6], SURFACE.CONCRETE, { tag: 'stair_spine' }));
  push(box([8.5, 3.2, -24.2], [12.5, 4.3, -24], SURFACE.METAL, RAILING_OPTS));

  // ===== CATWALKS ==================================================
  const cy = CATWALK_Y;
  push(box([20, cy - 0.2, -25], [30, cy, -21], SURFACE.GRATE, { tag: 'catwalk_a' }));
  push(box([26, cy - 0.2, -25], [30, cy, 2], SURFACE.GRATE, { tag: 'catwalk_b' }));
  // Railings: solid, continuous — falling off the catwalk would soft-lock the mission.
  push(box([20, cy, -25.4], [26.4, cy + 1.1, -25], SURFACE.METAL, RAILING_OPTS));
  push(box([20, cy, -21], [26, cy + 1.1, -20.6], SURFACE.METAL, RAILING_OPTS));
  push(box([25.6, cy, -21], [26, cy + 1.1, 2.4], SURFACE.METAL, RAILING_OPTS));
  push(box([30, cy, -25.4], [30.4, cy + 1.1, -6], SURFACE.METAL, RAILING_OPTS));
  push(box([26, cy, 2], [30.4, cy + 1.1, 2.4], SURFACE.METAL, RAILING_OPTS));
  // Cover on the catwalk run.
  //
  // Sized so a 0.8 m-wide operator can pass on *either* side. The first cut left a
  // 1.0 m gap west and 0.4 m east, and walking north into the crate face is a
  // perpendicular hit with no lateral component for collide-and-slide to work
  // with — the player simply stopped dead and the withdrawal was impassable in a
  // straight line.
  push(box([27.3, cy, -16.0], [28.9, cy + 1.3, -14.4], SURFACE.METAL, { tag: 'crate' }));
  push(box([26.5, cy, -9.0], [28.1, cy + 1.3, -7.4], SURFACE.METAL, { tag: 'crate' }));
  push(box([21.2, cy, -24.6], [23.2, cy + 1.3, -23.0], SURFACE.METAL, { tag: 'crate' }));

  // Support columns down to the yard, so the catwalk reads as built, not floating.
  for (let z = -24; z <= 0; z += 6) {
    push(box([26.6, 0, z], [27.4, cy - 0.2, z + 0.8], SURFACE.METAL, { tag: 'column' }));
  }

  // ===== HELIPAD ===================================================
  push(box([30, cy - 0.4, -6], [44, cy, 8], SURFACE.CONCRETE, { tag: 'helipad' }));
  push(box([30, cy, -6.4], [44.4, cy + 1.1, -6], SURFACE.METAL, RAILING_OPTS));
  push(box([30, cy, 8], [44.4, cy + 1.1, 8.4], SURFACE.METAL, RAILING_OPTS));
  push(box([44, cy, -6.4], [44.4, cy + 1.1, 8.4], SURFACE.METAL, RAILING_OPTS));
  push(box([30, cy, 2], [30.4, cy + 1.1, 8.4], SURFACE.METAL, RAILING_OPTS));
  // Extraction-hold cover: AC units and a supply stack.
  push(box([33.0, cy, -4.4], [35.6, cy + 1.5, -2.2], SURFACE.METAL, { tag: 'ac_unit' }));
  push(box([39.4, cy, 3.6], [42.0, cy + 1.5, 5.8], SURFACE.METAL, { tag: 'ac_unit' }));
  push(box([40.6, cy, -4.6], [42.4, cy + 1.2, -3.0], SURFACE.WOOD, { tag: 'crate' }));
  push(box([32.2, cy, 4.4], [34.0, cy + 1.2, 6.2], SURFACE.WOOD, { tag: 'crate' }));

  // ===== YARD (below the catwalks — visual grounding, reachable only by falling) ===
  push(box([16, -1, -32], [46, 0, 30], SURFACE.CONCRETE, { tag: 'yard' }));

  return C;
}

// ---------------------------------------------------------------------------
// Navigation nodes
// ---------------------------------------------------------------------------

/** @type {{id:string,x:number,y:number,z:number,zone:string,cover?:boolean}[]} */
export const NAV_NODES = [
  // Dock / apron
  { id: 'dock_s', x: 0, y: 0, z: 54, zone: ZONES.DOCK },
  { id: 'dock_m', x: 0, y: 0, z: 46, zone: ZONES.DOCK },
  { id: 'dock_crate_w', x: -4.2, y: 0, z: 45, zone: ZONES.DOCK, cover: true },
  { id: 'dock_crate_e', x: 3.6, y: 0, z: 41.4, zone: ZONES.DOCK, cover: true },
  { id: 'dock_n', x: 0, y: 0, z: 36, zone: ZONES.DOCK },
  { id: 'apron_w', x: -10, y: 0, z: 31, zone: ZONES.APRON },
  { id: 'apron_c', x: 0, y: 0, z: 31, zone: ZONES.APRON },
  { id: 'apron_e', x: 12, y: 0, z: 31, zone: ZONES.APRON },
  { id: 'apron_cover_w', x: -6.2, y: 0, z: 28.9, zone: ZONES.APRON, cover: true },
  { id: 'apron_cover_e', x: 5.6, y: 0, z: 30.4, zone: ZONES.APRON, cover: true },
  { id: 'hall_door_s', x: 0, y: 0, z: 26.9, zone: ZONES.APRON },

  // Pump hall
  { id: 'hall_s', x: 0, y: 0, z: 24, zone: ZONES.PUMP_HALL },
  { id: 'hall_sw', x: -12, y: 0, z: 23, zone: ZONES.PUMP_HALL },
  { id: 'hall_se', x: 12.6, y: 0, z: 21.6, zone: ZONES.PUMP_HALL },
  { id: 'hall_crate_sw', x: -13.0, y: 0, z: 20.2, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_crate_se', x: 10.2, y: 0, z: 20.8, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_w1', x: -14.5, y: 0, z: 15, zone: ZONES.PUMP_HALL },
  { id: 'hall_e1', x: 10.5, y: 0, z: 15, zone: ZONES.PUMP_HALL },
  { id: 'hall_c', x: -5.6, y: 0, z: 13.5, zone: ZONES.PUMP_HALL },
  { id: 'hall_crate_c', x: -2.2, y: 0, z: 16.0, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_crate_e', x: 9.4, y: 0, z: 15.2, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_pump_nw', x: -13.0, y: 0, z: 8, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_pump_ne', x: 8.6, y: 0, z: 8, zone: ZONES.PUMP_HALL, cover: true },
  { id: 'hall_w2', x: -16, y: 0, z: 6, zone: ZONES.PUMP_HALL },
  { id: 'hall_n', x: -1, y: 0, z: 1.2, zone: ZONES.PUMP_HALL },
  { id: 'hall_nw', x: -14, y: 0, z: 1.5, zone: ZONES.PUMP_HALL },
  { id: 'hall_ne', x: 11, y: 0, z: 2, zone: ZONES.PUMP_HALL },
  { id: 'hall_breaker_w', x: -18.0, y: 0, z: 12, zone: ZONES.PUMP_HALL },
  { id: 'hall_breaker_e', x: 12.2, y: 0, z: 16, zone: ZONES.PUMP_HALL },
  { id: 'mezz_s', x: -17.2, y: 4.2, z: 19, zone: ZONES.PUMP_HALL },
  { id: 'mezz_n', x: -17.2, y: 4.2, z: 5, zone: ZONES.PUMP_HALL, cover: true },

  // Corridor
  { id: 'corr_s', x: -1, y: 0, z: -3.5, zone: ZONES.CORRIDOR },
  { id: 'corr_n', x: -1, y: 0, z: -14, zone: ZONES.CORRIDOR },

  // Server room
  { id: 'srv_s', x: 0.6, y: 0, z: -17.6, zone: ZONES.SERVER_ROOM },
  { id: 'srv_table', x: -1.0, y: 0, z: -17.9, zone: ZONES.SERVER_ROOM },
  { id: 'srv_aisle_1', x: -17.0, y: 0, z: -25.5, zone: ZONES.SERVER_ROOM },
  { id: 'srv_aisle_2', x: -11.8, y: 0, z: -25.5, zone: ZONES.SERVER_ROOM },
  { id: 'srv_aisle_3', x: -6.6, y: 0, z: -25.5, zone: ZONES.SERVER_ROOM },
  { id: 'srv_aisle_4', x: -1.4, y: 0, z: -25.5, zone: ZONES.SERVER_ROOM },
  { id: 'srv_rack_w', x: -20.4, y: 0, z: -29, zone: ZONES.SERVER_ROOM, cover: true },
  { id: 'srv_rack_c', x: -11.9, y: 0, z: -31, zone: ZONES.SERVER_ROOM, cover: true },
  { id: 'srv_rack_e', x: -1.5, y: 0, z: -31, zone: ZONES.SERVER_ROOM, cover: true },
  { id: 'srv_core', x: -10, y: 0, z: -32.6, zone: ZONES.SERVER_ROOM },
  { id: 'srv_n', x: -16, y: 0, z: -34.6, zone: ZONES.SERVER_ROOM },
  { id: 'srv_e', x: 4, y: 0, z: -27, zone: ZONES.SERVER_ROOM },

  // Stair tower
  { id: 'tower_base', x: 10.4, y: 0, z: -23, zone: ZONES.STAIR_TOWER },
  { id: 'tower_mid', x: 10.4, y: 3.2, z: -29.5, zone: ZONES.STAIR_TOWER },
  { id: 'tower_land', x: 15.4, y: 3.2, z: -30, zone: ZONES.STAIR_TOWER },
  { id: 'tower_f2', x: 15.4, y: 3.2, z: -28.0, zone: ZONES.STAIR_TOWER },
  { id: 'tower_up', x: 15.4, y: 5.26, z: -25.6, zone: ZONES.STAIR_TOWER },
  { id: 'tower_top', x: 15.8, y: CATWALK_Y, z: -23.4, zone: ZONES.STAIR_TOWER },

  // Catwalks
  { id: 'cw_a1', x: 21.6, y: CATWALK_Y, z: -22.0, zone: ZONES.CATWALK },
  { id: 'cw_a_cover', x: 22.2, y: CATWALK_Y, z: -22.2, zone: ZONES.CATWALK, cover: true },
  { id: 'cw_a2', x: 28, y: CATWALK_Y, z: -23, zone: ZONES.CATWALK },
  { id: 'cw_b1', x: 28, y: CATWALK_Y, z: -18, zone: ZONES.CATWALK },
  { id: 'cw_b_cover1', x: 28.2, y: CATWALK_Y, z: -13.4, zone: ZONES.CATWALK, cover: true },
  { id: 'cw_b2', x: 28, y: CATWALK_Y, z: -11, zone: ZONES.CATWALK },
  { id: 'cw_b_cover2', x: 27.2, y: CATWALK_Y, z: -6.6, zone: ZONES.CATWALK, cover: true },
  { id: 'cw_b3', x: 28, y: CATWALK_Y, z: -3, zone: ZONES.CATWALK },
  { id: 'cw_b4', x: 28, y: CATWALK_Y, z: 0.6, zone: ZONES.CATWALK },

  // Helipad
  { id: 'heli_w', x: 31.4, y: CATWALK_Y, z: 0, zone: ZONES.HELIPAD },
  { id: 'heli_nw', x: 32.4, y: CATWALK_Y, z: -4, zone: ZONES.HELIPAD },
  { id: 'heli_ac_w', x: 34.2, y: CATWALK_Y, z: -1.4, zone: ZONES.HELIPAD, cover: true },
  { id: 'heli_c', x: 37, y: CATWALK_Y, z: 1, zone: ZONES.HELIPAD },
  { id: 'heli_n', x: 37.5, y: CATWALK_Y, z: -4.6, zone: ZONES.HELIPAD },
  { id: 'heli_s', x: 36.0, y: CATWALK_Y, z: 6.4, zone: ZONES.HELIPAD },
  { id: 'heli_crate_s', x: 33.0, y: CATWALK_Y, z: 3.4, zone: ZONES.HELIPAD, cover: true },
  { id: 'heli_e', x: 42.4, y: CATWALK_Y, z: 1, zone: ZONES.HELIPAD },
  { id: 'heli_ac_e', x: 40.6, y: CATWALK_Y, z: 2.6, zone: ZONES.HELIPAD, cover: true },
  { id: 'heli_crate_e', x: 41.4, y: CATWALK_Y, z: -2.0, zone: ZONES.HELIPAD, cover: true },
];

/**
 * Explicit edges. Auto-connection by line of sight alone would happily link a
 * mezzanine node to a floor node it can see, so the graph is hand-authored where
 * traversal matters and only densified automatically inside open rooms.
 */
export const NAV_EDGES = [
  ['dock_s', 'dock_m'], ['dock_m', 'dock_crate_w'], ['dock_m', 'dock_crate_e'],
  ['dock_m', 'dock_n'], ['dock_crate_w', 'dock_n'], ['dock_crate_e', 'dock_n'],
  ['dock_n', 'apron_c'], ['apron_c', 'apron_w'], ['apron_c', 'apron_e'],
  ['apron_c', 'apron_cover_w'], ['apron_c', 'apron_cover_e'],
  ['apron_w', 'apron_cover_w'], ['apron_e', 'apron_cover_e'],
  ['apron_c', 'hall_door_s'], ['hall_door_s', 'hall_s'],

  ['hall_s', 'hall_sw'], ['hall_s', 'hall_se'], ['hall_s', 'hall_c'],
  ['hall_sw', 'hall_crate_sw'], ['hall_se', 'hall_crate_se'],
  ['hall_sw', 'hall_w1'], ['hall_se', 'hall_e1'],
  ['hall_crate_sw', 'hall_w1'], ['hall_crate_se', 'hall_e1'],
  ['hall_w1', 'hall_c'], ['hall_e1', 'hall_c'],
  ['hall_c', 'hall_crate_c'], ['hall_e1', 'hall_crate_e'],
  ['hall_w1', 'hall_breaker_w'], ['hall_e1', 'hall_breaker_e'],
  ['hall_w1', 'hall_w2'], ['hall_w2', 'hall_pump_nw'], ['hall_w2', 'hall_nw'],
  ['hall_e1', 'hall_pump_ne'], ['hall_pump_ne', 'hall_ne'],
  ['hall_c', 'hall_pump_nw'], ['hall_c', 'hall_pump_ne'],
  ['hall_pump_nw', 'hall_n'], ['hall_pump_ne', 'hall_n'],
  ['hall_nw', 'hall_n'], ['hall_ne', 'hall_n'],
  ['hall_sw', 'mezz_s'], ['mezz_s', 'mezz_n'], ['hall_breaker_w', 'hall_w1'],

  ['hall_n', 'corr_s'], ['corr_s', 'corr_n'], ['corr_n', 'srv_s'],
  ['srv_s', 'srv_table'], ['srv_s', 'srv_aisle_4'], ['srv_s', 'srv_aisle_3'],
  ['srv_aisle_1', 'srv_aisle_2'], ['srv_aisle_2', 'srv_aisle_3'],
  ['srv_aisle_3', 'srv_aisle_4'], ['srv_aisle_4', 'srv_e'],
  ['srv_aisle_1', 'srv_rack_w'], ['srv_aisle_2', 'srv_rack_c'],
  ['srv_aisle_4', 'srv_rack_e'], ['srv_rack_c', 'srv_core'],
  ['srv_aisle_2', 'srv_core'], ['srv_core', 'srv_n'], ['srv_n', 'srv_aisle_1'],
  ['srv_rack_e', 'srv_core'],

  ['srv_e', 'tower_base'], ['tower_base', 'tower_mid'], ['tower_mid', 'tower_land'],
  ['tower_land', 'tower_f2'], ['tower_f2', 'tower_up'], ['tower_up', 'tower_top'], ['tower_top', 'cw_a1'],

  ['cw_a1', 'cw_a_cover'], ['cw_a1', 'cw_a2'], ['cw_a_cover', 'cw_a2'],
  ['cw_a2', 'cw_b1'], ['cw_b1', 'cw_b_cover1'], ['cw_b_cover1', 'cw_b2'],
  ['cw_b1', 'cw_b2'], ['cw_b2', 'cw_b_cover2'], ['cw_b_cover2', 'cw_b3'],
  ['cw_b2', 'cw_b3'], ['cw_b3', 'cw_b4'], ['cw_b3', 'heli_nw'], ['cw_b4', 'heli_w'],

  ['heli_w', 'heli_nw'], ['heli_w', 'heli_c'], ['heli_nw', 'heli_ac_w'],
  ['heli_ac_w', 'heli_c'], ['heli_c', 'heli_n'], ['heli_c', 'heli_s'],
  ['heli_c', 'heli_e'], ['heli_s', 'heli_crate_s'], ['heli_crate_s', 'heli_w'],
  ['heli_e', 'heli_ac_e'], ['heli_ac_e', 'heli_c'], ['heli_e', 'heli_crate_e'],
  ['heli_crate_e', 'heli_n'], ['heli_n', 'heli_nw'], ['heli_s', 'heli_e'],
];

// ---------------------------------------------------------------------------
// Gameplay placements
// ---------------------------------------------------------------------------

// yaw 0 faces -Z (north, into the facility). Every checkpoint faces the next goal.
export const PLAYER_SPAWN = { x: 0, y: 0.05, z: 53, yaw: 0 };

export const CHECKPOINTS = [
  { id: 'cp_start', x: 0, y: 0.05, z: 53, yaw: 0, phase: 'approach' },
  { id: 'cp_hall', x: 0, y: 0.05, z: 24, yaw: 0, phase: 'pump_hall' },
  { id: 'cp_server', x: 0.6, y: 0.05, z: -17.6, yaw: 0, phase: 'server_room' },
  { id: 'cp_catwalk', x: 21.6, y: CATWALK_Y + 0.05, z: -22.0, yaw: -Math.PI / 2, phase: 'withdrawal' },
  { id: 'cp_helipad', x: 33, y: CATWALK_Y + 0.05, z: 1, yaw: -Math.PI / 2, phase: 'extraction' },
];

export const INTERACTABLES = [
  {
    id: 'breaker_w', kind: 'lever', label: 'Pull Breaker A',
    x: -19.4, y: 1.35, z: 12, yaw: Math.PI / 2, holdTime: 0,
    objective: 'obj_power', sound: 'breaker_pull',
  },
  {
    id: 'breaker_e', kind: 'lever', label: 'Pull Breaker B',
    x: 13.4, y: 1.35, z: 16, yaw: -Math.PI / 2, holdTime: 0,
    objective: 'obj_power', sound: 'breaker_pull',
  },
  {
    id: 'data_core', kind: 'core', label: 'Extract Data Core',
    x: -10, y: 1.25, z: -30, yaw: 0, holdTime: 4.0,
    objective: 'obj_core', sound: 'interact_complete',
  },
  {
    id: 'shotgun_pickup', kind: 'weapon', label: 'Take Breacher-12',
    x: -1.4, y: 0.85, z: -16.8, yaw: 0.6, holdTime: 0,
    grants: 'shotgun', sound: 'weapon_switch',
  },
];

/** Ammo and armour pickups placed along the critical path. */
export const PICKUPS = [
  { id: 'ammo_1', kind: 'ammo', x: -13.6, y: 0.4, z: 22.2, amount: 60 },
  { id: 'armor_1', kind: 'armor', x: 10.0, y: 0.4, z: 23.2, amount: 50 },
  { id: 'ammo_2', kind: 'ammo', x: -20.6, y: 0.4, z: -29.4, amount: 60 },
  { id: 'health_1', kind: 'health', x: 4.2, y: 0.4, z: -27.4, amount: 40 },
  { id: 'ammo_3', kind: 'ammo', x: 22.4, y: CATWALK_Y + 0.4, z: -23.8, amount: 60 },
  { id: 'armor_3', kind: 'armor', x: 26.6, y: CATWALK_Y + 0.4, z: -20.6, amount: 50 },
  { id: 'armor_2', kind: 'armor', x: 34.2, y: CATWALK_Y + 0.4, z: -3.4, amount: 50 },
  { id: 'health_2', kind: 'health', x: 41.4, y: CATWALK_Y + 0.4, z: 4.6, amount: 40 },
  { id: 'ammo_4', kind: 'ammo', x: 32.8, y: CATWALK_Y + 0.4, z: 5.6, amount: 60 },
];

/**
 * Enemy placements per beat. `beat` is the mission phase that activates them.
 * 18 total, at most 8 alive at once (enforced by the director).
 */
export const ENEMY_SPAWNS = [
  { id: 'e_dock_1', beat: 'approach', x: -10.5, y: 0, z: 31, yaw: Math.PI, patrol: ['apron_w', 'apron_c', 'apron_e'], alert: false },

  { id: 'e_hall_1', beat: 'pump_hall', x: -12, y: 0, z: 15, yaw: Math.PI, patrol: ['hall_w1', 'hall_w2', 'hall_pump_nw'], alert: false },
  { id: 'e_hall_2', beat: 'pump_hall', x: 11.8, y: 0, z: 15.5, yaw: Math.PI, patrol: ['hall_e1', 'hall_crate_e', 'hall_pump_ne'], alert: false },
  { id: 'e_hall_3', beat: 'pump_hall', x: -2, y: 0, z: 4, yaw: Math.PI, patrol: ['hall_n', 'hall_c'], alert: false },

  { id: 'e_srv_1', beat: 'server_room', x: -17, y: 0, z: -25.5, yaw: 0, patrol: ['srv_aisle_1', 'srv_aisle_2', 'srv_n'], alert: false },
  { id: 'e_srv_2', beat: 'server_room', x: -6.6, y: 0, z: -25.5, yaw: 0, patrol: ['srv_aisle_3', 'srv_aisle_4'], alert: false },
  { id: 'e_srv_3', beat: 'server_room', x: -10, y: 0, z: -33, yaw: 0, patrol: ['srv_core', 'srv_rack_c'], alert: false },

  { id: 'e_cw_1', beat: 'withdrawal', x: 28, y: CATWALK_Y, z: -11, yaw: -Math.PI / 2, patrol: ['cw_b2', 'cw_b1'], alert: true },
  { id: 'e_cw_2', beat: 'withdrawal', x: 28, y: CATWALK_Y, z: -3, yaw: -Math.PI / 2, patrol: ['cw_b3', 'cw_b_cover2'], alert: false },
  { id: 'e_cw_3', beat: 'withdrawal', x: 31.4, y: CATWALK_Y, z: 0, yaw: Math.PI, patrol: ['heli_w', 'cw_b4'], alert: false },
  { id: 'e_cw_4', beat: 'withdrawal', x: 10.4, y: 0, z: -23, yaw: 0, patrol: ['tower_base', 'srv_e'], alert: true },
  { id: 'e_cw_5', beat: 'withdrawal', x: 28.2, y: CATWALK_Y, z: -13.4, yaw: -Math.PI / 2, patrol: ['cw_b_cover1', 'cw_b2'], alert: true },

  { id: 'e_ex_1', beat: 'extraction', wave: 0, x: 28, y: CATWALK_Y, z: -11, yaw: 0, patrol: ['cw_b2', 'cw_b3'], alert: true },
  { id: 'e_ex_2', beat: 'extraction', wave: 0, x: 28, y: CATWALK_Y, z: -18, yaw: 0, patrol: ['cw_b1', 'cw_b2'], alert: true },
  { id: 'e_ex_3', beat: 'extraction', wave: 1, x: 28, y: CATWALK_Y, z: -23, yaw: 0, patrol: ['cw_a2', 'cw_b1'], alert: true },
  { id: 'e_ex_4', beat: 'extraction', wave: 1, x: 21.6, y: CATWALK_Y, z: -22.0, yaw: 0, patrol: ['cw_a1', 'cw_a2'], alert: true },
  { id: 'e_ex_5', beat: 'extraction', wave: 2, x: 28, y: CATWALK_Y, z: -18, yaw: 0, patrol: ['cw_b1', 'cw_b2'], alert: true },
  { id: 'e_ex_6', beat: 'extraction', wave: 2, x: 28, y: CATWALK_Y, z: -11, yaw: 0, patrol: ['cw_b2', 'cw_b3'], alert: true },
];

/**
 * Static lighting placements.
 *
 * Intensities are in Three's physical units with `decay: 2`, so a lamp's
 * contribution is `intensity / distance²`. A value of ~150 gives a readable pool
 * of light about 6 m below the fixture, which is the scale this facility is built
 * at. Tuning these as if they were legacy 0–1 values leaves every room black.
 */
export const LIGHTS = [
  { id: 'dock_mast_1', kind: 'lamp', x: -7.2, y: 5.2, z: 50, color: 0xffb15e, intensity: 130, distance: 26, mast: [0, -0.9, 0] },
  { id: 'dock_mast_2', kind: 'lamp', x: 7.2, y: 5.2, z: 40, color: 0xffb15e, intensity: 130, distance: 26, mast: [0, 0.9, 0] },
  { id: 'dock_mast_3', kind: 'lamp', x: -7.2, y: 5.2, z: 36, color: 0xffc27a, intensity: 110, distance: 22, mast: [0, -0.9, 0] },
  { id: 'apron_lamp', kind: 'lamp', x: 0, y: 5.6, z: 29.4, color: 0xffc27a, intensity: 190, distance: 30, shadow: true, mast: [0, 0, 1.1] },
  { id: 'apron_lamp_w', kind: 'lamp', x: -11, y: 5.2, z: 30, color: 0xffb15e, intensity: 120, distance: 22, mast: [0, -1.0, 0] },
  { id: 'apron_lamp_e', kind: 'lamp', x: 15, y: 5.2, z: 30, color: 0xffb15e, intensity: 120, distance: 22, mast: [0, 1.0, 0] },

  { id: 'hall_lamp_1', kind: 'lamp', x: -8, y: 7.6, z: 22, color: 0xd8e6ff, intensity: 340, distance: 34, shadow: true },
  { id: 'hall_lamp_2', kind: 'lamp', x: 6, y: 7.6, z: 13, color: 0xd8e6ff, intensity: 320, distance: 34 },
  { id: 'hall_lamp_3', kind: 'lamp', x: -10, y: 7.6, z: 4, color: 0xffcf9a, intensity: 260, distance: 30 },
  { id: 'hall_lamp_4', kind: 'lamp', x: 9, y: 7.6, z: 24, color: 0xffcf9a, intensity: 220, distance: 26 },
  { id: 'hall_lamp_5', kind: 'lamp', x: -17, y: 6.0, z: 12, color: 0xffc27a, intensity: 190, distance: 22 },
  { id: 'hall_lamp_6', kind: 'lamp', x: 12, y: 6.0, z: 16, color: 0xffc27a, intensity: 190, distance: 22 },

  { id: 'corr_lamp_1', kind: 'lamp', x: -1, y: 3.0, z: -5, color: 0xbcd2ff, intensity: 54, distance: 15 },
  { id: 'corr_lamp_2', kind: 'lamp', x: -1, y: 3.0, z: -13, color: 0xbcd2ff, intensity: 54, distance: 15 },

  { id: 'srv_lamp_1', kind: 'lamp', x: -14, y: 4.7, z: -21, color: 0x9fd8ff, intensity: 160, distance: 24, shadow: true },
  { id: 'srv_lamp_2', kind: 'lamp', x: -6, y: 4.7, z: -31, color: 0x9fd8ff, intensity: 150, distance: 24 },
  { id: 'srv_lamp_3', kind: 'lamp', x: -18, y: 4.7, z: -32, color: 0x9fd8ff, intensity: 130, distance: 22 },
  { id: 'srv_lamp_4', kind: 'lamp', x: 2, y: 4.7, z: -20, color: 0xbcd2ff, intensity: 110, distance: 20 },

  { id: 'tower_lamp', kind: 'lamp', x: 13, y: 7.6, z: -27, color: 0xffc27a, intensity: 220, distance: 26 },
  { id: 'tower_lamp_2', kind: 'lamp', x: 11, y: 3.4, z: -23, color: 0xffc27a, intensity: 62, distance: 15 },

  { id: 'cw_lamp_1', kind: 'lamp', x: 28, y: CATWALK_Y + 3.0, z: -19, color: 0xffb15e, intensity: 62, distance: 22, mast: [CATWALK_Y, 1.0, 0] },
  { id: 'cw_lamp_2', kind: 'lamp', x: 28, y: CATWALK_Y + 3.0, z: -6, color: 0xffb15e, intensity: 62, distance: 22, mast: [CATWALK_Y, 1.0, 0] },
  { id: 'cw_lamp_3', kind: 'lamp', x: 23, y: CATWALK_Y + 3.0, z: -23, color: 0xffb15e, intensity: 58, distance: 20, mast: [CATWALK_Y, -1.0, 0] },

  { id: 'heli_lamp', kind: 'lamp', x: 37, y: CATWALK_Y + 4.4, z: 1, color: 0xfff0d8, intensity: 130, distance: 34, shadow: true, mast: [CATWALK_Y, 0, 1.4] },
  { id: 'heli_lamp_w', kind: 'lamp', x: 32, y: CATWALK_Y + 2.6, z: -4, color: 0xffb15e, intensity: 48, distance: 18, mast: [CATWALK_Y, -1.0, 0] },
  { id: 'heli_lamp_e', kind: 'lamp', x: 42, y: CATWALK_Y + 2.6, z: 5, color: 0xffb15e, intensity: 48, distance: 18, mast: [CATWALK_Y, 1.0, 0] },

  { id: 'alarm_hall', kind: 'strobe', x: 0, y: 8.2, z: 14, color: 0xff2a18, intensity: 0, distance: 9 },
  { id: 'alarm_srv', kind: 'strobe', x: -10, y: 4.6, z: -26, color: 0xff2a18, intensity: 0, distance: 7 },
  { id: 'alarm_cw', kind: 'strobe', x: 28, y: CATWALK_Y + 2.4, z: -12, color: 0xff2a18, intensity: 0, distance: 8, mast: [CATWALK_Y, 0, 0] },
  { id: 'alarm_heli', kind: 'strobe', x: 37, y: CATWALK_Y + 3.2, z: -4, color: 0xff2a18, intensity: 0, distance: 9, mast: [CATWALK_Y, 0, 0] },
];

/** World bounds; anything outside is a fall-out and gets caught by the safety net. */
export const WORLD_BOUNDS = {
  min: { x: -30, y: -6, z: -46 },
  max: { x: 52, y: 30, z: 66 },
};
