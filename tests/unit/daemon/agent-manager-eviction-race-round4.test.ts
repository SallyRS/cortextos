import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Round 4 (F-B1). Round 3 added `AgentEntry.stopped` and guarded the fast-checker
// re-arm on it (agent-manager.ts:637) plus the two Telegram reject watchdogs
// (:698, :840). `stopped` is written in EXACTLY ONE place — stopAgent, :1141.
//
// But the agents map has TWO teardown sites:
//   stopAgent :1198          — unmaps AND has set stopped = true
//   startAgent eviction :446 — unmaps and NEVER sets stopped
//
// So an entry torn down by EVICTION carries stopped === undefined forever while
// being unmapped and fully stopped (its checker was stopped at :399, its process
// at :403). `!ownEntry.stopped` is therefore TRUE on exactly the entries eviction
// produces, and the round-3 guard falls open on that reachable case.
//
// The round-3 test for this class (T27b in agent-manager-map-entry-race.test.ts,
// :1161) built its scenario by writing the internal map directly
// (`agentsOf(am).set('alice', E2)`), which constructs a state no code path
// produces. This file reaches the state ONLY through startAgent(), by letting the
// real eviction branch run.
//
// Route used (reviewer B's route (b), config-independent — no startup_delay
// needed, and shipped templates all set startup_delay to 0):
// for runtime 'codex-app-server' the PTY can exit DURING pty.spawn()
// (agent-process.ts:180-189 — "PTY exited during spawn — handleExit will
// recover"). handleExit sets status 'crashed' while start() is still parked on
// the spawn await, so a concurrent start reads status 'crashed', gets
// isAgentActuallyAlive() === false (:291) and evicts the entry whose start is
// still in flight.
//
// The AgentProcess mock below models exactly that state machine: status
// 'starting' set synchronously (agent-process.ts:116), then a park that stands in
// for `await this.pty.spawn(...)`, with a test-driven handleExit that flips the
// status to 'crashed' mid-park.

type ProcStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'halted';

const h = vi.hoisted(() => ({
  /** Every AgentProcess the manager constructed, in construction order. */
  procs: [] as unknown[],
  /** Every FastChecker the manager constructed, in construction order. */
  checkers: [] as unknown[],
  /** Instance indexes whose start() parks on its spawn gate until released. */
  parkIndexes: [] as number[],
}));

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    index: number;
    status: ProcStatus = 'stopped';   // constructor default, as in the real class
    pid: number | undefined;
    /** Set by simulateExitDuringSpawn — mirrors handleExit() nulling this.pty. */
    ptyGone = false;
    private releaseSpawn!: () => void;
    /** Stands in for `await this.pty.spawn(mode, prompt)`. */
    spawnGate: Promise<void>;

    constructor(name: string) {
      this.name = name;
      this.index = h.procs.length;
      h.procs.push(this);
      let release!: () => void;
      this.spawnGate = new Promise<void>((r) => { release = r; });
      this.releaseSpawn = release;
      // Only the instances the test nominates park; everything else spawns
      // instantly, so the fresh start inside the eviction path completes.
      if (!h.parkIndexes.includes(this.index)) this.releaseSpawn();
    }

    async start() {
      if (this.status === 'running') return;          // agent-process.ts:91-94
      this.status = 'starting';                       // agent-process.ts:116 — SYNC
      await this.spawnGate;                           // agent-process.ts:180
      if (this.ptyGone) return;                       // agent-process.ts:186-189
      this.status = 'running';
      this.pid = 4242;
    }

    async stop() { this.status = 'stopped'; this.pid = undefined; }

    getStatus() { return { name: this.name, status: this.status, pid: this.pid }; }

    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }

    /**
     * The PTY exits while start() is still awaiting pty.spawn(). Mirrors
     * handleExit(): status -> 'crashed' (agent-process.ts:612/667) and this.pty
     * nulled, which is what the post-spawn `if (!this.pty)` branch reads.
     */
    simulateExitDuringSpawn() { this.ptyGone = true; this.status = 'crashed'; }

    /** Test-only: let the parked spawn() resolve. */
    finishSpawn() { this.releaseSpawn(); }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    /** The AgentProcess this checker was built for — the identity anchor. */
    process: unknown;
    startCount = 0;
    stopCount = 0;
    constructor(agentProcess: unknown) {
      this.process = agentProcess;
      h.checkers.push(this);
    }
    // The real FastChecker has `private running = false`, a start() that sets it
    // true and enters `while (this.running)`, and a stop() that sets it false.
    // There is no generation counter and no re-entry guard, so a second start()
    // on a stopped checker genuinely resumes injecting into the PTY.
    async start() { this.startCount++; }
    stop() { this.stopCount++; }
    wake() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    async handleActivityCallback() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { async sendMessage() { /* no-op */ } },
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason: string | undefined;
    start() { return new Promise<void>(() => {}); }
    stop() { this.lastExitReason = 'stopped-externally'; }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    agentName: string;
    constructor(opts: { agentName: string }) { this.agentName = opts.agentName; }
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    name: string;
    constructor(name: string) { this.name = name; }
    async spawn() { /* no-op */ }
    async terminate() { /* no-op */ }
    onDone() { /* no-op */ }
    isFinished() { return true; }
    getStatus() { return { name: this.name }; }
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type CheckerLike = { process: unknown; startCount: number; stopCount: number };
type ProcLike = {
  index: number;
  status: ProcStatus;
  simulateExitDuringSpawn(): void;
  finishSpawn(): void;
};
type EntryLike = { checker: CheckerLike; process: unknown; stopped?: boolean };

const agentsOf = (am: unknown) => (am as { agents: Map<string, EntryLike> }).agents;
const procAt = (i: number) => h.procs[i] as ProcLike;
const checkerFor = (p: unknown) => h.checkers.find((c) => (c as CheckerLike).process === p) as CheckerLike;

// ⛔ AGENT-MANAGER LINE NUMBERS IN THIS FILE ARE AS-OF 4c30b4d7 (PRE-FIX) AND ARE
// NOW WRONG. The fix inserted a comment block in startAgent's eviction branch, which
// shifted every line below it. DO NOT TRUST A NUMBER HERE — grep the symbol instead:
//   `stale.stopped = true`  ·  `stale.checker.stop`  ·  `if (!ownEntry.stopped)`
//   `entry.stopped = true`  ·  `this.agents.delete(name)`
// ⭐ Left as a stated offset rather than renumbered on purpose: renumbering is
// correct for exactly one commit and then silently wrong again, because a line
// number in a comment is a hand-maintained index with nothing checking it. This
// note stays true regardless of where the lines move next.
describe('AgentManager eviction race (F-B1) — `stopped` is never set on the eviction teardown path', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.procs.length = 0;
    h.checkers.length = 0;
    h.parkIndexes.length = 0;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-evict-race-'));
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    // No startup_delay key at all: the default is 0, exactly as shipped
    // templates set it. This scenario does NOT depend on a delayed start.
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ name: 'alice', runtime: 'codex-app-server' }),
    );
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('R4-CONTROL: two sequential starts of a crashed agent evict cleanly — old checker stopped and not re-armed, new checker live', async () => {
    // Same public surface, no interleaving: the first start runs to completion,
    // the process then crashes, and a second start evicts it. This is the
    // eviction path with nothing parked across it. It passes today; it exists to
    // prove the harness can DRIVE eviction through startAgent() at all, so a red
    // in the race test below cannot be blamed on a broken harness or a file that
    // failed to load.
    await am.startAgent('alice', agentDir);
    expect(h.procs.length).toBe(1);

    const first = procAt(0);
    const firstChecker = checkerFor(first);
    expect(firstChecker.startCount).toBe(1);   // normal path really armed it

    // The agent crashes after it was up.
    first.status = 'crashed';

    await am.startAgent('alice', agentDir);

    expect(h.procs.length).toBe(2);            // the eviction really started fresh
    const second = procAt(1);
    const secondChecker = checkerFor(second);

    expect(firstChecker.stopCount).toBe(1);    // eviction stopped the old checker
    expect(firstChecker.startCount).toBe(1);   // and never re-armed it
    expect(secondChecker.startCount).toBe(1);  // the newcomer is the live one
    expect(agentsOf(am).get('alice')?.checker).toBe(secondChecker);
  });

  it('R4-DEFECT: a start evicted mid-spawn must not re-arm the checker the eviction stopped', async () => {
    h.parkIndexes.push(0);   // instance #0 parks inside its spawn await

    // --- public surface call 1: the start that will be evicted ---------------
    const firstStart = am.startAgent('alice', agentDir);
    await Promise.resolve();

    expect(h.procs.length).toBe(1);                        // positive control
    const evictedProc = procAt(0);
    const evictedChecker = checkerFor(evictedProc);
    expect(evictedProc.status).toBe('starting');           // parked in spawn()
    expect(evictedChecker.startCount).toBe(0);             // not armed yet
    expect(agentsOf(am).get('alice')?.process).toBe(evictedProc);

    // The codex PTY exits DURING pty.spawn(). handleExit flips the status to
    // 'crashed' while start() is still parked on the spawn await.
    evictedProc.simulateExitDuringSpawn();
    expect(evictedProc.status).toBe('crashed');

    // --- public surface call 2: the concurrent start that evicts -------------
    // isAgentActuallyAlive() reads 'crashed' -> false -> eviction branch at :388.
    await am.startAgent('alice', agentDir);

    // The eviction really ran, through the real code path: it stopped our
    // checker (:399), stopped our process (:403), unmapped us (:446) and started
    // a fresh instance (:588). Nothing here wrote the agents map by hand.
    expect(evictedChecker.stopCount).toBe(1);
    expect(h.procs.length).toBe(2);
    const newcomerProc = procAt(1);
    const newcomerChecker = checkerFor(newcomerProc);
    expect(agentsOf(am).get('alice')?.process).toBe(newcomerProc);
    expect(newcomerChecker.startCount).toBe(1);            // newcomer is live

    // --- the evicted start now resumes past its spawn await ------------------
    evictedProc.finishSpawn();
    await firstStart;

    // The entry the EVICTION tore down. stopAgent would have set stopped = true
    // before its await (:1141); eviction never sets it, so `!ownEntry.stopped`
    // at :637 is true and the evicted entry's checker is re-armed — on a checker
    // that is unmapped and can never be stopped again, because every later
    // stopAgent reaches a checker only by name and the name now belongs to the
    // newcomer. It injects into a dead PTY for the life of the daemon.
    //
    // IDENTITY, not a count: "checker started once" is also satisfiable by the
    // WRONG checker surviving, so both halves are asserted separately.
    expect(newcomerChecker.startCount).toBe(1);
    expect(evictedChecker.startCount).toBe(0);
  });

  it('R4-MECHANISM: the identical race stays clean once the evicted entry carries `stopped` — the missing write is the whole defect', async () => {
    // Attribution control for the red above. Same public-surface race, byte for
    // byte, with ONE difference: the entry eviction tore down is given the
    // `stopped` flag stopAgent would have set at :1141. If the checker then stays
    // disarmed, the guard at :637 is working exactly as designed and the ONLY
    // thing missing is the write on the eviction teardown path at :446 — which is
    // what makes the red above a defect in src, not an artefact of this harness.
    //
    // Stable across the fix: once eviction sets `stopped` itself, the line below
    // is a no-op and this test still passes. It is not an anti-regression trap.
    h.parkIndexes.push(0);

    const firstStart = am.startAgent('alice', agentDir);
    await Promise.resolve();

    const evictedProc = procAt(0);
    const evictedChecker = checkerFor(evictedProc);
    const evictedEntry = agentsOf(am).get('alice') as EntryLike;
    expect(evictedEntry.process).toBe(evictedProc);     // positive control

    evictedProc.simulateExitDuringSpawn();
    await am.startAgent('alice', agentDir);

    expect(h.procs.length).toBe(2);                     // eviction really ran
    expect(evictedChecker.stopCount).toBe(1);

    // The one line src is missing on this path.
    evictedEntry.stopped = true;

    evictedProc.finishSpawn();
    await firstStart;

    expect(evictedChecker.startCount).toBe(0);
    expect(checkerFor(procAt(1)).startCount).toBe(1);
  });
});
