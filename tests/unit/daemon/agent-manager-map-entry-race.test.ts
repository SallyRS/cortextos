import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// map-entry-race fix: a NAME is used as a handle to an OBJECT across an await,
// and the name is re-bindable during that await. These tests force the
// interleaving DETERMINISTICALLY (deferred stop()/start() promises resolved by
// hand — the technique already proven at agent-manager-liveness.test.ts:162-187),
// so there is no timing hope, no fake timers and no retry loop. They are
// deterministic-unit evidence, NOT a statistical repro rate.
//
// Mock harness mirrors agent-manager-liveness.test.ts, plus CronScheduler and
// bus/metrics: these tests reach further into startAgent() than the liveness
// tests do, so the real scheduler (setInterval) and the real Telegram
// command-registration (network) would otherwise run.
let agentProcessCtorCount = 0;
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: unknown;
    constructor(name: string, dir: unknown) {
      agentProcessCtorCount++;
      this.name = name;
      this.dir = dir;
    }
    async start() { /* overridden per-test where a deferred start is needed */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    // Round 3 (F2): the real FastChecker has `private running = false`, a
    // `start()` that unconditionally sets it true and enters `while (this.running)`,
    // and a `stop()` that sets it false. There is NO generation counter and start
    // is NOT idempotent-protected, so a second start() on a stopped checker
    // genuinely resumes injecting into the PTY. Counting calls is therefore the
    // right probe, exactly as it is for TelegramPoller above.
    startCount = 0;
    stopCount = 0;
    async start() { this.startCount++; }
    stop() { this.stopCount++; }
    wake() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { async sendMessage() { /* no-op */ } },
}));
// Round 2: the poller mock is no longer a pure no-op. The round-1 harness parked
// start() in a never-resolving promise, which is exactly what made the
// poller-RESURRECTION class unobservable — the wrapper could never get back
// round its loop. `pollerStartMode` lets a single describe opt into a
// resolving start() without changing the default for every other test.
const hoisted = vi.hoisted(() => ({ pollerStartMode: 'park' as 'park' | 'conflict-once' }));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason: string | undefined;
    /** 4th ctor arg — 'activity' for the activity-channel poller, undefined for the primary. */
    suffix: string | undefined;
    startCount = 0;
    stopCount = 0;
    messageHandlers: ((m: unknown) => void)[] = [];
    callbackHandlers: ((q: unknown) => void)[] = [];
    reactionHandlers: ((r: unknown) => void)[] = [];
    constructor(_api?: unknown, _stateDir?: string, _interval?: number, suffix?: string) {
      this.suffix = suffix;
    }
    start() {
      this.startCount++;
      // Mirrors src/telegram/poller.ts:89-90. start() unconditionally re-arms the
      // loop and BLANKS lastExitReason, erasing any 'stopped-externally' a
      // concurrent stop() left behind. The real class has NO re-entry guard —
      // pinned by 'restarting a stopped poller re-arms it' in
      // tests/unit/telegram/poller.test.ts — so a second start() on a torn-down
      // poller genuinely polls again. That is why startCount is the right probe.
      this.lastExitReason = '';
      if (hoisted.pollerStartMode === 'conflict-once' && this.startCount === 1) {
        // poller.ts:104-107 — a 409 Conflict exits the loop asking to be restarted.
        // Only the FIRST call resolves, so the wrapper gets exactly one trip round
        // its retry sleep and a resurrection cannot run away with the test.
        return Promise.resolve().then(() => { this.lastExitReason = 'conflict-self-die'; });
      }
      // Never resolves: parks the Conflict-restart wrapper instead of letting it
      // fall through to its 30s setTimeout and dangle past the test.
      return new Promise<void>(() => {});
    }
    stop() { this.stopCount++; this.lastExitReason = 'stopped-externally'; }
    onMessage(h: (m: unknown) => void) { this.messageHandlers.push(h); }
    onCallback(h: (q: unknown) => void) { this.callbackHandlers.push(h); }
    onReaction(h: (r: unknown) => void) { this.reactionHandlers.push(h); }
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
    private doneHandler: ((n: string) => void) | null = null;
    finished = true;
    constructor(name: string) { this.name = name; }
    async spawn() { /* no-op */ }
    async terminate() { /* no-op */ }
    onDone(h: (n: string) => void) { this.doneHandler = h; }
    /** Test-only: fire the onDone callback AgentManager registered in spawnWorker. */
    fireDone() { this.doneHandler?.(this.name); }
    isFinished() { return this.finished; }
    getStatus() { return { name: this.name }; }
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type PollerLike = {
  startCount: number;
  stopCount: number;
  suffix?: string;
  messageHandlers: ((m: unknown) => void)[];
  callbackHandlers: ((q: unknown) => void)[];
  reactionHandlers: ((r: unknown) => void)[];
};
type AgentEntryLike = {
  poller?: unknown;
  activityPoller?: unknown;
  telegramRejectCount?: number;
  checker?: unknown;
};
const agentsOf = (am: unknown) => (am as { agents: Map<string, unknown> }).agents;
const pendingOf = (am: unknown) => (am as { pendingRestarts: Set<string> }).pendingRestarts;
const cronsOf = (am: unknown) => (am as { cronSchedulers: Map<string, unknown> }).cronSchedulers;
const workersOf = (am: unknown) => (am as { workers: Map<string, unknown> }).workers;
const entryOf = (am: unknown, name: string) => agentsOf(am).get(name) as AgentEntryLike;

// Round-1 ids run T1-T7 then T9. THERE IS NO T8, and no record of what it was
// survives anywhere: searched every commit body on every ref and the whole tree
// at HEAD for the token, nothing. So this comment cannot say what T8 tested —
// only that its absence is a gap in the record and NOT a test that was written,
// run, and deliberately removed, because nothing distinguishes those two from
// here. Round 2 does not reuse the id; it continues from T10.

const LIVE_PID = 1234;

/** A deferred promise so a test can resolve an await at an exact instant. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Minimal stand-in for a mapped agent entry, with a deferred process.stop(). */
function fakeEntry(stop: () => Promise<void>, status = 'running') {
  return {
    process: { getStatus: () => ({ name: 'alice', status, pid: LIVE_PID }), stop },
    checker: { stop: vi.fn() },
  };
}

function fakeScheduler() {
  return { stop: vi.fn(), start: vi.fn(), reload: vi.fn(), getNextFireTimes: () => [] };
}

/** Agent dir with a config.json, and optionally the .env the poller branch needs. */
function makeAgentDir(root: string, org: string, name: string, withTelegram = false): string {
  const dir = join(root, 'framework', 'orgs', org, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name }));
  if (withTelegram) {
    // Format-valid only. TelegramAPI and TelegramPoller are both mocked, so
    // nothing is contacted and no real token is involved.
    writeFileSync(
      join(dir, '.env'),
      'BOT_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nCHAT_ID=999\nALLOWED_USER=999\n',
    );
  }
  return dir;
}

/** Make `name` the org's orchestrator and give the org an activity channel. */
function makeActivityChannel(root: string, org: string, name: string): void {
  const orgDir = join(root, 'framework', 'orgs', org);
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, 'context.json'), JSON.stringify({ orchestrator: name }));
  writeFileSync(
    join(orgDir, 'activity-channel.env'),
    'ACTIVITY_BOT_TOKEN=654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\nACTIVITY_CHAT_ID=888\n',
  );
}

describe('AgentManager map-entry race — stopAgent must not evict a replacement registered during its await', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-stop-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T1: does not unmap a replacement registered during process.stop()', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);

    const p = am.stopAgent('alice', true);   // parks at `await entry.process.stop()`
    agentsOf(am).set('alice', E2);           // the re-registration, at the exact instant
    d.resolve();
    await p;

    // IDENTITY, not presence: a replacement that got deleted and re-added would
    // pass a `.has()` check while the live newcomer had already been orphaned.
    expect(agentsOf(am).get('alice')).toBe(E2);
  });

  it('T2: still unmaps its OWN entry when nobody supersedes it (preservation guard)', async () => {
    const E1 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);

    await am.stopAgent('alice', true);

    expect(agentsOf(am).has('alice')).toBe(false);
    expect(E1.checker.stop).toHaveBeenCalled();
  });

  it('T3: does not stop or unmap a REPLACEMENT\'s scheduler', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    const S1 = fakeScheduler();
    const S2 = fakeScheduler();
    agentsOf(am).set('alice', E1);
    cronsOf(am).set('alice', S1);

    const p = am.stopAgent('alice', true);
    agentsOf(am).set('alice', E2);
    cronsOf(am).set('alice', S2);
    d.resolve();
    await p;

    expect(S2.stop).not.toHaveBeenCalled();
    expect(cronsOf(am).get('alice')).toBe(S2);
  });

  it('T4: still stops its OWN scheduler when superseded (no leaked interval)', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    const S1 = fakeScheduler();
    const S2 = fakeScheduler();
    agentsOf(am).set('alice', E1);
    cronsOf(am).set('alice', S1);

    const p = am.stopAgent('alice', true);
    agentsOf(am).set('alice', E2);
    cronsOf(am).set('alice', S2);
    d.resolve();
    await p;

    // Kills the naive `if (superseded) return;` placed above the scheduler
    // block: that leaks S1's setInterval forever.
    expect(S1.stop).toHaveBeenCalled();
    expect(cronsOf(am).get('alice')).toBe(S2);
  });

  it('T4b: re-wires a scheduler for the newcomer that our stop left cron-less', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    const S1 = fakeScheduler();
    agentsOf(am).set('alice', E1);
    cronsOf(am).set('alice', S1);

    // No S2: the newcomer's own startAgentCronScheduler() was refused by the
    // "already running" guard because S1 was still mapped at the time.
    const p = am.stopAgent('alice', true);
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    expect(S1.stop).toHaveBeenCalled();
    const rewired = cronsOf(am).get('alice');
    expect(rewired).toBeDefined();
    expect(rewired).not.toBe(S1);
  });

  it('T5: does not consume a replacement\'s queued restart', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);

    const p = am.stopAgent('alice', true);   // userInitiated: drops pendingRestarts
    agentsOf(am).set('alice', E2);
    pendingOf(am).add('alice');              // queued against the NEWCOMER
    d.resolve();
    await p;

    expect(pendingOf(am).has('alice')).toBe(true);
  });

  it('T6: non-superseded pendingRestarts honor path is unchanged (BUG-011/031 guard)', async () => {
    const E1 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);
    pendingOf(am).add('alice');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue(undefined);

    await am.stopAgent('alice', false);      // internal caller

    expect(startSpy).toHaveBeenCalledWith('alice', '');
    expect(pendingOf(am).has('alice')).toBe(false);
    startSpy.mockRestore();
  });
});

describe('AgentManager map-entry race — startAgent eviction must abort rather than clobber a replacement', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-evict-'));
    // A REAL agent dir, unlike agent-manager-liveness.test.ts, so the fresh-start
    // path runs past `new AgentProcess()` and the unconditional `agents.set()`
    // instead of bailing early at "Agent directory not found". That is what makes
    // the clobber (rather than only the delete) observable here.
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ name: 'alice' }));
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    agentProcessCtorCount = 0;
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T7: aborts the start when a different instance took the name during eviction', async () => {
    const d = deferred();
    const stale = fakeEntry(() => d.promise, 'halted');   // dead => eviction path
    const E2 = fakeEntry(async () => {});
    agentsOf(am).set('alice', stale);

    const p = am.startAgent('alice', agentDir);   // parks at `await stale.process.stop()`
    agentsOf(am).set('alice', E2);                // a different instance takes the name
    d.resolve();
    await p;

    expect(agentsOf(am).get('alice')).toBe(E2);
    // Unpatched, the fresh-start path runs and builds a SECOND PTY over E2.
    expect(agentProcessCtorCount).toBe(0);
  });
});

describe('AgentManager map-entry race — a poller must attach to the entry that created it', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-poller-'));
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ name: 'alice' }));
    // Telegram credentials are required for the poller branch to run at all.
    // The token only has to satisfy the numeric_id:secret format check —
    // TelegramAPI and TelegramPoller are both mocked, so nothing is contacted.
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nCHAT_ID=999\nALLOWED_USER=999\n',
    );
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T9: attaches its poller to its OWN entry, not to whoever holds the name later', async () => {
    // Park inside `await agentProcess.start()` — which sits between the
    // `agents.set()` at the top of the start path and the poller wiring below it.
    const d = deferred();
    const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
    const startSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementation(() => d.promise);

    const p = am.startAgent('alice', agentDir);
    await Promise.resolve();                       // let startAgent reach the park

    const ownEntry = agentsOf(am).get('alice') as AgentEntryLike;
    expect(ownEntry).toBeDefined();                // positive control: we really got the start path

    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    // Asserted FIRST so the baseline failure is unambiguous: "expected {...} to
    // be undefined" can only mean the poller attached itself to the foreign
    // entry. Asserting ownEntry.poller first would fail identically whether the
    // defect fired or the poller branch simply never ran.
    expect(E2.poller).toBeUndefined();
    // Positive control: without this, `E2.poller === undefined` would also pass
    // if the poller branch never ran at all (bad .env, changed guard, etc.).
    expect(ownEntry.poller).toBeDefined();

    startSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ROUND 2 — the same defect at the sites where a name is used to DECIDE WHETHER
// TO ACT, not only where it is used to DESTROY. A presence check (`agents.has`,
// `agents.get` truthiness) reads TRUE for a DIFFERENT object that has since
// taken the name, so the round-1 guards — which correctly leave the name mapped
// — turned "both die" into "the old one comes back".
// ---------------------------------------------------------------------------

describe('AgentManager map-entry race — a torn-down poller must not be resurrected by a successor holding the name', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.pollerStartMode = 'conflict-once';
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-resurrect-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice', true);
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    hoisted.pollerStartMode = 'park';
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  // BOTH POLARITIES, DELIBERATELY. A bare "start() was not called twice" is
  // green on the over-correction — a guard so tight that the NEWCOMER's poller
  // never starts either. That failure is WORSE than the one this test is named
  // for: nothing 409s, nothing churns, nothing alarms, the agent just stops
  // receiving Telegram and every surface looks healthy. And a COUNT ALONE
  // cannot tell "the right poller is live" from "the stale one is live" —
  // both are 1 — so the identity assertions below are load-bearing, not colour.
  it('T10: restarts neither poller by name — the stale one stays dead, the newcomer stays live', async () => {
    await am.startAgent('alice', agentDir);
    await vi.advanceTimersByTimeAsync(0);          // let A's wrapper park in its 30s retry sleep
    const entryA = entryOf(am, 'alice');
    const pollerA = entryA.poller as PollerLike;
    expect(pollerA.startCount).toBe(1);            // positive control: the wrapper really ran

    await am.stopAgent('alice', true);             // real teardown: poller.stop() + entry unmapped
    expect(pollerA.stopCount).toBe(1);             // positive control: A really WAS torn down
    expect(agentsOf(am).has('alice')).toBe(false);

    // A different instance takes the name. `this.agents.has('alice')` now reads
    // TRUE for an object that is not A's.
    await am.startAgent('alice', agentDir);
    const entryB = entryOf(am, 'alice');
    const pollerB = entryB.poller as PollerLike;
    expect(pollerB).not.toBe(pollerA);
    expect(pollerB.startCount).toBe(1);            // OVER-CORRECTION control: 0 here = silent Telegram
    expect(pollerB.stopCount).toBe(0);

    await vi.advanceTimersByTimeAsync(30_001);     // A's retry sleep elapses

    // DEFECT control. Unpatched this is 2: the wrapper's `agents.has(name)`
    // reads TRUE for B, and start() — which has no re-entry guard — re-arms A's
    // loop, putting a second live poller on the same bot token.
    expect(pollerA.startCount).toBe(1);
    expect(pollerA.stopCount).toBe(1);             // still torn down, never revived
    // IDENTITY: the live poller is the NEWCOMER's, not the superseded one.
    expect(entryOf(am, 'alice')).toBe(entryB);
    expect(entryOf(am, 'alice').poller).toBe(pollerB);
    expect(pollerB.stopCount).toBe(0);             // B was never torn down by A's teardown
  });

  it('T11: activity-channel wrapper obeys the same rule (orchestrator-only twin of T10)', async () => {
    makeActivityChannel(testDir, 'acme', 'alice');
    // The org is passed explicitly here to keep this test aimed at the poller
    // RESURRECTION defect it exists to pin, and nothing else.
    // ⛔ It is NOT a fixture requirement. When this was written, :912 passed the
    // raw `org` rather than the resolvedOrg computed at :434, so an omitted org
    // meant the activity poller never started at all — and passing it explicitly
    // WORKED AROUND that production bug (F1) rather than exercising the code the
    // way every restart path actually calls it. Recording that as a test-setup
    // requirement is how a defect becomes documented intent: the next reader
    // inherits "org must be passed" as the design. F1 is fixed and T31 now covers
    // the no-org path directly; this line stays only to keep T11 single-purpose.
    await am.startAgent('alice', agentDir, undefined, 'acme');
    await vi.advanceTimersByTimeAsync(0);
    const entryA = entryOf(am, 'alice');
    const actA = entryA.activityPoller as PollerLike;
    expect(actA).toBeDefined();                    // positive control: the branch really ran
    expect(actA.suffix).toBe('activity');          // and it is the ACTIVITY poller, not the primary
    expect(actA.startCount).toBe(1);

    await am.stopAgent('alice', true);
    expect(actA.stopCount).toBe(1);

    await am.startAgent('alice', agentDir, undefined, 'acme');
    const actB = entryOf(am, 'alice').activityPoller as PollerLike;
    expect(actB).not.toBe(actA);
    expect(actB.startCount).toBe(1);               // over-correction control
    expect(actB.stopCount).toBe(0);

    await vi.advanceTimersByTimeAsync(30_001);

    expect(actA.startCount).toBe(1);               // defect control: unpatched, 2
    expect(entryOf(am, 'alice').activityPoller).toBe(actB);
  });
});

describe('AgentManager map-entry race — the activity poller attaches to the entry that created it', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-actattach-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice', true);
    makeActivityChannel(testDir, 'acme', 'alice');
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // Closes the coverage gap the review measured as M7: reverting the
  // activity-poller attach from the captured entry to a by-name lookup left the
  // ENTIRE suite green.
  it('T12: attaches its activity poller to its OWN entry, not to whoever holds the name later', async () => {
    const d = deferred();
    const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
    const startSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementation(() => d.promise);

    const p = am.startAgent('alice', agentDir, undefined, 'acme');
    await Promise.resolve();

    const ownEntry = entryOf(am, 'alice');
    expect(ownEntry).toBeDefined();                // positive control: we really got the start path

    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    // Asserted FIRST so the baseline failure is unambiguous, same reasoning as T9.
    expect(E2.activityPoller).toBeUndefined();
    // Positive control: without this, `E2.activityPoller === undefined` also
    // passes when the activity branch never ran at all (no context.json, wrong
    // orchestrator, missing env).
    expect(ownEntry.activityPoller).toBeDefined();

    startSpy.mockRestore();
  });
});

describe('AgentManager map-entry race — poller callbacks act on their own entry', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-cb-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice', true);
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // Two-sided in one test BECAUSE the two halves are different objects: the
  // counter must land on ours AND must not land on the successor's. Asserting
  // only the second half would be green if the handler counted nothing at all.
  it('T13: the reject counter increments OUR entry, never the successor holding the name', async () => {
    await am.startAgent('alice', agentDir);
    const ownEntry = entryOf(am, 'alice');
    const poller = ownEntry.poller as PollerLike;
    expect(poller.messageHandlers).toHaveLength(1);   // positive control: handler really registered

    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);

    // An unauthorized sender: ALLOWED_USER is 999, this is not it.
    poller.messageHandlers[0]({ from: { id: 111, first_name: 'mallory' }, chat: { id: 999 }, text: 'hi' });

    expect(ownEntry.telegramRejectCount).toBe(1);
    expect(E2.telegramRejectCount).toBeUndefined();
  });

  it('T14: the reaction reject counter does the same', async () => {
    await am.startAgent('alice', agentDir);
    const ownEntry = entryOf(am, 'alice');
    const poller = ownEntry.poller as PollerLike;
    expect(poller.reactionHandlers).toHaveLength(1);

    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);

    poller.reactionHandlers[0]({ user: { id: 111, first_name: 'mallory' }, chat: { id: 999 }, message_id: 1 });

    expect(ownEntry.telegramRejectCount).toBe(1);
    expect(E2.telegramRejectCount).toBeUndefined();
  });

  it('T15: an activity-channel callback routes to OUR checker, not the successor\'s', async () => {
    makeActivityChannel(testDir, 'acme', 'alice');
    await am.startAgent('alice', agentDir, undefined, 'acme');
    const ownEntry = entryOf(am, 'alice');
    const actPoller = ownEntry.activityPoller as PollerLike;
    expect(actPoller.callbackHandlers).toHaveLength(1);

    const ownHandled = vi.fn().mockResolvedValue(undefined);
    (ownEntry.checker as { handleActivityCallback: unknown }).handleActivityCallback = ownHandled;
    const foreignHandled = vi.fn().mockResolvedValue(undefined);
    const E2 = { process: {}, checker: { handleActivityCallback: foreignHandled } };
    agentsOf(am).set('alice', E2);

    actPoller.callbackHandlers[0]({ id: '1', data: 'appr_allow_x' });

    expect(ownHandled).toHaveBeenCalled();          // ours ran (over-correction control)
    expect(foreignHandled).not.toHaveBeenCalled();  // the successor's did not
  });
});

describe('AgentManager map-entry race — startAgent eviction, scheduler handling after the await', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-evictsched-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice');
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    agentProcessCtorCount = 0;
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  // Closes the coverage gap the review measured as M8: reverting the
  // staleScheduler hoist AND its identity guard to an unguarded post-await read
  // left the ENTIRE suite green. This is the eviction-path analogue of T3/T4 —
  // the stopAgent side had them, this side had nothing.
  it('T16: does not stop or unmap a REPLACEMENT\'s scheduler while evicting', async () => {
    const d = deferred();
    const stale = fakeEntry(() => d.promise, 'halted');   // dead => eviction path
    const E2 = fakeEntry(async () => {});
    const S1 = fakeScheduler();
    const S2 = fakeScheduler();
    agentsOf(am).set('alice', stale);
    cronsOf(am).set('alice', S1);

    const p = am.startAgent('alice', agentDir);   // parks at `await stale.process.stop()`
    agentsOf(am).set('alice', E2);
    cronsOf(am).set('alice', S2);
    d.resolve();
    await p;

    expect(S2.stop).not.toHaveBeenCalled();       // the newcomer's scheduler survives
    expect(cronsOf(am).get('alice')).toBe(S2);
    expect(S1.stop).toHaveBeenCalled();           // OPPOSITE POLARITY: ours is still stopped,
                                                  // otherwise the eviction leaks a setInterval
  });

  // I-1 in the review: stopAgent got this re-wire and its structural twin here
  // did not. Reported separately — I could not construct the interleaving the
  // review describes; see the round-2 report.
  it('T17: re-wires a scheduler for the newcomer that our eviction left cron-less', async () => {
    const d = deferred();
    const stale = fakeEntry(() => d.promise, 'halted');
    const E2 = fakeEntry(async () => {});
    const S1 = fakeScheduler();
    agentsOf(am).set('alice', stale);
    cronsOf(am).set('alice', S1);

    // No S2: the newcomer's own startAgentCronScheduler() was refused by the
    // "already running" guard because S1 was still mapped at the time.
    const p = am.startAgent('alice', agentDir);
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    expect(S1.stop).toHaveBeenCalled();
    const rewired = cronsOf(am).get('alice');
    expect(rewired).toBeDefined();
    expect(rewired).not.toBe(S1);
    expect(agentProcessCtorCount).toBe(0);        // and we still aborted, not restarted
  });

  // The hoist's own blind spot, in BOTH paths: a scheduler that did not exist at
  // capture time but was wired for us DURING the await is invisible to the
  // captured variable. Pre-hoist the post-await read saw it; post-hoist nothing
  // does, and it outlives the agent as a live setInterval that also blocks the
  // next start from getting a scheduler at all.
  it('T18: eviction stops a scheduler that appeared for the stale entry during the await', async () => {
    const d = deferred();
    const stale = fakeEntry(() => d.promise, 'halted');
    const Slate = fakeScheduler();
    agentsOf(am).set('alice', stale);             // NO scheduler mapped at capture time

    const p = am.startAgent('alice', agentDir);
    cronsOf(am).set('alice', Slate);              // wired for the stale entry mid-await
    d.resolve();
    await p;

    expect(Slate.stop).toHaveBeenCalled();
    expect(cronsOf(am).get('alice')).not.toBe(Slate);
  });

  it('T19: but leaves a late scheduler alone when it belongs to a SUCCESSOR', async () => {
    const d = deferred();
    const stale = fakeEntry(() => d.promise, 'halted');
    const E2 = fakeEntry(async () => {});
    const Slate = fakeScheduler();
    agentsOf(am).set('alice', stale);

    const p = am.startAgent('alice', agentDir);
    agentsOf(am).set('alice', E2);                // superseded FIRST
    cronsOf(am).set('alice', Slate);              // the scheduler is the newcomer's
    d.resolve();
    await p;

    expect(Slate.stop).not.toHaveBeenCalled();
    expect(cronsOf(am).get('alice')).toBe(Slate);
  });
});

describe('AgentManager map-entry race — stopAgent, scheduler that appears during the await', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-latesched-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T20: stops and unmaps a scheduler wired for US during process.stop()', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const Slate = fakeScheduler();
    agentsOf(am).set('alice', E1);                // NO scheduler at capture time

    const p = am.stopAgent('alice', true);
    cronsOf(am).set('alice', Slate);              // startAgent:553 wires it mid-await
    d.resolve();
    await p;

    expect(Slate.stop).toHaveBeenCalled();
    expect(cronsOf(am).has('alice')).toBe(false);
  });

  it('T21: but leaves it alone when a SUCCESSOR took the name (opposite polarity)', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    const Slate = fakeScheduler();
    agentsOf(am).set('alice', E1);

    const p = am.stopAgent('alice', true);
    agentsOf(am).set('alice', E2);
    cronsOf(am).set('alice', Slate);
    d.resolve();
    await p;

    expect(Slate.stop).not.toHaveBeenCalled();
    expect(cronsOf(am).get('alice')).toBe(Slate);
  });
});

describe('AgentManager map-entry race — startAgent must not wire a scheduler it no longer owns', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-startsched-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice');
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  async function parkedStart() {
    const d = deferred();
    const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
    const startSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementation(() => d.promise);
    const p = am.startAgent('alice', agentDir);
    await Promise.resolve();
    return { p, d, startSpy };
  }

  it('T22: a superseded start does not install a scheduler under the newcomer\'s name', async () => {
    const { p, d, startSpy } = await parkedStart();
    const ownEntry = entryOf(am, 'alice');
    expect(ownEntry).toBeDefined();               // positive control: we reached the park

    const E2 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    expect(cronsOf(am).get('alice')).toBeUndefined();
    startSpy.mockRestore();
  });

  it('T23: a NORMAL start still wires one (opposite polarity of T22)', async () => {
    const { p, d, startSpy } = await parkedStart();
    d.resolve();
    await p;

    expect(cronsOf(am).get('alice')).toBeDefined();
    startSpy.mockRestore();
  });

  // I-2 in the review: a predecessor's supersede-re-wire installs a scheduler
  // under our name while we are parked in agentProcess.start(). It read
  // crons.json BEFORE our migrateCronsForAgent wrote it, so it holds zero crons,
  // and startAgentCronScheduler's "already running — skipped" guard leaves it
  // that way DURABLY: tick() never reloads and reload() is otherwise IPC-only.
  it('T24: refreshes a scheduler installed under our name while we were starting', async () => {
    const { p, d, startSpy } = await parkedStart();
    const Spre = fakeScheduler();
    cronsOf(am).set('alice', Spre);               // the predecessor's re-wire, pre-migration
    d.resolve();
    await p;

    expect(Spre.reload).toHaveBeenCalled();
    expect(Spre.stop).not.toHaveBeenCalled();     // refreshed, not replaced
    expect(cronsOf(am).get('alice')).toBe(Spre);
    startSpy.mockRestore();
  });
});

describe('AgentManager map-entry race — restartAgent must not restart on top of a successor', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-restart-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T25: skips the start half when a different instance took the name during the stop', async () => {
    const d = deferred();
    const E1 = fakeEntry(() => d.promise);
    const E2 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue(undefined);

    const p = am.restartAgent('alice');
    agentsOf(am).set('alice', E2);
    d.resolve();
    await p;

    // Unpatched: startAgent runs, sees a live entry, and emits the
    // "BUG-011 REGRESSION CHECK" warning on a race that is handled BY DESIGN —
    // a false alarm on a warning operators are trained to treat as serious —
    // and leaves a pendingRestarts entry that fires a spurious restart later.
    expect(startSpy).not.toHaveBeenCalled();
    expect(pendingOf(am).has('alice')).toBe(false);
    expect(agentsOf(am).get('alice')).toBe(E2);
    startSpy.mockRestore();
  });

  it('T26: still restarts normally when nobody supersedes it (opposite polarity)', async () => {
    const E1 = fakeEntry(async () => {});
    agentsOf(am).set('alice', E1);
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue(undefined);

    await am.restartAgent('alice');

    expect(startSpy).toHaveBeenCalledWith('alice', '');
    startSpy.mockRestore();
  });
});

describe('AgentManager map-entry race — worker registry', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-worker-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('T27: terminateWorker does not unmap a replacement registered during terminate()', async () => {
    const d = deferred();
    const W1 = { terminate: () => d.promise };
    const W2 = { terminate: async () => {} };
    workersOf(am).set('w1', W1);

    const p = am.terminateWorker('w1');
    workersOf(am).set('w1', W2);
    d.resolve();
    await p;

    expect(workersOf(am).get('w1')).toBe(W2);
  });

  it('T28: terminateWorker still unmaps its OWN worker (opposite polarity)', async () => {
    const W1 = { terminate: async () => {} };
    workersOf(am).set('w1', W1);

    await am.terminateWorker('w1');

    expect(workersOf(am).has('w1')).toBe(false);
  });

  it('T29: the 30s reaper does not evict a DIFFERENT worker holding the name', async () => {
    vi.useFakeTimers();
    try {
      await am.spawnWorker('w1', join(testDir, 'framework'), 'do a thing');
      const W1 = workersOf(am).get('w1') as { fireDone: () => void };
      expect(W1).toBeDefined();                   // positive control: spawn really registered it
      W1.fireDone();                              // schedules the 30s reaper

      const W2 = { isFinished: () => true };
      workersOf(am).set('w1', W2);                // a NEW worker takes the name

      await vi.advanceTimersByTimeAsync(30_001);

      expect(workersOf(am).get('w1')).toBe(W2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T30: the reaper still evicts its OWN finished worker (opposite polarity)', async () => {
    vi.useFakeTimers();
    try {
      await am.spawnWorker('w1', join(testDir, 'framework'), 'do a thing');
      const W1 = workersOf(am).get('w1') as { fireDone: () => void };
      W1.fireDone();

      await vi.advanceTimersByTimeAsync(30_001);

      expect(workersOf(am).has('w1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentManager map-entry race — the no-ABA precondition is enforced, not asserted', () => {
  // stillMapped()'s doc says `this.agents.set` is the single call site in the
  // class, and the no-ABA argument rests on it: one call site storing a freshly
  // built literal means a re-registered agent is never reference-equal to a
  // captured one. NOTHING enforced that claim — a second `agents.set` could be
  // added tomorrow and every test would stay green while the guard silently
  // weakened. This is an ENFORCEMENT assertion, not a behavioural regression
  // control: it was never red, and it fails only when the precondition is
  // actually broken, which is exactly when someone needs to be told.
  it('T31: this.agents.set has exactly one call site in agent-manager.ts', () => {
    const src = readFileSync(
      new URL('../../../src/daemon/agent-manager.ts', import.meta.url),
      'utf-8',
    );
    const callSites = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'))
      .filter((l) => /this\.agents\.set\(/.test(l));
    expect(callSites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ROUND 3 — findings from the two independent reviewers run against round 2.
//
// F5 and F2 are the same class round 1 and round 2 each hit once (B1, then N2):
// REMOVING A BUG REMOVED AN ACCIDENTAL PROTECTION. F5 is the third instance and
// the first one that arrived INSIDE the fix for the previous two.
//
// Every test below is paired. A guard that never lets the block run is exactly
// as wrong as one that always does, and a single assertion cannot carry both
// directions — so each defect gets a DEFECT test and an OVER-CORRECTION test
// rather than one assertion asked to mean two things.
// ---------------------------------------------------------------------------

describe('AgentManager map-entry race — round 3: an unmapped entry must not act on the world', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-map-race-r3-'));
    agentDir = makeAgentDir(testDir, 'acme', 'alice', true);
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // --- F5: the reject-count watchdog ---------------------------------------
  // Round 2 replaced `const entry = this.agents.get(name); if (entry) {...}`
  // with `const entry = ownEntry; {...}`. ownEntry is an object literal typed
  // non-optional and never reassigned, so it is NEVER FALSY and the block became
  // unconditional. The `if (entry)` it replaced was a real gate that skipped
  // whenever the name was unmapped.

  it('T23 (F5 DEFECT, message handler): a stranger reject after teardown must not touch a stopped agent', async () => {
    await am.startAgent('alice', agentDir);
    const entryA = entryOf(am, 'alice');
    const pollerA = entryA.poller as PollerLike;
    expect(pollerA.messageHandlers.length).toBe(1);   // positive control: the handler really was wired

    await am.stopAgent('alice', true);
    expect(agentsOf(am).has('alice')).toBe(false);    // positive control: really unmapped

    // A message already in flight in the getUpdates batch that was open when
    // stop() was called. The poller mock does not itself gate delivery, which
    // mirrors the real class: stop() sets a flag, it cannot recall a batch.
    pollerA.messageHandlers[0]({ from: { id: 111 } });

    // UNPATCHED this is 1 — and at the threshold it sends a WATCHDOG Telegram on
    // behalf of an agent the operator has already stopped.
    expect(entryA.telegramRejectCount ?? 0).toBe(0);
  });

  it('T24 (F5 OVER-CORRECTION, message handler): while still mapped the watchdog must still count', async () => {
    await am.startAgent('alice', agentDir);
    const entryA = entryOf(am, 'alice');
    const pollerA = entryA.poller as PollerLike;

    pollerA.messageHandlers[0]({ from: { id: 111 } });

    // 0 here means the guard swallowed the live path: the ALLOWED_USER watchdog
    // silently stops working and unsolicited contact is never surfaced. That is
    // a worse failure than the one T23 fixes, because nothing looks wrong.
    expect(entryA.telegramRejectCount).toBe(1);
  });

  it('T25 (F5 DEFECT, reaction handler): the twin site must be guarded too', async () => {
    await am.startAgent('alice', agentDir);
    const entryA = entryOf(am, 'alice');
    const pollerA = entryA.poller as PollerLike;
    expect(pollerA.reactionHandlers.length).toBe(1);  // positive control

    await am.stopAgent('alice', true);
    pollerA.reactionHandlers[0]({ user: { id: 111 } });

    expect(entryA.telegramRejectCount ?? 0).toBe(0);
  });

  it('T26 (F5 OVER-CORRECTION, reaction handler): while still mapped the reaction gate must still count', async () => {
    await am.startAgent('alice', agentDir);
    const entryA = entryOf(am, 'alice');
    const pollerA = entryA.poller as PollerLike;

    pollerA.reactionHandlers[0]({ user: { id: 111 } });

    expect(entryA.telegramRejectCount).toBe(1);
  });

  // --- F2: the fast checker ------------------------------------------------
  // The diff asks the identity question for the cron scheduler at :588 and does
  // NOT ask it for the checker ten lines later at :607. stopAgent calls
  // entry.checker.stop() BEFORE its await, so a start parked in
  // agentProcess.start() resumes and re-arms a checker that was already stopped.
  // Because our entry is unmapped, stopAgent — which reaches the checker only
  // via a by-name lookup — can never stop it again.

  it('T27 (F2 DEFECT): a start parked across a teardown must not re-arm the stopped checker', async () => {
    const d = deferred();
    const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
    const startSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementation(() => d.promise);

    const p = am.startAgent('alice', agentDir);
    await Promise.resolve();                          // reach the park inside start()

    const ownEntry = agentsOf(am).get('alice') as AgentEntryLike;
    expect(ownEntry).toBeDefined();                   // positive control: we really got the start path
    const ownChecker = ownEntry.checker as { startCount: number; stopCount: number };
    expect(ownChecker.startCount).toBe(0);            // positive control: parked, not started yet

    // The operator stops the agent while our start is still parked. This is the
    // real ordering: stopAgent stops the checker BEFORE its own await.
    const stopP = am.stopAgent('alice', true);
    await Promise.resolve();
    expect(ownChecker.stopCount).toBe(1);             // positive control: OUR checker really was stopped

    d.resolve();
    await p;
    await stopP;

    // UNPATCHED this is 1: a checker re-armed after teardown, and unreachable by
    // any future stopAgent because the name no longer resolves to this entry.
    expect(ownChecker.startCount).toBe(0);

    startSpy.mockRestore();
  });

  it('T27b (F2 DISCRIMINATOR): a merely SUPERSEDED start must STILL arm its checker', async () => {
    // This is the test that rules out the obvious-looking remedy. Guarding the
    // checker on stillMapped() would pass T27 and fail here: being superseded is
    // not being stopped, our process is alive, and an agent whose checker never
    // starts is completely dead — no Telegram, no hooks, no injection — while
    // every liveness surface still reports it running.
    const d = deferred();
    const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
    const startSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementation(() => d.promise);

    const p = am.startAgent('alice', agentDir);
    await Promise.resolve();

    const ownEntry = agentsOf(am).get('alice') as AgentEntryLike;
    const ownChecker = ownEntry.checker as { startCount: number };

    // Somebody else takes the name. Nothing stopped US.
    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);

    d.resolve();
    await p;

    expect(ownChecker.startCount).toBe(1);

    startSpy.mockRestore();
  });

  it('T28 (F2 OVER-CORRECTION): the normal path must still start the checker', async () => {
    await am.startAgent('alice', agentDir);
    const entryA = entryOf(am, 'alice');
    const checker = entryA.checker as { startCount: number };

    // 0 here is a completely dead agent: no Telegram, no hooks, no injection,
    // and every liveness surface still reports it running.
    expect(checker.startCount).toBe(1);
  });

  // --- F3/F4: stillMapped conflates REPLACED with REMOVED -------------------
  // stillMapped() is `this.agents.get(name) === entry`. When NOTHING holds the
  // name, get() returns undefined and the comparison is false — identical to the
  // genuinely-re-registered case. The superseded branches then warn about a
  // re-registration that provably did not happen and return early, skipping the
  // pendingRestarts handling below them.

  it('T29 (F3/F4 DEFECT): a second stop of an already-removed name must not claim a re-registration', async () => {
    const d = deferred();
    const stopped = fakeEntry(() => d.promise) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', stopped);
    pendingOf(am).add('alice');

    const first = am.stopAgent('alice', true);
    await Promise.resolve();                          // park inside process.stop()

    // A concurrent stop completes and removes the name. ipc-server never awaits
    // stopAgent (see the comment at the top of stopAgent), so two stops for the
    // same name genuinely interleave.
    agentsOf(am).delete('alice');

    // mockClear immediately: vi.spyOn on an ALREADY-spied console.warn returns
    // the SAME mock, and a mockRestore() written after an assertion never runs
    // when that assertion throws. Measured: T29 failing pre-fix left its spy
    // installed and T30 then read T29's warning as its own, turning a passing
    // over-correction control into a false red. Cleanup after an assertion is
    // cleanup that only happens when it is not needed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    d.resolve();
    await first;

    // UNPATCHED: warns "was re-registered while stopping" about a name nothing
    // holds, and returns before the pendingRestarts handling — stranding a
    // queued restart that later fires against an unrelated stop.
    const reRegisteredWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('re-registered'));
    expect(reRegisteredWarnings).toEqual([]);
    expect(pendingOf(am).has('alice')).toBe(false);

    warn.mockRestore();
  });

  it('T30 (F3/F4 OVER-CORRECTION): a genuine re-registration must STILL be detected and left alone', async () => {
    const d = deferred();
    const stopped = fakeEntry(() => d.promise) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', stopped);

    const first = am.stopAgent('alice', true);
    await Promise.resolve();

    // This time a DIFFERENT instance really does take the name.
    const E2 = fakeEntry(async () => {}) as unknown as AgentEntryLike;
    agentsOf(am).set('alice', E2);

    // mockClear immediately: vi.spyOn on an ALREADY-spied console.warn returns
    // the SAME mock, and a mockRestore() written after an assertion never runs
    // when that assertion throws. Measured: T29 failing pre-fix left its spy
    // installed and T30 then read T29's warning as its own, turning a passing
    // over-correction control into a false red. Cleanup after an assertion is
    // cleanup that only happens when it is not needed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    d.resolve();
    await first;

    // The newcomer must survive: deleting here would empty the slot while the
    // new agent keeps running, which is the orphan this branch exists to stop.
    expect(agentsOf(am).get('alice')).toBe(E2);
    const reRegisteredWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('re-registered'));
    expect(reRegisteredWarnings.length).toBe(1);

    warn.mockRestore();
  });

  // --- F1: the activity-channel poller gets the RAW org ---------------------
  // :912 passes `org`, the raw parameter, not the `resolvedOrg` computed at :434
  // for exactly this reason. maybeStartActivityChannelPoller returns immediately
  // on a falsy org. THREE callers pass no org: restartAgent, the pendingRestarts
  // honor path, and ipc-server.ts's start-agent handler.

  it('T31 (F1 DEFECT): a start with no explicit org must still wire the activity poller', async () => {
    makeActivityChannel(testDir, 'acme', 'alice');

    // No 4th argument — exactly what restartAgent, the pendingRestarts honor
    // path, and the IPC start handler all pass.
    await am.startAgent('alice', agentDir);

    const entryA = entryOf(am, 'alice');
    expect(entryA.poller).toBeDefined();              // positive control: the telegram branch ran at all
    // UNPATCHED this is undefined: every dashboard restart, CLI start-agent and
    // restartAgent silently drops the orchestrator's approval-button path.
    expect(entryA.activityPoller).toBeDefined();
  });

  it('T32 (F1 OVER-CORRECTION): a non-orchestrator must still NOT get an activity poller', async () => {
    // Activity channel exists, but bob is not the org's orchestrator.
    makeActivityChannel(testDir, 'acme', 'alice');
    const bobDir = makeAgentDir(testDir, 'acme', 'bob', true);

    await am.startAgent('bob', bobDir);

    const entryB = entryOf(am, 'bob');
    expect(entryB.poller).toBeDefined();              // positive control: the telegram branch ran
    // Resolving the org must not turn the orchestrator-only gate into an
    // every-agent gate — that would put N pollers on one bot token.
    expect(entryB.activityPoller).toBeUndefined();
  });
});
