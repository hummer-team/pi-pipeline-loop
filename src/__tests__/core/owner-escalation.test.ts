/**
 * Unit tests for owner escalation wake (203_Bug Phase 0 / RC1).
 * Covers:
 * - child freeze with mock pi.events → one escalation broadcast + audit
 * - owner listener wake predicates (pending flag, blocked state, id match)
 * - idempotence: consumed flag ⇒ repeated broadcasts do not re-wake
 * - pipelineId mismatch / non-blocked / stage mismatch ⇒ skipped
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { freezeAndPrompt } from '../../core/flow-state';
import {
  setOwnerEscalationDeps,
  registerOwnerEscalationObserver,
  type OwnerEscalationDeps,
} from '../../core/owner-escalation';
import { PIPELINE_ESCALATION_EVENT, type EscalationPayload } from '../../utils/escalation-bus';
import { makeTestConfig, makeTestMeta } from '../helpers';
import type { SessionMeta } from '../../types';

/** Creates a mock pi object with a capture event bus. */
function makeMockPi() {
  const listeners: Map<string, Array<(payload: unknown) => void>> = new Map();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emitted,
    pi: {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => {
          emitted.push({ event, payload });
        },
        on: (event: string, handler: (payload: unknown) => void) => {
          const arr = listeners.get(event) ?? [];
          arr.push(handler);
          listeners.set(event, arr);
          return () => {};
        },
      },
    },
    fire: (event: string, payload: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}

describe('owner-escalation (203_Bug Phase 0 / RC1)', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    setOwnerEscalationDeps(null);
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
  });

  describe('child freeze broadcast', () => {
    it('freezing a child with a pi bus broadcasts exactly once and audits menu_escalation_broadcast', async () => {
      const { pi, emitted } = makeMockPi();
      const meta = makeTestMeta({ flowState: 'running' });
      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const ctx = {
        session: {
          getMeta: () => meta,
          updateMeta: (patch: Partial<SessionMeta>) => {
            Object.assign(meta, patch);
            return meta;
          },
        },
        ui: { notify: () => {} },
        _ctx: {
          sessionManager: {
            getHeader: () => ({ parentSession: '/tmp/parent.jsonl' }),
            getSessionName: () => 'child-session-12345678',
            getSessionFile: () => '/tmp/child.jsonl',
          },
        },
        pi,
      } as any;

      await freezeAndPrompt(ctx, meta, 'max_loop_cycles', makeTestConfig());

      const escalations = emitted.filter((e) => e.event === PIPELINE_ESCALATION_EVENT);
      expect(escalations).toHaveLength(1);
      expect(escalations[0].payload).toMatchObject({
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        reason: 'max_loop_cycles',
      });
    });

    it('freezing with no pi bus is fail-safe (no throw, no broadcast audit)', async () => {
      const meta = makeTestMeta({ flowState: 'running' });
      const ctx = {
        session: {
          getMeta: () => meta,
          updateMeta: (patch: Partial<SessionMeta>) => {
            Object.assign(meta, patch);
            return meta;
          },
        },
        ui: { notify: () => {} },
        _ctx: {
          sessionManager: {
            getHeader: () => ({ parentSession: '/tmp/parent.jsonl' }),
            getSessionName: () => 'child-session-12345678',
            getSessionFile: () => '/tmp/child.jsonl',
          },
        },
        // no pi at all
      } as any;

      // Must not throw even without an event bus
      await expect(
        freezeAndPrompt(ctx, meta, 'max_loop_cycles', makeTestConfig()),
      ).resolves.toBeUndefined();
      expect(meta.menuEscalationPending).toBe(true);
    });
  });

  describe('owner wake predicates', () => {
    const basePayload = (over: Partial<EscalationPayload> = {}): EscalationPayload => ({
      pipelineId: 'pipe-1',
      stage: 'develop',
      reason: 'max_loop_cycles',
      at: Date.now(),
      ...over,
    });

    function blockedMeta(over: Partial<SessionMeta> = {}): SessionMeta {
      return makeTestMeta({
        flowState: 'blocked',
        blockedReason: 'max_loop_cycles',
        menuEscalationPending: true,
        currentStage: 'develop',
        pipelineId: 'pipe-1',
        ...over,
      });
    }

    function makeDeps(meta: SessionMeta | undefined) {
      const calls = {
        followUps: [] as string[],
        statusBars: 0,
        audits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
      };
      const deps: OwnerEscalationDeps = {
        getMeta: () => meta,
        sendFollowUp: (summary) => { calls.followUps.push(summary); },
        syncStatusBar: () => { calls.statusBars++; },
        audit: (event, payload) => { calls.audits.push({ event, payload }); },
      };
      return { calls, deps };
    }

    it('listener wiring: broadcast → followUp once; consumed flag ⇒ repeat no-wake', () => {
      const mock = makeMockPi();
      const meta = blockedMeta();
      const { calls, deps } = makeDeps(meta);

      setOwnerEscalationDeps(deps);
      const unobserve = registerOwnerEscalationObserver(mock.pi);
      cleanup = unobserve;

      // First broadcast → wake
      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());
      expect(calls.followUps).toHaveLength(1);
      expect(calls.followUps[0]).toContain('develop');
      expect(calls.statusBars).toBe(1);
      const wakeAudit = calls.audits.find((a) => a.event === 'owner_wake_escalation');
      expect(wakeAudit).toBeDefined();
      expect(wakeAudit?.payload.stage).toBe('develop');

      // Owner consumes the flag (agent_settled consumption) → flag false
      meta.menuEscalationPending = false;

      // Repeated broadcast no longer wakes
      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());
      expect(calls.followUps).toHaveLength(1);
    });

    it('pipelineId mismatch ⇒ skipped', () => {
      const meta = blockedMeta({ pipelineId: 'pipe-other' });
      const { calls, deps } = makeDeps(meta);
      setOwnerEscalationDeps(deps);
      const mock = makeMockPi();
      cleanup = registerOwnerEscalationObserver(mock.pi);

      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());

      expect(calls.followUps).toHaveLength(0);
      expect(calls.audits.some((a) => a.event === 'owner_wake_escalation_skipped')).toBe(true);
    });

    it('non-blocked (running) ⇒ skipped', () => {
      const meta = blockedMeta({ flowState: 'running' });
      const { calls, deps } = makeDeps(meta);
      setOwnerEscalationDeps(deps);
      const mock = makeMockPi();
      cleanup = registerOwnerEscalationObserver(mock.pi);

      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());

      expect(calls.followUps).toHaveLength(0);
      expect(calls.audits.some((a) => a.event === 'owner_wake_escalation_skipped')).toBe(true);
    });

    it('stage mismatch ⇒ skipped', () => {
      const meta = blockedMeta({ currentStage: 'review' });
      const { calls, deps } = makeDeps(meta);
      setOwnerEscalationDeps(deps);
      const mock = makeMockPi();
      cleanup = registerOwnerEscalationObserver(mock.pi);

      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload({ stage: 'develop' }));

      expect(calls.followUps).toHaveLength(0);
      expect(calls.audits.some((a) => a.event === 'owner_wake_escalation_skipped')).toBe(true);
    });

    it('child-bound deps never wake (no followUp, no owner_wake_escalation)', () => {
      const meta = blockedMeta();
      const { calls, deps } = makeDeps(meta);
      // Defense in depth: even if child deps were installed, the role gate
      // must refuse the wake and audit the skip reason.
      setOwnerEscalationDeps({ ...deps, isOwner: false });
      const mock = makeMockPi();
      cleanup = registerOwnerEscalationObserver(mock.pi);

      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());

      expect(calls.followUps).toHaveLength(0);
      expect(calls.statusBars).toBe(0);
      expect(calls.audits.some((a) => a.event === 'owner_wake_escalation')).toBe(false);
      const skip = calls.audits.find((a) => a.event === 'owner_wake_escalation_skipped');
      expect(skip?.payload.reason).toBe('child_session');
    });

    it('no meta accessor ⇒ skipped with no_meta', () => {
      const { calls, deps } = makeDeps(undefined);
      setOwnerEscalationDeps(deps);
      const mock = makeMockPi();
      cleanup = registerOwnerEscalationObserver(mock.pi);

      mock.fire(PIPELINE_ESCALATION_EVENT, basePayload());

      expect(calls.followUps).toHaveLength(0);
      const skip = calls.audits.find((a) => a.event === 'owner_wake_escalation_skipped');
      expect(skip?.payload.reason).toBe('no_meta');
    });
  });
});
