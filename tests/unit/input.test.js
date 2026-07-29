/**
 * Device input path.
 *
 * The suite used to cover only `lookDelta()` and `makeCommand()` — the two pure
 * functions in the module — while every other test drove the game through
 * `setSynthetic()`. `buildCommand()` returns on its first branch when a synthetic
 * frame is installed, so the keyboard and mouse translation below had no coverage
 * at all, and a `mousedown` handler that returned unconditionally shipped as a
 * result. These tests exercise the same path a player's hardware does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Input } from '../../src/core/input.js';

const SETTINGS = { sensitivity: 0.002, invertY: false };

/**
 * Minimal DOM stand-in: `window`, `document` and the canvas are EventTargets, and
 * `document.pointerLockElement` is writable so lock transitions can be driven.
 */
function makeDom() {
  const target = new EventTarget();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  target.requestPointerLock = () => {
    doc.pointerLockElement = target;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  globalThis.window = win;
  globalThis.document = doc;
  return { target, win, doc };
}

/** Dispatch an event with extra properties the handlers read off it. */
function fire(el, type, props = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
  return e;
}

describe('Input — device path', () => {
  let dom;
  let input;

  beforeEach(() => {
    dom = makeDom();
    input = new Input(dom.target, { ...SETTINGS });
  });

  afterEach(() => {
    input.dispose();
    delete globalThis.window;
    delete globalThis.document;
  });

  const lock = () => {
    dom.target.requestPointerLock();
    expect(input.locked).toBe(true);
  };

  describe('mouse buttons', () => {
    it('left button held sets fire, and the first frame carries the press edge', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 0 });

      const first = input.buildCommand();
      expect(first.fire, 'left mouse must hold fire').toBe(true);
      expect(first.firePressed, 'the first frame is the press edge').toBe(true);

      const second = input.buildCommand();
      expect(second.fire, 'fire stays held while the button is down').toBe(true);
      expect(second.firePressed, 'the edge is consumed by one frame').toBe(false);
    });

    it('releasing the left button clears fire', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 0 });
      input.buildCommand();
      fire(dom.win, 'mouseup', { button: 0 });
      expect(input.buildCommand().fire).toBe(false);
    });

    it('right button sets aim and releasing clears it', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 2 });
      expect(input.buildCommand().aim, 'right mouse must set aim').toBe(true);
      fire(dom.win, 'mouseup', { button: 2 });
      expect(input.buildCommand().aim).toBe(false);
    });

    it('the middle button drives nothing', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 1 });
      const c = input.buildCommand();
      expect(c.fire).toBe(false);
      expect(c.aim).toBe(false);
    });

    // The regression that motivated this file: fire and aim were unreachable with
    // a real mouse because the handler was gated on a flag nothing ever set.
    it('does not silently drop every button press', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 0 });
      fire(dom.target, 'mousedown', { button: 2 });
      const c = input.buildCommand();
      expect(
        c.fire && c.aim,
        'left and right mouse produced no command — the device path is dead',
      ).toBe(true);
    });
  });

  describe('pointer lock gating', () => {
    it('ignores buttons while the pointer is not captured', () => {
      fire(dom.target, 'mousedown', { button: 0 });
      fire(dom.target, 'mousedown', { button: 2 });
      const c = input.buildCommand();
      expect(c.fire, 'an unlocked click belongs to the UI, not the weapon').toBe(false);
      expect(c.aim).toBe(false);
    });

    it('the click that acquires the lock does not also fire', () => {
      // mousedown arrives first, the lock is granted on the click that follows.
      fire(dom.target, 'mousedown', { button: 0 });
      dom.target.requestPointerLock();
      expect(input.buildCommand().fire, 'deploying must not discharge the weapon').toBe(false);
    });

    it('losing the lock clears held buttons and movement', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 0 });
      fire(dom.win, 'keydown', { code: 'KeyW' });
      expect(input.buildCommand().fire).toBe(true);

      dom.doc.exitPointerLock();
      const c = input.buildCommand();
      expect(c.fire, 'alt-tabbing must not leave the trigger held').toBe(false);
      expect(c.moveZ, 'alt-tabbing must not leave the player walking').toBe(0);
    });

    it('reports lock transitions to its owner', () => {
      const seen = [];
      input.onLockChange = (v) => seen.push(v);
      dom.target.requestPointerLock();
      dom.doc.exitPointerLock();
      expect(seen).toEqual([true, false]);
    });
  });

  describe('mouse look', () => {
    it('accumulates movement only while locked and consumes it in one frame', () => {
      fire(dom.win, 'mousemove', { movementX: 100, movementY: 0 });
      expect(input.buildCommand().lookX, 'unlocked movement must not turn the camera')
        .toBeCloseTo(0, 12);

      lock();
      fire(dom.win, 'mousemove', { movementX: 50, movementY: 0 });
      fire(dom.win, 'mousemove', { movementX: 50, movementY: 0 });
      expect(input.buildCommand().lookX).toBeCloseTo(-0.2, 9);
      expect(input.buildCommand().lookX, 'look deltas do not persist').toBeCloseTo(0, 12);
    });

    it('honours invert-Y', () => {
      lock();
      fire(dom.win, 'mousemove', { movementX: 0, movementY: 100 });
      const normal = input.buildCommand().lookY;
      input.settings.invertY = true;
      fire(dom.win, 'mousemove', { movementX: 0, movementY: 100 });
      expect(input.buildCommand().lookY).toBeCloseTo(-normal, 9);
    });

    it('suppresses the browser context menu so right-click can aim', () => {
      const e = fire(dom.target, 'contextmenu', {});
      expect(e.defaultPrevented, 'the context menu would eat every ADS press').toBe(true);
    });
  });

  describe('keyboard', () => {
    it('maps WASD and the arrow keys to the same axes', () => {
      fire(dom.win, 'keydown', { code: 'KeyW' });
      fire(dom.win, 'keydown', { code: 'KeyD' });
      let c = input.buildCommand();
      expect([c.moveZ, c.moveX]).toEqual([1, 1]);

      input.reset();
      fire(dom.win, 'keydown', { code: 'ArrowDown' });
      fire(dom.win, 'keydown', { code: 'ArrowLeft' });
      c = input.buildCommand();
      expect([c.moveZ, c.moveX]).toEqual([-1, -1]);
    });

    it('opposed keys cancel rather than sticking', () => {
      fire(dom.win, 'keydown', { code: 'KeyW' });
      fire(dom.win, 'keydown', { code: 'KeyS' });
      expect(input.buildCommand().moveZ).toBe(0);
    });

    it('jump, reload, interact and slots are edges; sprint and crouch are held', () => {
      fire(dom.win, 'keydown', { code: 'Space' });
      fire(dom.win, 'keydown', { code: 'KeyR' });
      fire(dom.win, 'keydown', { code: 'KeyE' });
      fire(dom.win, 'keydown', { code: 'Digit2' });
      fire(dom.win, 'keydown', { code: 'ShiftLeft' });
      fire(dom.win, 'keydown', { code: 'ControlLeft' });

      const first = input.buildCommand();
      expect(first.jump).toBe(true);
      expect(first.reload).toBe(true);
      expect(first.interact).toBe(true);
      expect(first.slot).toBe(1);
      expect(first.sprint).toBe(true);
      expect(first.crouch).toBe(true);

      const second = input.buildCommand();
      expect(second.jump, 'holding space must not re-trigger the jump').toBe(false);
      expect(second.reload).toBe(false);
      expect(second.interact).toBe(false);
      expect(second.slot).toBe(-1);
      expect(second.jumpHeld, 'the held form survives').toBe(true);
      expect(second.interactHeld, 'holding E must survive for the data core').toBe(true);
      expect(second.sprint).toBe(true);
      expect(second.crouch).toBe(true);
    });

    it('a key repeat does not produce a second press edge', () => {
      fire(dom.win, 'keydown', { code: 'Space' });
      expect(input.buildCommand().jump).toBe(true);
      fire(dom.win, 'keydown', { code: 'Space' }); // autorepeat, no keyup between
      expect(input.buildCommand().jump).toBe(false);
    });

    it('Escape asks for pause and F3 toggles the overlay', () => {
      let paused = 0;
      let debug = 0;
      input.onPauseRequested = () => paused++;
      input.onDebugToggle = () => debug++;
      fire(dom.win, 'keydown', { code: 'Escape' });
      fire(dom.win, 'keydown', { code: 'F3' });
      expect([paused, debug]).toEqual([1, 1]);
    });

    it('losing window focus releases everything', () => {
      fire(dom.win, 'keydown', { code: 'KeyW' });
      fire(dom.win, 'blur', {});
      expect(input.buildCommand().moveZ).toBe(0);
    });
  });

  describe('weapon wheel', () => {
    it('accumulates wheel steps while locked and consumes them in one frame', () => {
      lock();
      fire(dom.target, 'wheel', { deltaY: 120 });
      fire(dom.target, 'wheel', { deltaY: 120 });
      expect(input.buildCommand().nextWeapon).toBe(2);
      expect(input.buildCommand().nextWeapon).toBe(0);
    });

    it('ignores the wheel while unlocked so the page can scroll', () => {
      fire(dom.target, 'wheel', { deltaY: 120 });
      expect(input.buildCommand().nextWeapon).toBe(0);
    });
  });

  describe('synthetic override', () => {
    it('a synthetic frame wins over live hardware, and clearing it hands control back', () => {
      lock();
      fire(dom.target, 'mousedown', { button: 0 });
      input.setSynthetic({ moveZ: 1 });
      const c = input.buildCommand();
      expect(c.moveZ).toBe(1);
      expect(c.fire, 'headless play must not inherit the physical mouse').toBe(false);

      input.setSynthetic(null);
      expect(input.buildCommand().fire, 'the button is still physically down').toBe(true);
    });
  });

  describe('dispose', () => {
    it('detaches every listener', () => {
      lock();
      input.dispose();
      fire(dom.target, 'mousedown', { button: 0 });
      fire(dom.win, 'keydown', { code: 'KeyW' });
      const c = input.buildCommand();
      expect(c.fire).toBe(false);
      expect(c.moveZ).toBe(0);
    });
  });
});
