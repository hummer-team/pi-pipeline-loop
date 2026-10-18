/**
 * Unit tests for the shared pi event bus accessor (203_Bug Phase 0).
 * Covers: missing `events`, throwing `emit`, valid `emit`/`on` presence.
 */
import { describe, it, expect } from 'bun:test';
import { getEventBus, hasEventBus, type EventBus } from '../../utils/pi-event-bus';

describe('pi-event-bus (203_Bug Phase 0)', () => {
  describe('hasEventBus', () => {
    it('returns false for null/undefined/empty pi', () => {
      expect(hasEventBus(null)).toBe(false);
      expect(hasEventBus(undefined)).toBe(false);
      expect(hasEventBus({})).toBe(false);
    });

    it('returns false when events is not an object', () => {
      expect(hasEventBus({ events: 'not-an-object' })).toBe(false);
      expect(hasEventBus({ events: 42 })).toBe(false);
    });

    it('returns false when emit or on is missing (no `on` case)', () => {
      expect(hasEventBus({ events: { emit: () => {} } })).toBe(false);
      expect(hasEventBus({ events: { on: () => {} } })).toBe(false);
    });

    it('returns true for a structural EventBus (emit + on present)', () => {
      const bus: EventBus = {
        emit: () => {},
        on: () => {},
      };
      expect(hasEventBus({ events: bus })).toBe(true);
    });
  });

  describe('getEventBus', () => {
    it('returns null when the bus is unavailable', () => {
      expect(getEventBus(null)).toBeNull();
      expect(getEventBus(undefined)).toBeNull();
      expect(getEventBus({})).toBeNull();
      expect(getEventBus({ events: {} })).toBeNull();
    });

    it('returns the bus without invoking emit (emit throwing is irrelevant to access)', () => {
      const bus: EventBus = {
        emit: () => {
          throw new Error('emit must not be called by the accessor');
        },
        on: () => {},
      };
      const pi = { events: bus };
      // Accessing the bus must not invoke any bus method (fail-safe accessor)
      expect(getEventBus(pi)).toBe(bus);
    });

    it('returns the same bus instance on repeated access', () => {
      const bus: EventBus = {
        emit: () => {},
        on: () => {},
        off: () => {},
      };
      const pi = { events: bus };
      expect(getEventBus(pi)).toBe(bus);
      expect(getEventBus(pi)).toBe(getEventBus(pi));
    });
  });
});
