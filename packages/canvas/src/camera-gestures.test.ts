import { describe, expect, it, vi } from 'vitest';
import {
  classifyWheelGesture,
  createPanDragController,
  MIDDLE_MOUSE_BUTTON,
  type WheelEventLike,
} from './camera-gestures.js';
import { shiftPanDelta } from './wheel-gesture.js';

function wheelEvent(overrides: Partial<WheelEventLike>): WheelEventLike {
  return {
    deltaX: 0,
    deltaY: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    clientX: 0,
    clientY: 0,
    ...overrides,
  };
}

describe('classifyWheelGesture', () => {
  describe('plain wheel (no modifiers) -> vertical pan', () => {
    it('scrolling down (positive deltaY) pans dy negative (content moves up)', () => {
      expect(classifyWheelGesture(wheelEvent({ deltaY: 100 }))).toEqual({ type: 'pan', dx: 0, dy: -100 });
    });

    it('scrolling up (negative deltaY) pans dy positive', () => {
      expect(classifyWheelGesture(wheelEvent({ deltaY: -50 }))).toEqual({ type: 'pan', dx: 0, dy: 50 });
    });

    it('deltaX is ignored for a plain wheel event (vertical-only pan per this workstream brief)', () => {
      expect(classifyWheelGesture(wheelEvent({ deltaX: 30, deltaY: 10 }))).toEqual({ type: 'pan', dx: 0, dy: -10 });
    });
  });

  describe('shift+wheel -> horizontal pan via shiftPanDelta', () => {
    it('matches shiftPanDelta directly when deltaX is 0 (remaps deltaY -> x)', () => {
      const result = classifyWheelGesture(wheelEvent({ shiftKey: true, deltaY: 80 }));
      const expected = shiftPanDelta(0, 80);
      expect(result).toEqual({ type: 'pan', dx: -expected.x, dy: -expected.y });
      expect(result).toEqual({ type: 'pan', dx: -80, dy: -0 });
    });

    it('prefers a real deltaX when the platform already reports one (macOS convention)', () => {
      const result = classifyWheelGesture(wheelEvent({ shiftKey: true, deltaX: 40, deltaY: 999 }));
      expect(result).toEqual({ type: 'pan', dx: -40, dy: -0 });
    });

    it('shift is ignored once a zoom modifier is also held (ctrl/meta takes priority)', () => {
      const result = classifyWheelGesture(wheelEvent({ shiftKey: true, ctrlKey: true, deltaY: 10 }));
      expect(result.type).toBe('zoom');
    });
  });

  describe('ctrl/meta+wheel -> zoom at cursor', () => {
    it('positive deltaY (scroll/pinch out) shrinks the zoom factor below 1', () => {
      // deltaY = 5 is well within the default clamp (10), so it passes
      // through unclamped: deltaZ = 5/100, factor = 1 - deltaZ.
      const result = classifyWheelGesture(wheelEvent({ ctrlKey: true, deltaY: 5, clientX: 10, clientY: 20 }));
      expect(result).toEqual({ type: 'zoom', factor: 1 - 5 / 100, point: { x: 10, y: 20 } });
    });

    it('negative deltaY (scroll/pinch in) grows the zoom factor above 1', () => {
      const result = classifyWheelGesture(wheelEvent({ metaKey: true, deltaY: -5 }));
      expect(result.type).toBe('zoom');
      if (result.type === 'zoom') expect(result.factor).toBeCloseTo(1.05, 10);
    });

    it('clamps an extreme deltaY to the configured zoomDeltaClamp before applying it', () => {
      const result = classifyWheelGesture(wheelEvent({ ctrlKey: true, deltaY: 500 }));
      expect(result).toEqual({ type: 'zoom', factor: 1 - 10 / 100, point: { x: 0, y: 0 } });
    });

    it('a negative extreme deltaY clamps symmetrically', () => {
      const result = classifyWheelGesture(wheelEvent({ ctrlKey: true, deltaY: -500 }));
      expect(result.type).toBe('zoom');
      if (result.type === 'zoom') expect(result.factor).toBeCloseTo(1.1, 10);
    });

    it('respects a custom zoomDeltaClamp option', () => {
      const result = classifyWheelGesture(wheelEvent({ ctrlKey: true, deltaY: 500 }), { zoomDeltaClamp: 20 });
      expect(result).toEqual({ type: 'zoom', factor: 1 - 20 / 100, point: { x: 0, y: 0 } });
    });

    it('metaKey alone (no ctrlKey) also triggers zoom', () => {
      expect(classifyWheelGesture(wheelEvent({ metaKey: true, deltaY: 10 })).type).toBe('zoom');
    });

    it('carries the client point through unchanged', () => {
      const result = classifyWheelGesture(wheelEvent({ ctrlKey: true, deltaY: 1, clientX: 321, clientY: 654 }));
      expect(result).toEqual({ type: 'zoom', factor: 1 - 1 / 100, point: { x: 321, y: 654 } });
    });
  });
});

describe('createPanDragController', () => {
  function pointer(overrides: Partial<{ pointerId: number; button: number; clientX: number; clientY: number }>) {
    return { pointerId: 1, button: 0, clientX: 0, clientY: 0, ...overrides };
  }

  it('does not start a drag on a plain left-click with space not held', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => false });
    const started = controller.onPointerDown(pointer({ button: 0 }));
    expect(started).toBe(false);
    expect(controller.isDragging()).toBe(false);
  });

  it('starts a drag on left-click when space is held', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });
    const started = controller.onPointerDown(pointer({ button: 0, clientX: 100, clientY: 100 }));
    expect(started).toBe(true);
    expect(controller.isDragging()).toBe(true);
  });

  it('always starts a drag on the middle mouse button, regardless of space state', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => false });
    const started = controller.onPointerDown(pointer({ button: MIDDLE_MOUSE_BUTTON }));
    expect(started).toBe(true);
  });

  it('ignores the right mouse button', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });
    // Space held only matters for button 0 per this controller's contract;
    // a right-click (button 2) should never start a pan-drag.
    const started = controller.onPointerDown(pointer({ button: 2 }));
    expect(started).toBe(false);
  });

  it('full start/move/end sequence calls onPan with the raw screen delta between moves', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });

    controller.onPointerDown(pointer({ pointerId: 5, button: 0, clientX: 100, clientY: 200 }));
    controller.onPointerMove(pointer({ pointerId: 5, clientX: 130, clientY: 190 }));
    expect(onPan).toHaveBeenCalledWith(30, -10);

    controller.onPointerMove(pointer({ pointerId: 5, clientX: 150, clientY: 190 }));
    expect(onPan).toHaveBeenLastCalledWith(20, 0);

    controller.onPointerUp(pointer({ pointerId: 5 }));
    expect(controller.isDragging()).toBe(false);
    expect(onPan).toHaveBeenCalledTimes(2);
  });

  it('a pointer-move with no net delta does not call onPan', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });
    controller.onPointerDown(pointer({ pointerId: 1, clientX: 50, clientY: 50 }));
    controller.onPointerMove(pointer({ pointerId: 1, clientX: 50, clientY: 50 }));
    expect(onPan).not.toHaveBeenCalled();
  });

  it('ignores a pointer-move from a different pointerId than the one dragging (multi-touch)', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });
    controller.onPointerDown(pointer({ pointerId: 1, clientX: 0, clientY: 0 }));
    controller.onPointerMove(pointer({ pointerId: 2, clientX: 100, clientY: 100 }));
    expect(onPan).not.toHaveBeenCalled();
  });

  it('onPointerMove before any drag started is a no-op', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan });
    controller.onPointerMove(pointer({ clientX: 10, clientY: 10 }));
    expect(onPan).not.toHaveBeenCalled();
    expect(controller.isDragging()).toBe(false);
  });

  it('onPointerUp with a mismatched pointerId does not end an active drag', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan, isSpaceHeld: () => true });
    controller.onPointerDown(pointer({ pointerId: 1 }));
    controller.onPointerUp(pointer({ pointerId: 2 }));
    expect(controller.isDragging()).toBe(true);
  });

  it('defaults isSpaceHeld to false when omitted (only middle-drag works)', () => {
    const onPan = vi.fn();
    const controller = createPanDragController({ onPan });
    expect(controller.onPointerDown(pointer({ button: 0 }))).toBe(false);
    expect(controller.onPointerDown(pointer({ button: MIDDLE_MOUSE_BUTTON }))).toBe(true);
  });
});
