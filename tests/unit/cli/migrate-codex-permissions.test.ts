import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ipcState = vi.hoisted(() => ({
  running: false,
  statuses: [] as Array<{ name: string; status: string }>,
  error: null as Error | null,
  malformed: false,
  instances: [] as string[],
}));
const osState = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => osState.home || actual.homedir() };
});

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    constructor(instance: string) { ipcState.instances.push(instance); }
    async isDaemonRunning() { return ipcState.running; }
    async send() {
      if (ipcState.error) throw ipcState.error;
      if (!ipcState.running) {
        return {
          success: false,
          error: 'Daemon is not running. Start it with: cortextos start',
        };
      }
      if (ipcState.malformed) return { success: true, data: {} };
      return { success: true, data: ipcState.statuses };
    }
  },
}));

const {
  codexCapabilityProfileHash,
  codexConfigHash,
  migrateCodexPermissionsCommand,
} = await import('../../../src/cli/migrate-codex-permissions.js');
const { buildDefaultCodexCapabilityProfile } = await import(
  '../../../src/utils/codex-capability-profile.js'
);
const { codexPermissionMigrationHoldPath, codexPermissionStartClaimPath } = await import(
  '../../../src/utils/codex-permission-migration.js'
);

describe('migrate-codex-permissions', () => {
  let root: string;
  let agentDir: string;
  let configPath: string;
  let ctxRoot: string;
  let oldFrameworkRoot: string | undefined;
  let oldCtxRoot: string | undefined;
  let oldInstanceId: string | undefined;
  let oldExitCode: string | number | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-profile-migrate-'));
    osState.home = join(root, 'home');
    agentDir = join(root, 'orgs', 'acme', 'agents', 'legacy-codex');
    configPath = join(agentDir, 'config.json');
    ctxRoot = join(osState.home, '.cortextos', 'test');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      agent_name: 'legacy-codex',
      runtime: 'codex-app-server',
      enabled: true,
    }, null, 2) + '\n');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        'legacy-codex': { enabled: false, org: 'acme' },
      }, null, 2) + '\n',
    );
    oldFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    oldCtxRoot = process.env.CTX_ROOT;
    oldInstanceId = process.env.CTX_INSTANCE_ID;
    oldExitCode = process.exitCode;
    process.env.CTX_FRAMEWORK_ROOT = root;
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
    process.exitCode = undefined;
    ipcState.running = true;
    ipcState.statuses = [];
    ipcState.error = null;
    ipcState.malformed = false;
    ipcState.instances = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (oldFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = oldFrameworkRoot;
    if (oldCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = oldCtxRoot;
    if (oldInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = oldInstanceId;
    process.exitCode = oldExitCode;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('dry-runs a concrete profile without mutating config', async () => {
    const before = readFileSync(configPath, 'utf-8');
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
    ]);

    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    const firstLog = vi.mocked(console.log).mock.calls[0][0] as string;
    const review = JSON.parse(firstLog);
    expect(review.agent).toBe('legacy-codex');
    expect(review.profile.codex_writable_paths).toEqual([agentDir]);
    expect(review.configSha256).toBe(codexConfigHash(before));
    expect(review.profileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires both reviewed hashes and applies atomically while absent', async () => {
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    const hash = codexCapabilityProfileHash(profile);
    const configHash = codexConfigHash(readFileSync(configPath, 'utf-8'));
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', hash, '--expect-config', configHash,
    ]);

    expect(
      process.exitCode,
      vi.mocked(console.error).mock.calls.flat().join('\n'),
    ).toBeUndefined();
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.codex_credential_deny_paths).toEqual(profile.codex_credential_deny_paths);
    expect(config.codex_writable_paths).toEqual([agentDir]);
    expect(config.codex_network_allow_domains).toEqual([]);
    expect(existsSync(codexPermissionMigrationHoldPath(ctxRoot, 'legacy-codex')))
      .toBe(false);
  });

  it('unions mandatory baseline guards into a partial legacy profile', async () => {
    const customDeny = join(root, 'custom-secret');
    writeFileSync(configPath, JSON.stringify({
      agent_name: 'legacy-codex',
      runtime: 'codex-app-server',
      codex_credential_deny_paths: [customDeny],
      codex_readonly_paths: [],
    }, null, 2) + '\n');

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
    ]);
    const review = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(review.profile.codex_credential_deny_paths).toEqual(expect.arrayContaining([
      customDeny,
      join(agentDir, '.env'),
    ]));
    expect(review.profile.codex_readonly_paths).toEqual(expect.arrayContaining([
      join(agentDir, 'AGENTS.md'),
      join(agentDir, 'config.json'),
    ]));
    expect(review.profile.codex_writable_paths).toEqual([agentDir]);
  });

  it('uses the runtime compiler and rejects a profile the adapter would reject', async () => {
    const defaults = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    writeFileSync(configPath, JSON.stringify({
      agent_name: 'legacy-codex',
      runtime: 'codex-app-server',
      ...defaults,
      codex_env_allowlist: ['PATH'],
    }, null, 2) + '\n');

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
    ]);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/codex_env_allowlist/);
  });

  it('refuses a stale profile hash, stale full-config hash, or registered seat', async () => {
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', '0'.repeat(64), '--expect-config', '0'.repeat(64),
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths).toBeUndefined();

    process.exitCode = undefined;
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', '0'.repeat(64),
    ]);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/changed after review/);

    process.exitCode = undefined;
    ipcState.running = true;
    ipcState.statuses = [{ name: 'legacy-codex', status: 'running' }];
    const configHash = codexConfigHash(readFileSync(configPath, 'utf-8'));
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', configHash,
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths).toBeUndefined();
    expect(existsSync(codexPermissionMigrationHoldPath(ctxRoot, 'legacy-codex')))
      .toBe(false);
  });

  it('accepts absence from a running daemon without changing autostart state', async () => {
    ipcState.running = true;
    ipcState.statuses = [];
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    const configHash = codexConfigHash(readFileSync(configPath, 'utf-8'));
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', configHash,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
      .toEqual([agentDir]);
  });

  it('rejects every registered status, including stopped, halted, and crashed', async () => {
    ipcState.running = true;
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    const configHash = codexConfigHash(readFileSync(configPath, 'utf-8'));
    for (const status of ['stopped', 'halted', 'crashed']) {
      process.exitCode = undefined;
      ipcState.statuses = [{ name: 'legacy-codex', status }];
      await migrateCodexPermissionsCommand.parseAsync([
        'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
        '--apply', '--expect', codexCapabilityProfileHash(profile),
        '--expect-config', configHash,
      ]);
      expect(process.exitCode).toBe(1);
      expect(vi.mocked(console.error).mock.calls.flat().join('\n'))
        .toMatch(new RegExp(`current: ${status}`));
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
        .toBeUndefined();
    }
  });

  it('fails closed on IPC errors, malformed status, or a mismatched CTX_ROOT', async () => {
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    const args = [
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', codexConfigHash(readFileSync(configPath, 'utf-8')),
    ];

    ipcState.error = new Error('IPC request timed out');
    await migrateCodexPermissionsCommand.parseAsync(args);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/could not prove/i);

    process.exitCode = undefined;
    ipcState.error = null;
    ipcState.running = false;
    await migrateCodexPermissionsCommand.parseAsync(args);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/daemon is not running/i);

    process.exitCode = undefined;
    ipcState.running = true;
    ipcState.malformed = true;
    await migrateCodexPermissionsCommand.parseAsync(args);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
      .toBeUndefined();

    process.exitCode = undefined;
    ipcState.malformed = false;
    process.env.CTX_ROOT = join(root, 'different-instance');
    await migrateCodexPermissionsCommand.parseAsync(args);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/different instances/);
  });

  it('refuses to acquire a migration hold while start preparation is claimed', async () => {
    const claimPath = join(ctxRoot, 'state', 'legacy-codex', 'codex-permission-start.claim.json');
    mkdirSync(join(ctxRoot, 'state', 'legacy-codex'), { recursive: true });
    writeFileSync(claimPath, '{}', { mode: 0o600 });
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', codexConfigHash(readFileSync(configPath, 'utf-8')),
    ]);

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/start claim is malformed/);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
      .toBeUndefined();
  });

  it('recovers a strict dead-owner start claim before acquiring the migration hold', async () => {
    const claimPath = codexPermissionStartClaimPath(ctxRoot, 'legacy-codex');
    mkdirSync(join(ctxRoot, 'state', 'legacy-codex'), { recursive: true });
    writeFileSync(claimPath, `${JSON.stringify({
      schemaVersion: 'cortextos-codex-permission-start-claim/v1',
      agent: 'legacy-codex',
      pid: 2_147_483_647,
      nonce: 'a'.repeat(32),
    }, null, 2)}\n`, { mode: 0o600 });
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', codexConfigHash(readFileSync(configPath, 'utf-8')),
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(codexPermissionMigrationHoldPath(ctxRoot, 'legacy-codex')))
      .toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
      .toEqual([agentDir]);
  });

  it('does not repurpose the instance registry autostart bit as migration authority', async () => {
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ 'legacy-codex': { enabled: true, org: 'acme' } }),
    );
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');
    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', codexConfigHash(readFileSync(configPath, 'utf-8')),
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codex_writable_paths)
      .toEqual([agentDir]);
  });

  it('inherits CTX_INSTANCE_ID when --instance is omitted', async () => {
    process.env.CTX_INSTANCE_ID = 'fleet';
    const profile = buildDefaultCodexCapabilityProfile(agentDir, root, 'acme');

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme',
      '--apply', '--expect', codexCapabilityProfileHash(profile),
      '--expect-config', codexConfigHash(readFileSync(configPath, 'utf-8')),
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(ipcState.instances).toEqual(['fleet']);
    expect(existsSync(codexPermissionMigrationHoldPath(
      join(osState.home, '.cortextos', 'fleet'),
      'legacy-codex',
    ))).toBe(false);
  });

  it('rejects disagreement between --instance and CTX_INSTANCE_ID', async () => {
    process.env.CTX_INSTANCE_ID = 'fleet';

    await migrateCodexPermissionsCommand.parseAsync([
      'node', 'cli', 'legacy-codex', '--org', 'acme', '--instance', 'test',
    ]);

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/conflicts with CTX_INSTANCE_ID/);
  });
});
