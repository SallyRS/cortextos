import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Round 4b. Companion to agent-manager-eviction-race-round4.test.ts.
//
// THE TWO STATES, NAMED BY STATE AND NEVER BY LETTER:
//
//   `stopped`-FALSE-and-UNMAPPED   the evicted zombie. MEASURED RED, round-4 file.
//                                  `!ownEntry.stopped` says ACT — wrongly.
//                                  `stillMapped` says don't act — correctly.
//
//   `stopped`-TRUE-and-STILL-MAPPED   THIS FILE. stopAgent sets `stopped` at :1141
//                                  and does not unmap until :1198, so for the whole
//                                  of `await entry.process.stop()` (:1146) the name
//                                  still resolves to an entry that is being torn down.
//                                  `stillMapped` says ACT — wrongly.
//                                  `!ownEntry.stopped` says don't act — correctly.
//
// EACH PREDICATE ALONE FAILS OPEN IN ONE OF THESE, AND THEY ARE DIFFERENT ONES.
//
// ⛔⛔ SUPERSEDED — READ THIS BEFORE THE PARAGRAPH ABOVE ACTS ON YOU.
// This header used to conclude "that is why the guard has to be the conjunction",
// and to call the second conjunct LOAD-BEARING. THE SHIPPED FIX TOOK THE OPPOSITE
// ROUTE AND THE OPPOSITE ROUTE IS CORRECT. Round 4 (F-B1) found that `stopped` was
// simply never SET on the eviction teardown path; setting it there makes the SINGLE
// predicate `!ownEntry.stopped` cover both teardown states, and src still guards on
// that one predicate alone.
//
// ⛔ DO NOT "COMPLETE" THE GUARD INTO A CONJUNCTION ON THE STRENGTH OF THIS FILE.
// Adding `stillMapped` as a conjunct would BREAK the superseded-but-alive case that
// T13/T14 exist to pin: an entry that is still running under someone else's name is
// legitimately entitled to its own checker, and a conjunction would deny it. The
// distinction is spelled out on the `stopped` field in AgentEntry.
//
// ✅ WHAT THIS FILE STILL WITNESSES, AND IT IS WORTH KEEPING: that
// `stillMapped`-ALONE would ACT in the stopped-and-still-mapped state, i.e. map
// identity is the wrong question to ask. That remains true and is why the guard asks
// about TEARDOWN. What does NOT follow from it is that BOTH questions must be asked.
// ⭐ The two are not the same claim, and this header conflated them for one commit:
// "map identity alone is insufficient" is not "map identity is necessary".
//
// ⛔ WHAT THIS FILE DOES NOT DO, STATED SO NOBODY HAS TO INFER IT:
// it does NOT go red against current src. Current src guards :637 on
// `!ownEntry.stopped`, which is CORRECT in this state. This is a REACHABILITY
// WITNESS for the state, not a defect report. It asserts the STATE the manager is
// observably in at the moment a parked start resumes — from which it follows that a
// guard reading map identity alone would act there. It deliberately does NOT
// evaluate a candidate predicate of its own: a test that scores an expression the
// test itself wrote is scoring the test, not src.
//
// ⛔ AND IT DOES NOT SPEAK TO PRODUCTION WINDOW WIDTH. The harness decides when
// `process.stop()` resolves, so the window here is as wide as the test wants. Width
// on the real code is a separate measurement against the real AgentProcess.stop(),
// where the sleeps are branch-conditional on `config.runtime` (default 6s floor,
// codex-app-server none). NOTHING HERE MEASURES THAT. See the runtime note below.

type ProcStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'halted';

const h = vi.hoisted(() => ({
  procs: [] as unknown[],
  checkers: [] as unknown[],
  /** Instance indexes whose start() parks on its spawn gate until released. */
  parkIndexes: [] as number[],
  /** Instance indexes whose stop() parks until released. */
  stopParkIndexes: [] as number[],
}));

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    index: number;
    status: ProcStatus = 'stopped';
    pid: number | undefined;
    ptyGone = false;
    private releaseSpawn!: () => void;
    private releaseStop!: () => void;
    spawnGate: Promise<void>;
    stopGate: Promise<void>;
    /** Flips true the moment stop() is entered, BEFORE it parks. */
    stopEntered = false;

    constructor(name: string) {
      this.name = name;
      this.index = h.procs.length;
      h.procs.push(this);
      let releaseA!: () => void;
      this.spawnGate = new Promise<void>((r) => { releaseA = r; });
      this.releaseSpawn = releaseA;
      if (!h.parkIndexes.includes(this.index)) this.releaseSpawn();

      let releaseB!: () => void;
      this.stopGate = new Promise<void>((r) => { releaseB = r; });
      this.releaseStop = releaseB;
      if (!h.stopParkIndexes.includes(this.index)) this.releaseStop();
    }

    async start() {
      if (this.status === 'running') return;
      this.status = 'starting';
      await this.spawnGate;
      if (this.ptyGone) return;
      this.status = 'running';
      this.pid = 4242;
    }

    /**
     * Stands in for the real AgentProcess.stop(). The real one yields for a
     * runtime-dependent floor (default branch: sleep(1000) + sleep(5000) inside
     * `if (pty)`); the gate here stands in for that yield so the test controls the
     * window rather than waiting on wall-clock.
     */
    async stop() {
      this.stopEntered = true;
      await this.stopGate;
      this.status = 'stopped';
      this.pid = undefined;
    }

    finishStop() { this.releaseStop(); }
    finishSpawn() { this.releaseSpawn(); }

    getStatus() { return { name: this.name, status: this.status, pid: this.pid }; }
    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
    simulateExitDuringSpawn() { this.ptyGone = true; this.status = 'crashed'; }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    process: unknown;
    startCount = 0;
    stopCount = 0;
    constructor(agentProcess: unknown) {
      this.process = agentProcess;
      h.checkers.push(this);
    }
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
  stopEntered: boolean;
  finishStop(): void;
  finishSpawn(): void;
};
type EntryLike = { checker: CheckerLike; process: unknown; stopped?: boolean };

const agentsOf = (am: unknown) => (am as { agents: Map<string, EntryLike> }).agents;
const procAt = (i: number) => h.procs[i] as ProcLike;
const checkerFor = (p: unknown) => h.checkers.find((c) => (c as CheckerLike).process === p) as CheckerLike;

/** Let every already-queued microtask drain, so a parked await actually resumes. */
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// ⛔ AGENT-MANAGER LINE NUMBERS IN THIS FILE ARE AS-OF 4c30b4d7 (PRE-FIX) AND ARE
// NOW WRONG — the fix shifted every line below startAgent's eviction branch. Grep
// the symbol, not the number: `entry.stopped = true`, `if (!ownEntry.stopped)`,
// `this.agents.delete(name)`, `stillMapped`.
describe('AgentManager stopAgent window — the `stopped`-TRUE-and-STILL-MAPPED state', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  // ⛔ RUNTIME IS PINNED TO THE DEFAULT (Claude Code) BRANCH ON PURPOSE, AND THE
  // REASON IS A TRAP THIS SUITE ALREADY WALKED INTO ONCE.
  // The round-4 red uses `runtime: 'codex-app-server'` because that was the
  // config-independent route into the evicted-zombie state. codex-app-server is
  // ALSO the one runtime whose real stop() path skips the whole Ctrl-C//exit
  // dance, so it has NO stop-path sleep floor at all. Carrying that fixture over
  // here — same file, same harness, the obvious move — would have measured the
  // zero-floor branch. The state below is manager-level and does not depend on the
  // runtime, but the pin is kept so that nothing downstream can read a result from
  // this file as a statement about the zero-floor branch.
  const RUNTIME = 'claude-code';

  beforeEach(() => {
    h.procs.length = 0;
    h.checkers.length = 0;
    h.parkIndexes.length = 0;
    h.stopParkIndexes.length = 0;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-stopwindow-'));
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ name: 'alice', runtime: RUNTIME }),
    );
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('R4B-CONTROL: an ordinary stop with nothing parked across it tears down and unmaps — proves the harness can drive stopAgent at all', async () => {
    await am.startAgent('alice', agentDir);
    const proc = procAt(0);
    const checker = checkerFor(proc);
    expect(checker.startCount).toBe(1);                 // normal path armed it
    expect(agentsOf(am).get('alice')?.process).toBe(proc);

    await am.stopAgent('alice', true);

    expect(checker.stopCount).toBe(1);
    expect(agentsOf(am).has('alice')).toBe(false);      // :1198 really ran
    expect(checker.startCount).toBe(1);                 // and nothing re-armed it
  });

  it('R4B-WITNESS: a start parked in spawn() resumes while stopAgent holds the name — `stopped` TRUE and the name STILL RESOLVING to the same entry', async () => {
    h.parkIndexes.push(0);       // the start parks inside its spawn await (:591)
    h.stopParkIndexes.push(0);   // and stopAgent will park inside process.stop() (:1146)

    // --- public surface call 1: a start that will still be in flight ----------
    const parkedStart = am.startAgent('alice', agentDir);
    await drain();

    const proc = procAt(0);
    const checker = checkerFor(proc);
    const entry = agentsOf(am).get('alice') as EntryLike;

    // positive controls: we are where we think we are before anything interesting
    expect(h.procs.length).toBe(1);
    expect(entry.process).toBe(proc);
    expect(proc.status).toBe('starting');
    expect(checker.startCount).toBe(0);                 // :637 not reached yet
    expect(entry.stopped).toBeUndefined();              // :1141 not reached yet

    // --- public surface call 2: the stop, left in flight ----------------------
    // Deliberately NOT awaited: stopAgent parks on `await entry.process.stop()`
    // at :1146, which is the whole point — :1141 has run, :1198 has not.
    const parkedStop = am.stopAgent('alice', true);
    await drain();

    // THE STATE, OBSERVED — nothing here wrote the map or the flag by hand.
    expect(proc.stopEntered).toBe(true);                // we really are inside :1146
    expect(entry.stopped).toBe(true);                   // :1141 ran
    expect(agentsOf(am).get('alice')).toBe(entry);      // :1198 has NOT run — IDENTITY, not has()
    expect(checker.stopCount).toBe(1);                  // :1145 tore the checker down

    // ⇒ THIS IS THE STATE THE WHOLE FILE EXISTS TO WITNESS. A guard that asks only
    // "does the name still resolve to me" gets TRUE here, on an entry whose
    // teardown has already begun and whose checker has already been stopped.

    // --- the parked start now resumes past its spawn await into :637 ----------
    proc.finishSpawn();
    await parkedStart;

    // Current src guards on `!ownEntry.stopped`, which is CORRECT in this state,
    // so the checker stays disarmed. This assertion is the load-bearing one: it is
    // what a `stillMapped`-only guard would break, and it passes today only because
    // the `stopped` conjunct exists.
    expect(checker.startCount).toBe(0);

    // Let the stop finish so the test leaves no parked promise behind.
    proc.finishStop();
    await parkedStop;
    expect(agentsOf(am).has('alice')).toBe(false);
  });

  it('R4B-NEGATIVE-CONTROL: with the stop NOT in flight, the same parked start DOES re-arm — so the assertion above can fail, and is not passing for want of a code path', async () => {
    // Same fixture, same parked start, one difference: nobody stops the agent. If
    // the re-arm assertion above passed merely because this harness never reaches
    // :637 at all, this test would show a startCount of 0 too. It must show 1.
    h.parkIndexes.push(0);

    const parkedStart = am.startAgent('alice', agentDir);
    await drain();

    const proc = procAt(0);
    const checker = checkerFor(proc);
    expect(checker.startCount).toBe(0);

    proc.finishSpawn();
    await parkedStart;

    expect(checker.startCount).toBe(1);   // :637 IS reachable in this harness
  });
});
