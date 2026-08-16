import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// opencode --continue wedge auto-recovery (agent-process.ts handleExit).
//
// This suite deliberately uses REAL fs + the REAL exit-code path (the captured
// onExit closure drives the real handleExit) and only stubs the PTY classes so
// no real `opencode` binary is spawned. A sibling PR this week regressed because
// a heavily mocked unit test hid a real-file-path bug, so the assertions here
// are made against files actually written to a temp ctxRoot: the .force-fresh
// marker, restarts.log, and the real opencode-session.json that shouldContinue()
// reads to decide fresh vs --continue.

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockOpencodePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(13579),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({
    isBootstrapped: vi.fn().mockReturnValue(true),
    getRecent: vi.fn().mockReturnValue(''),
    push: vi.fn(),
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockOpencodePty; },
}));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockOpencodePty; },
}));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockOpencodePty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

// Keep the REAL opencodeSessionExists (it reads the real marker on disk) and
// only replace the class so no `opencode` process is spawned.
vi.mock('../../../src/pty/opencode-pty.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/pty/opencode-pty.js')>();
  return { ...actual, OpencodePTY: function OpencodePTY() { return mockOpencodePty; } };
});

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

let ctxRoot: string;
const AGENT = 'opencode-agent';

function stateDir(): string { return join(ctxRoot, 'state', AGENT); }
function forceFreshPath(): string { return join(stateDir(), '.force-fresh'); }
function restartsLogPath(): string { return join(ctxRoot, 'logs', AGENT, 'restarts.log'); }
function writeSessionMarker(): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    join(stateDir(), 'opencode-session.json'),
    JSON.stringify({ runtime: 'opencode', mode: 'continue' }),
    'utf-8',
  );
}

function makeEnv() {
  return {
    instanceId: 'test',
    ctxRoot,
    frameworkRoot: join(ctxRoot, 'fw'),
    agentName: AGENT,
    agentDir: join(ctxRoot, 'fw', 'agents', AGENT),
    org: 'acme',
    projectRoot: join(ctxRoot, 'fw'),
  };
}

beforeEach(() => {
  capturedOnExit = null;
  ctxRoot = mkdtempSync(join(tmpdir(), 'oc-wedge-'));
  mkdirSync(join(ctxRoot, 'fw', 'agents', AGENT), { recursive: true });
  mockOpencodePty.spawn.mockClear();
  mockOpencodePty.onExit.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('opencode --continue wedge auto-recovery', () => {
  it('arms .force-fresh after N consecutive fast exit-0 continues and reboots fresh', async () => {
    vi.useFakeTimers();
    writeSessionMarker();
    const ap = new AgentProcess(AGENT, makeEnv(), { runtime: 'opencode', telegram_polling: false });

    // First boot: session marker present -> --continue.
    await ap.start();
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));

    // Wedge exit #1 (immediate exit_code=0). Below threshold -> normal crash
    // recovery reschedules a --continue restart.
    capturedOnExit!(0);
    expect(existsSync(forceFreshPath())).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // crash #1 backoff -> restart
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));

    // Wedge exit #2. Still below threshold.
    capturedOnExit!(0);
    expect(existsSync(forceFreshPath())).toBe(false);
    await vi.advanceTimersByTimeAsync(10000); // crash #2 backoff -> restart
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));

    // Wedge exit #3 -> threshold reached -> arm .force-fresh (real file) and log.
    capturedOnExit!(0);
    expect(existsSync(forceFreshPath())).toBe(true);
    expect(readFileSync(restartsLogPath(), 'utf-8'))
      .toContain('OPENCODE_CONTINUE_WEDGE_RECOVERY');

    // Recovery restart: shouldContinue() reads the real .force-fresh -> fresh boot,
    // and the marker is consumed.
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('fresh', expect.any(String));
    expect(existsSync(forceFreshPath())).toBe(false);
  });

  it('does not arm .force-fresh when a continue session exits cleanly after the fast-exit window', async () => {
    vi.useFakeTimers();
    writeSessionMarker();
    const ap = new AgentProcess(AGENT, makeEnv(), { runtime: 'opencode', telegram_polling: false });

    await ap.start();
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));

    // A long, healthy session that later exits 0 is NOT a wedge — the fast-exit
    // gate must keep the streak from ever incrementing, even after several such
    // exits.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(120_000); // uptime well past FAST_EXIT_MS
      capturedOnExit!(0);
      expect(existsSync(forceFreshPath())).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000); // backoff -> restart (continue)
    }
    expect(existsSync(forceFreshPath())).toBe(false);
  });

  it('does not count exit-0 in fresh mode toward the wedge streak', async () => {
    vi.useFakeTimers();
    // No session marker -> fresh boot.
    const ap = new AgentProcess(AGENT, makeEnv(), { runtime: 'opencode', telegram_polling: false });

    await ap.start();
    expect(mockOpencodePty.spawn).toHaveBeenLastCalledWith('fresh', expect.any(String));

    capturedOnExit!(0);
    capturedOnExit!(0);
    capturedOnExit!(0);
    expect(existsSync(forceFreshPath())).toBe(false);
  });
});
