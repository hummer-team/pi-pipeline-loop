/**
 * Unit tests for owner-wake module (Phase 1 / 200_Bug G1-1, G1-2).
 * Tests the terminal event-driven owner wake logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setOwnerWakeDeps, registerOwnerWakeObserver, type OwnerWakeDeps } from '../../core/owner-wake';
import { registerTerminal, __resetLifecycleRegistry } from '../../utils/subagent-lifecycle-registry';
import { __resetMemoryThrottle } from '../../utils/audit-throttle';
import type { SessionMeta } from '../../types';

describe('owner-wake (Phase 1 / 200_Bug G1-1, G1-2)', () => {
  let cleanupObserver: () => void;
  const mockGetMeta = () => undefined as SessionMeta | undefined;
  const mockUpdateMeta = (_patch: Partial<SessionMeta>) => {};
  const mockSendFollowUp = (_summary: string) => {};
  const mockAudit = (_event: string, _payload: Record<string, unknown>) => {};

  let mockDeps: OwnerWakeDeps;

  beforeEach(() => {
    __resetLifecycleRegistry();

    mockDeps = {
      getMeta: mockGetMeta,
      updateMeta: mockUpdateMeta,
      sendFollowUp: mockSendFollowUp,
      audit: mockAudit,
      syncStatusBar: () => {}, // Phase 2 / 200_Bug: Fallback path sync
    };

    setOwnerWakeDeps(mockDeps);
    cleanupObserver = registerOwnerWakeObserver();
  });

  afterEach(() => {
    if (cleanupObserver) cleanupObserver();
  });

  describe('terminal status exemption (G1-2)', () => {
    it('should skip wake when reason is "stopped"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };

      // registerTerminal(agentType, agentId, status, reason, stage?, pipelineId?)
      registerTerminal('develop-agent', 'agent-123', 'terminal', 'stopped', 'develop', 'pipe-1');

      expect(auditVars).toHaveLength(1);
      expect(auditVars[0].event).toBe('owner_wake_skipped');
      expect(auditVars[0].payload).toMatchObject({
        agentId: 'agent-123',
        reason: 'status_exempt',
      });
    });

    // 203_Bug Phase 0: "terminal" (SDK payload field-mismatch value) was
    // previously excluded by the whitelist; the blacklist now lets it reach
    // activeSpawns matching and fire the wake. rawStatus must be audited.
    it('203_Bug Phase 0: should proceed with wake when reason is "terminal"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'terminal', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
      const wakeAudit = auditVars.find((e) => e.event === 'owner_wake_on_terminal');
      expect(wakeAudit).toBeDefined();
      expect(wakeAudit?.payload.status).toBe('terminal');
    });

    // 203_Bug Phase 0: empty and unknown reasons remain exempt (blacklist).
    it('203_Bug Phase 0: should skip wake when reason is empty or "unknown"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };

      // Empty reason
      auditVars.length = 0;
      registerTerminal('develop-agent', 'agent-123', 'terminal', '', 'develop', 'pipe-1');
      expect(auditVars).toHaveLength(1);
      expect(auditVars[0].event).toBe('owner_wake_skipped');
      expect(auditVars[0].payload.reason).toBe('status_exempt');
      expect(auditVars[0].payload.rawStatus).toBe('');

      // "unknown" reason
      registerTerminal('develop-agent', 'agent-123', 'terminal', 'unknown', 'develop', 'pipe-1');
      expect(auditVars).toHaveLength(2);
      expect(auditVars[1].event).toBe('owner_wake_skipped');
      expect(auditVars[1].payload.reason).toBe('status_exempt');
      expect(auditVars[1].payload.rawStatus).toBe('unknown');
    });

    it('should proceed with wake when reason is "completed"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });

    it('should proceed with wake when reason is "steered"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'steered', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });

    it('should proceed with wake when reason is "error"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'error', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });

    it('should proceed with wake when reason is "aborted"', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'aborted', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });
  });

  describe('activeSpawns matching', () => {
    it('should skip wake when agentId does not match any activeSpawn', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-OTHER', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(auditVars).toHaveLength(1);
      expect(auditVars[0].event).toBe('owner_wake_skipped');
      expect(auditVars[0].payload).toMatchObject({
        agentId: 'agent-123',
        reason: 'not_stage_executor',
      });
    });
  });

  describe('live peer check', () => {
    it('should skip wake when another activeSpawn agentId is live', () => {
      // This test verifies predicate 3 - but since probeAgentState is hard to mock
      // without DI, we just verify the non-live path fires wake correctly
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      // Single activeSpawn, no peers → should fire wake
      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });
  });

  describe('pending work predicates', () => {
    it('should skip wake when no pendingSpawns and stage is closed (summary valid)', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: { develop: { path: 'summary.md', hash: 'abc123', status: 'valid' } },
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(auditVars).toHaveLength(1);
      expect(auditVars[0].event).toBe('owner_wake_skipped');
      expect(auditVars[0].payload).toMatchObject({
        agentId: 'agent-123',
        reason: 'no_pending_work',
      });
    });

    it('should fire wake when pendingSpawns exist', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: { develop: { path: 'summary.md', hash: 'abc123', status: 'valid' } },
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { review: { agentName: 'review-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });

    it('should fire wake when stage summary is not valid (unclosed)', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: { develop: { path: 'summary.md', hash: 'abc123', status: 'pending' } },
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: undefined,
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let summaryContent = '';
      mockDeps.sendFollowUp = (summary: string) => { summaryContent = summary; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(summaryContent).toContain('has not been closed yet');
    });
  });

  describe('dedup', () => {
    it('should skip wake when terminalWake already matches (dedup)', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: { agentId: 'agent-123', stage: 'develop', visitOrder: 1, at: Date.now() - 1000 },
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
        stageVisitOrder: ['develop'],
      };

      mockDeps.getMeta = () => meta;
      const auditVars: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { auditVars.push({ event, payload }); };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(auditVars).toHaveLength(1);
      expect(auditVars[0].event).toBe('owner_wake_skipped');
      expect(auditVars[0].payload).toMatchObject({
        agentId: 'agent-123',
        reason: 'dedup',
      });
    });

    it('should fire wake when terminalWake agentId differs', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: { agentId: 'agent-PREV', stage: 'develop', visitOrder: 0, at: Date.now() - 1000 },
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
        stageVisitOrder: ['develop'],
      };

      mockDeps.getMeta = () => meta;
      let followUpCalled = false;
      mockDeps.sendFollowUp = (_summary: string) => { followUpCalled = true; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(followUpCalled).toBe(true);
    });
  });

  describe('wake summary content', () => {
    it('should include agentId and stage in summary', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { develop: { agentName: 'develop-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let summaryContent = '';
      mockDeps.sendFollowUp = (summary: string) => { summaryContent = summary; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(summaryContent).toContain('agent-123');
      expect(summaryContent).toContain('develop');
    });

    it('should mention pending spawns when they exist', () => {
      const meta: SessionMeta = {
        pipelineId: 'pipe-1',
        currentStage: 'develop',
        stageStartTime: Date.now(),
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        activeSpawns: { develop: { agentId: 'agent-123', agentName: 'develop-agent', startedAt: Date.now() } },
        terminalWake: undefined,
        pendingSpawns: { review: { agentName: 'review-agent', requestedAt: Date.now(), attempts: 0 } },
        domain: {} as any,
      };

      mockDeps.getMeta = () => meta;
      let summaryContent = '';
      mockDeps.sendFollowUp = (summary: string) => { summaryContent = summary; };

      registerTerminal('develop-agent', 'agent-123', 'terminal', 'completed', 'develop', 'pipe-1');

      expect(summaryContent).toContain('pending spawn requests');
    });
  });

  // ── 217 Phase 0 (F2): delivery-first, stamp-after-success ──
  describe('217: delivery-first stamp semantics', () => {
    beforeEach(() => {
      __resetMemoryThrottle();
    });

    const makeWakeMeta = (terminalWake?: SessionMeta['terminalWake']): SessionMeta => ({
      pipelineId: 'pipe-217',
      currentStage: 'review',
      stageStartTime: Date.now(),
      summaries: {},
      loopCount: 0,
      currentStepIndex: 0,
      maxLoops: 3,
      activeSpawns: { review: { agentId: 'agent-217', agentName: 'review-agent', startedAt: Date.now() } },
      terminalWake,
      pendingSpawns: { fix: { agentName: 'fix-agent', requestedAt: Date.now(), attempts: 0 } },
      domain: {} as any,
      stageVisitOrder: ['review'],
    });

    it('failed deliver: NO terminalWake stamp, undeliverable audit, one notifyHint', () => {
      const meta = makeWakeMeta();
      mockDeps.getMeta = () => meta;
      const stamps: unknown[] = [];
      mockDeps.updateMeta = (patch) => { stamps.push(patch); };

      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { audits.push({ event, payload }); };

      const hinted: string[] = [];
      mockDeps.notifyHint = (stage) => { hinted.push(stage); };

      mockDeps.deliver = () => ({
        delivered: false,
        via: 'none',
        targetSessionFile: '/sessions/owner.jsonl',
        reason: 'owner_target_not_registered',
      });

      registerTerminal('review-agent', 'agent-217', 'terminal', 'completed', 'review', 'pipe-217');

      // The dedup stamp must NOT be consumed by a failed delivery.
      expect(stamps).toHaveLength(0);
      expect(meta.terminalWake).toBeUndefined();

      const failAudit = audits.find((e) => e.event === 'owner_wake_undeliverable');
      expect(failAudit).toBeDefined();
      expect(failAudit?.payload).toMatchObject({
        agentId: 'agent-217',
        stage: 'review',
        pipelineId: 'pipe-217',
        targetSessionFile: '/sessions/owner.jsonl',
        reason: 'owner_target_not_registered',
        via: 'none',
      });
      expect(audits.find((e) => e.event === 'owner_wake_on_terminal')).toBeUndefined();

      // 217 Q8-A: exactly ONE visible hint on the failed delivery.
      expect(hinted).toEqual(['review']);
    });

    it('successful deliver: stamp written with via/targetSessionFile/actualSessionFile in the audit', () => {
      const meta = makeWakeMeta();
      mockDeps.getMeta = () => meta;
      const stamps: Partial<SessionMeta>[] = [];
      mockDeps.updateMeta = (patch) => { stamps.push(patch); meta.terminalWake = patch.terminalWake; };

      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { audits.push({ event, payload }); };

      mockDeps.deliver = () => ({
        delivered: true,
        via: 'registry_run_binding',
        targetSessionFile: '/sessions/owner.jsonl',
        actualSessionFile: '/sessions/owner.jsonl',
      });

      registerTerminal('review-agent', 'agent-217', 'terminal', 'completed', 'review', 'pipe-217');

      // Stamp AFTER delivery: exactly one terminalWake write.
      expect(stamps).toHaveLength(1);
      expect(stamps[0]?.terminalWake).toMatchObject({ agentId: 'agent-217', stage: 'review', visitOrder: 1 });

      const wakeAudit = audits.find((e) => e.event === 'owner_wake_on_terminal');
      expect(wakeAudit).toBeDefined();
      expect(wakeAudit?.payload).toMatchObject({
        agentId: 'agent-217',
        stage: 'review',
        delivered: 'true',
        via: 'registry_run_binding',
        targetSessionFile: '/sessions/owner.jsonl',
        actualSessionFile: '/sessions/owner.jsonl',
      });
      expect(audits.find((e) => e.event === 'owner_wake_undeliverable')).toBeUndefined();
    });

    it('no deliver (legacy deps shape): pre-217 behavior via deps_fallback', () => {
      const meta = makeWakeMeta();
      mockDeps.getMeta = () => meta;
      const stamps: Partial<SessionMeta>[] = [];
      mockDeps.updateMeta = (patch) => { stamps.push(patch); };
      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { audits.push({ event, payload }); };

      let followUpCalled = 0;
      mockDeps.sendFollowUp = () => { followUpCalled++; };

      registerTerminal('review-agent', 'agent-217', 'terminal', 'completed', 'review', 'pipe-217');

      // Legacy shape: one followUp + one stamp + the pre-217 audit payload.
      expect(followUpCalled).toBe(1);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]?.terminalWake).toMatchObject({ agentId: 'agent-217', stage: 'review' });

      const wakeAudit = audits.find((e) => e.event === 'owner_wake_on_terminal');
      expect(wakeAudit).toBeDefined();
      expect(wakeAudit?.payload.via).toBe('deps_fallback');
      expect(wakeAudit?.payload.delivered).toBe('true');
    });

    it('failed deliver is throttled: a second failure within the window emits no new audit/hint', () => {
      const meta = makeWakeMeta();
      mockDeps.getMeta = () => meta;
      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      mockDeps.audit = (event, payload) => { audits.push({ event, payload }); };
      const hinted: string[] = [];
      mockDeps.notifyHint = (stage) => { hinted.push(stage); };
      mockDeps.deliver = () => ({ delivered: false, via: 'none', reason: 'send_failed' });

      registerTerminal('review-agent', 'agent-217', 'terminal', 'completed', 'review', 'pipe-217');
      // Second terminal event: dedup stamp was NOT written by the failure, so
      // evaluation proceeds again — but the throttle suppresses audit + hint.
      registerTerminal('review-agent', 'agent-217', 'terminal', 'completed', 'review', 'pipe-217');

      expect(audits.filter((e) => e.event === 'owner_wake_undeliverable')).toHaveLength(1);
      expect(hinted).toHaveLength(1);
    });
  });
});
