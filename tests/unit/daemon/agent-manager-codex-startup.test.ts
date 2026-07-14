import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const lifecycle = vi.hoisted(() => ({
  checkerStarts: 0,
  cronMigrations: 0,
  genericPtyConstructions: 0,
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { lifecycle.checkerStarts += 1; return Promise.resolve(); }
    stop() {}
    wake() {}
  },
}));

vi.mock('../../../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent() { lifecycle.cronMigrations += 1; },
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: class {
    constructor() { lifecycle.genericPtyConstructions += 1; }
    onExit() {}
    async spawn() {}
    getPid() { return 1234; }
    isAlive() { return true; }
    kill() {}
    write() {}
    getOutputBuffer() { return { isBootstrapped: () => false }; }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    sendMessage() { return Promise.resolve(); }
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() {}
    stop() {}
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager Codex fail-closed startup', () => {
  let root: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-codex-startup-'));
    ctxRoot = join(root, 'instance');
    frameworkRoot = join(root, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    lifecycle.checkerStarts = 0;
    lifecycle.cronMigrations = 0;
    lifecycle.genericPtyConstructions = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function agentDir(name: string): string {
    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('keeps every ancillary service off after a real malformed Codex profile', async () => {
    const dir = agentDir('bad-codex');
    const config = {
      agent_name: 'bad-codex',
      runtime: 'codex-app-server' as const,
      enabled: true,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');
    await manager.startAgent('bad-codex', dir, config, 'acme');

    const entry = (manager as any).agents.get('bad-codex');
    expect(entry.process.getStatus()).toMatchObject({
      status: 'crashed',
      restartScheduled: false,
    });
    expect(lifecycle.checkerStarts).toBe(0);
    expect(lifecycle.cronMigrations).toBe(0);
    expect((manager as any).cronSchedulers.size).toBe(0);
    expect(logs.join('\n')).toMatch(/services remain disabled/);
    expect(existsSync(join(
      ctxRoot,
      'state',
      'bad-codex',
      'codex-permission-start.claim.json',
    ))).toBe(false);
  });

  it('removes a stopped startup-delay seat without allowing a late spawn', async () => {
    vi.useFakeTimers();
    const dir = agentDir('slow-agent');
    const config = {
      agent_name: 'slow-agent',
      enabled: true,
      startup_delay: 30,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');

    const startPromise = manager.startAgent('slow-agent', dir, config, 'acme');
    await Promise.resolve();
    expect((manager as any).agents.get('slow-agent').process.getStatus().status)
      .toBe('starting');

    await manager.stopAgent('slow-agent');
    expect((manager as any).agents.has('slow-agent')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await startPromise;

    expect(lifecycle.genericPtyConstructions).toBe(0);
    expect(lifecycle.checkerStarts).toBe(0);
    expect(lifecycle.cronMigrations).toBe(0);
    expect((manager as any).agents.has('slow-agent')).toBe(false);
  });

  it('preserves approval-gated starts for registry-disabled workers', async () => {
    vi.useFakeTimers();
    const dir = agentDir('disabled-agent');
    const config = { agent_name: 'disabled-agent', enabled: true, startup_delay: 30 };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'disabled-agent': { enabled: false, org: 'acme' } }),
    );
    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');

    const startPromise = manager.startAgent('disabled-agent', dir, config, 'acme');
    await Promise.resolve();

    expect((manager as any).agents.has('disabled-agent')).toBe(true);
    expect((manager as any).agents.get('disabled-agent').process.getStatus().status)
      .toBe('starting');
    await manager.stopAgent('disabled-agent');
    await vi.advanceTimersByTimeAsync(30_000);
    await startPromise;
    expect(lifecycle.genericPtyConstructions).toBe(0);
  });

  it('blocks a start only while the dedicated permission-migration hold exists', async () => {
    const dir = agentDir('held-agent');
    const config = {
      agent_name: 'held-agent',
      runtime: 'codex-app-server' as const,
      enabled: true,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const stateDir = join(ctxRoot, 'state', 'held-agent');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'codex-permission-migration.hold.json'), '{}');
    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');

    await manager.startAgent('held-agent', dir, config, 'acme');

    expect((manager as any).agents.has('held-agent')).toBe(false);
    expect(lifecycle.genericPtyConstructions).toBe(0);
  });

  it('releases the start claim when synchronous seat setup fails', async () => {
    const dir = agentDir('setup-failure');
    const config = {
      agent_name: 'setup-failure',
      runtime: 'codex-app-server' as const,
      enabled: true,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    mkdirSync(join(dir, '.env'));
    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');

    await manager.startAgent('setup-failure', dir, config, 'acme');

    expect((manager as any).agents.has('setup-failure')).toBe(false);
    expect(existsSync(join(
      ctxRoot,
      'state',
      'setup-failure',
      'codex-permission-start.claim.json',
    ))).toBe(false);
  });

  it('recovers a strictly valid start claim owned by a dead daemon', async () => {
    const dir = agentDir('dead-claim');
    const config = {
      agent_name: 'dead-claim',
      runtime: 'codex-app-server' as const,
      enabled: true,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const stateDir = join(ctxRoot, 'state', 'dead-claim');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'codex-permission-start.claim.json'),
      `${JSON.stringify({
        schemaVersion: 'cortextos-codex-permission-start-claim/v1',
        agent: 'dead-claim',
        pid: 2_147_483_647,
        nonce: 'a'.repeat(32),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');

    await manager.startAgent('dead-claim', dir, config, 'acme');

    expect((manager as any).agents.has('dead-claim')).toBe(true);
    expect(existsSync(join(stateDir, 'codex-permission-start.claim.json'))).toBe(false);
  });
});
