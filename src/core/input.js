import { clamp } from './mathx.js';

/**
 * Actions the simulation consumes. Device state (keys, buttons, pointer deltas) is
 * translated into one of these command frames per fixed step, which means headless
 * tests can inject commands directly and exercise the identical code path.
 */
export function makeCommand() {
  return {
    moveX: 0,        // strafe, -1 left .. +1 right
    moveZ: 0,        // forward, -1 back .. +1 forward
    lookX: 0,        // yaw delta, radians, consumed this step
    lookY: 0,        // pitch delta, radians, consumed this step
    sprint: false,
    crouch: false,
    jump: false,         // edge
    jumpHeld: false,
    fire: false,         // held
    firePressed: false,  // edge
    aim: false,
    reload: false,       // edge
    interact: false,     // edge
    interactHeld: false,
    slot: -1,            // requested weapon slot, -1 = none
    nextWeapon: 0,       // wheel steps
  };
}

/**
 * Raw pointer movement to camera deltas in radians.
 *
 * Extracted so the sensitivity and invert-Y mapping can be asserted directly:
 * driving it through a real pointer-lock session is not something a headless test
 * can do faithfully, and the synthetic input path supplies radians that are
 * already transformed.
 */
export function lookDelta(movementX, movementY, settings, out = { x: 0, y: 0 }) {
  const sens = settings.sensitivity;
  out.x = -movementX * sens;
  out.y = -movementY * sens * (settings.invertY ? -1 : 1);
  return out;
}

const KEY_BINDS = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
  Space: 'jump',
  KeyR: 'reload',
  KeyE: 'interact',
  Digit1: 'slot1',
  Digit2: 'slot2',
};

export class Input {
  constructor(target, settings) {
    this.target = target;
    this.settings = settings;
    this.locked = false;
    this.synthetic = null; // when set, device input is ignored

    this.down = new Set();
    this.pressed = new Set();  // edge set, cleared each command build
    this.mouse = { left: false, right: false, leftEdge: false };
    this.pendingLook = { x: 0, y: 0 };
    this.wheel = 0;
    this.command = makeCommand();
    this._look = { x: 0, y: 0 };

    this.onPauseRequested = () => {};
    this.onLockChange = () => {};
    this._bound = [];
    this._attach();
  }

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this._bound.push([el, type, fn, opts]);
  }

  _attach() {
    this._on(window, 'keydown', (e) => {
      if (e.code === 'Escape') {
        this.onPauseRequested();
        return;
      }
      if (e.code === 'F3') {
        e.preventDefault();
        this.onDebugToggle?.();
        return;
      }
      if (!KEY_BINDS[e.code]) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });

    this._on(window, 'keyup', (e) => this.down.delete(e.code));

    this._on(window, 'blur', () => this.reset());

    // Mouse buttons only drive the weapon while the pointer is captured.
    //
    // Gating on the lock is what keeps the click that *acquires* the lock from
    // also firing the gun, and keeps clicks on the menu, the pause screen and the
    // focus prompt out of the simulation. It replaces an `enabled` flag that was
    // initialised to false and never assigned anywhere in the codebase, which
    // meant this handler returned on its first line for every real player: fire
    // and aim were dead on hardware for the whole build. Every automated test
    // installs a synthetic command frame, which returns from `buildCommand()`
    // before it reads `this.mouse` at all, so nothing caught it. See
    // tests/unit/input.test.js and the "real mouse" e2e spec.
    this._on(this.target, 'mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) {
        if (!this.mouse.left) this.mouse.leftEdge = true;
        this.mouse.left = true;
      }
      if (e.button === 2) this.mouse.right = true;
    });

    this._on(window, 'mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });

    this._on(this.target, 'contextmenu', (e) => e.preventDefault());

    this._on(window, 'mousemove', (e) => {
      if (!this.locked) return;
      this.pendingLook.x += e.movementX || 0;
      this.pendingLook.y += e.movementY || 0;
    });

    this._on(
      this.target,
      'wheel',
      (e) => {
        if (!this.locked) return;
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: false },
    );

    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.reset();
      this.onLockChange(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
    const r = this.target.requestPointerLock?.();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }

  releaseLock() {
    if (document.pointerLockElement === this.target) document.exitPointerLock?.();
  }

  reset() {
    this.down.clear();
    this.pressed.clear();
    this.mouse.left = this.mouse.right = this.mouse.leftEdge = false;
    this.pendingLook.x = this.pendingLook.y = 0;
    this.wheel = 0;
  }

  /**
   * Inject a synthetic command for headless play. The frame *replaces* the previous
   * one rather than merging into it: merging means a later `{fire:true}` silently
   * inherits an earlier `{moveZ:1}` and the test walks somewhere it never asked to
   * go. Held state persists across steps because the same frame stays installed
   * until the next call.
   *
   * Look deltas are in radians and are consumed by exactly one command build.
   */
  setSynthetic(frame) {
    if (frame === null) {
      this.synthetic = null;
      return;
    }
    this.synthetic = { ...makeCommand(), ...frame };
  }

  _has(action) {
    for (const code in KEY_BINDS) {
      if (KEY_BINDS[code] === action && this.down.has(code)) return true;
    }
    return false;
  }

  _pressed(action) {
    for (const code of this.pressed) {
      if (KEY_BINDS[code] === action) return true;
    }
    return false;
  }

  /** Build the command for one fixed step; consumes all edges and look deltas. */
  buildCommand() {
    const c = this.command;

    if (this.synthetic) {
      const s = this.synthetic;
      c.moveX = clamp(s.moveX || 0, -1, 1);
      c.moveZ = clamp(s.moveZ || 0, -1, 1);
      c.lookX = s.lookX || 0;
      c.lookY = s.lookY || 0;
      c.sprint = !!s.sprint;
      c.crouch = !!s.crouch;
      c.jump = !!s.jump;
      c.jumpHeld = !!s.jump;
      c.fire = !!s.fire;
      c.firePressed = !!s.firePressed || (!!s.fire && !this._prevSynthFire);
      c.aim = !!s.aim;
      c.reload = !!s.reload;
      c.interact = !!s.interact;
      c.interactHeld = !!s.interactHeld || !!s.interact;
      c.slot = s.slot === undefined ? -1 : s.slot;
      c.nextWeapon = s.nextWeapon || 0;
      this._prevSynthFire = !!s.fire;
      // One-shot fields do not persist across steps.
      s.lookX = 0;
      s.lookY = 0;
      s.jump = false;
      s.reload = false;
      s.interact = false;
      s.firePressed = false;
      s.slot = -1;
      s.nextWeapon = 0;
      return c;
    }

    c.moveX = (this._has('right') ? 1 : 0) - (this._has('left') ? 1 : 0);
    c.moveZ = (this._has('fwd') ? 1 : 0) - (this._has('back') ? 1 : 0);
    lookDelta(this.pendingLook.x, this.pendingLook.y, this.settings, this._look);
    c.lookX = this._look.x;
    c.lookY = this._look.y;
    c.sprint = this._has('sprint');
    c.crouch = this._has('crouch');
    c.jump = this._pressed('jump');
    c.jumpHeld = this._has('jump');
    c.fire = this.mouse.left;
    c.firePressed = this.mouse.leftEdge;
    c.aim = this.mouse.right;
    c.reload = this._pressed('reload');
    c.interact = this._pressed('interact');
    c.interactHeld = this._has('interact');
    c.slot = this._pressed('slot1') ? 0 : this._pressed('slot2') ? 1 : -1;
    c.nextWeapon = this.wheel;

    this.pendingLook.x = this.pendingLook.y = 0;
    this.wheel = 0;
    this.mouse.leftEdge = false;
    this.pressed.clear();
    return c;
  }

  dispose() {
    for (const [el, type, fn, opts] of this._bound) el.removeEventListener(type, fn, opts);
    this._bound.length = 0;
  }
}
