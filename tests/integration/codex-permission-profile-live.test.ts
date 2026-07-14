import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { CodexAppServerPTY } from '../../src/pty/codex-app-server-pty.js';

/**
 * Source-only live contract test for the real Codex permission-profile parser
 * and sandbox. It starts an isolated temporary app-server but does not run a
 * model turn, install anything, or touch a cortextOS/Fleet service.
 *
 *   CODEX_PERMISSION_PROFILE_LIVE=1 npx vitest run \
 *     tests/integration/codex-permission-profile-live.test.ts
 */
const LIVE = process.env.CODEX_PERMISSION_PROFILE_LIVE === '1';

(LIVE ? describe : describe.skip)('Codex app-server role capability profile (live)', () => {
  let root: string;
  let policyDir: string;
  let roleWorkDir: string;
  let immutablePath: string;
  let nestedControlPath: string;
  let secretPath: string;
  let nodeSurfaceServer: Server;
  let brainSurfaceServer: Server;
  let nodeSurfacePort: number;
  let brainSurfacePort: number;
  let pty: CodexAppServerPTY;

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    return address.port;
  }

  beforeAll(async () => {
    // Keep the test's control socket under the adapter's normal state-dir
    // threshold. The legacy long-path fallback is a separate adapter contract.
    root = mkdtempSync('/tmp/cpl-');
    policyDir = join(root, 'agent-policy');
    roleWorkDir = join(root, 'role-work');
    immutablePath = join(policyDir, 'SYSTEM.md');
    nestedControlPath = join(roleWorkDir, 'AGENTS.md');
    secretPath = join(policyDir, 'secret.env');
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(roleWorkDir, { recursive: true });
    writeFileSync(immutablePath, 'immutable\n', 'utf-8');
    writeFileSync(nestedControlPath, 'immutable role control\n', 'utf-8');
    writeFileSync(secretPath, 'private\n', 'utf-8');

    nodeSurfaceServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('node-surface-target\n');
    });
    brainSurfaceServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('brain-surface-target\n');
    });
    nodeSurfacePort = await listen(nodeSurfaceServer);
    brainSurfacePort = await listen(brainSurfaceServer);

    pty = new CodexAppServerPTY({
      instanceId: 'permission-profile-live',
      ctxRoot: join(root, 'ctx'),
      frameworkRoot: root,
      agentName: 'codex-profile-live',
      agentDir: policyDir,
      org: 'audit',
      projectRoot: root,
    }, {
      runtime: 'codex-app-server',
      working_directory: policyDir,
      codex_credential_deny_paths: [secretPath],
      codex_writable_paths: [roleWorkDir],
      codex_readonly_paths: [nestedControlPath],
      codex_network_allow_domains: [],
      codex_web_search_enabled: true,
      codex_env_allowlist: [],
      codex_mcp_allowlist: [],
    });

    try {
      await pty.spawn('fresh', '');
    } catch (error) {
      throw new Error(`${String(error)}\n${pty.getOutputBuffer().getRecent()}`);
    }
  }, 30_000);

  afterAll(async () => {
    try {
      pty?.kill();
    } catch {
      // Best-effort cleanup for a test-only process.
    }
    await Promise.all([
      new Promise<void>((resolve) => nodeSurfaceServer?.close(() => resolve())),
      new Promise<void>((resolve) => brainSurfaceServer?.close(() => resolve())),
    ]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function commandFor(
    targetPty: CodexAppServerPTY,
    commandCwd: string,
    command: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const profileId = (targetPty as unknown as { _permissionProfileId: string })._permissionProfileId;
    let response: { result?: { exitCode: number; stdout: string; stderr: string } };
    try {
      response = await (targetPty as unknown as {
        request<T>(method: string, params: unknown): Promise<{ result?: T }>;
      }).request<{ exitCode: number; stdout: string; stderr: string }>('command/exec', {
        command: ['/bin/sh', '-c', command],
        cwd: commandCwd,
        permissionProfile: profileId,
        timeoutMs: 5_000,
      });
    } catch (error) {
      throw new Error(`${String(error)}\n${targetPty.getOutputBuffer().getRecent()}`);
    }
    if (!response.result) throw new Error('command/exec returned no result');
    return response.result;
  }

  async function command(commandText: string) {
    return commandFor(pty, policyDir, commandText);
  }

  it('allows arbitrary creation inside the broad role work root', async () => {
    const nested = join(roleWorkDir, 'new', 'artifact.txt');
    const result = await command(`mkdir -p '${join(roleWorkDir, 'new')}' && printf work > '${nested}'`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(nested)).toBe(true);
  });

  it('keeps the policy directory read-only', async () => {
    const result = await command(`printf changed >> '${immutablePath}'`);
    expect(result.exitCode).not.toBe(0);
  });

  it('keeps nested control files read-only inside a broad writable work root', async () => {
    const result = await command(`printf changed >> '${nestedControlPath}'`);
    expect(result.exitCode).not.toBe(0);
  });

  it('allows normal private temp use while ambient /tmp remains unavailable', async () => {
    const modelTempDir = (pty as unknown as { _modelTempDir: string })._modelTempDir;
    const result = await command(
      'created=$(mktemp) && printf scratch > "$created" '
      + '&& printf "%s\\n%s\\n%s\\n%s\\n" "$TMPDIR" "$TMP" "$TEMP" "$created"',
    );
    expect(result.exitCode).toBe(0);
    const [tmpdirEnv, tmpEnv, tempEnv, created] = result.stdout.trim().split('\n');
    expect(tmpdirEnv).toBe(modelTempDir);
    expect(tmpEnv).toBe(modelTempDir);
    expect(tempEnv).toBe(modelTempDir);
    expect(created).toMatch(new RegExp(`^${modelTempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

    const ambient = join('/tmp', `codex-ambient-${process.pid}`);
    const blocked = await command(`printf blocked > '${ambient}'`);
    expect(blocked.exitCode).not.toBe(0);
    expect(existsSync(ambient)).toBe(false);
  });

  it('cannot use private-temp staging to delete, replace, or symlink through control policy', async () => {
    const modelTempDir = (pty as unknown as { _modelTempDir: string })._modelTempDir;
    const remove = await command(`rm -f '${nestedControlPath}'`);
    expect(remove.exitCode).not.toBe(0);
    expect(existsSync(nestedControlPath)).toBe(true);

    const staged = join(modelTempDir, 'staged-control');
    const replace = await command(`printf replacement > '${staged}' && mv -f '${staged}' '${nestedControlPath}'`);
    expect(replace.exitCode).not.toBe(0);
    expect(existsSync(nestedControlPath)).toBe(true);

    const alias = join(modelTempDir, 'control-alias');
    const symlinkEscape = await command(`ln -s '${nestedControlPath}' '${alias}' && printf changed >> '${alias}'`);
    expect(symlinkEscape.exitCode).not.toBe(0);
  });

  it('denies reads of an exact credential path', async () => {
    const result = await command(`test -r '${secretPath}'`);
    expect(result.exitCode).not.toBe(0);
  });

  it('fails pre-launch when a credential inode already has another readable name', () => {
    const alias = join(roleWorkDir, 'preexisting-secret-hardlink');
    linkSync(secretPath, alias);
    try {
      expect(() => new CodexAppServerPTY({
        instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-hardlink'),
        frameworkRoot: root, agentName: 'hardlink-test', agentDir: policyDir,
        org: 'audit', projectRoot: root,
      }, {
        runtime: 'codex-app-server', working_directory: policyDir,
        codex_credential_deny_paths: [secretPath],
        codex_writable_paths: [roleWorkDir], codex_readonly_paths: [],
        codex_network_allow_domains: [], codex_web_search_enabled: false,
        codex_env_allowlist: [],
        codex_mcp_allowlist: [],
      })).toThrow(/hard-linked file/);
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it('fails pre-launch when a read-only control inode has a writable alias', () => {
    const alias = join(roleWorkDir, 'preexisting-control-hardlink');
    linkSync(nestedControlPath, alias);
    try {
      expect(() => new CodexAppServerPTY({
        instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-control-hardlink'),
        frameworkRoot: root, agentName: 'control-hardlink-test', agentDir: policyDir,
        org: 'audit', projectRoot: root,
      }, {
        runtime: 'codex-app-server', working_directory: policyDir,
        codex_credential_deny_paths: [secretPath],
        codex_writable_paths: [roleWorkDir], codex_readonly_paths: [nestedControlPath],
        codex_network_allow_domains: [], codex_web_search_enabled: false,
        codex_env_allowlist: [],
        codex_mcp_allowlist: [],
      })).toThrow(/codex_readonly_paths contains a hard-linked file/);
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it('blocks creation of a new credential hard-link after launch', async () => {
    const alias = join(roleWorkDir, 'runtime-secret-hardlink');
    const result = await command(`ln '${secretPath}' '${alias}'`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(alias)).toBe(false);
  });

  it('denies model access to the app-server control socket', async () => {
    const socketPath = (pty as unknown as { _socketPath: string })._socketPath;
    const script = [
      "const net=require('net')",
      `const socket=net.createConnection(${JSON.stringify(socketPath)})`,
      "socket.on('connect',()=>process.exit(0))",
      "socket.on('error',()=>process.exit(7))",
      "setTimeout(()=>process.exit(8),1000)",
    ].join(';');
    const result = await command(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
    expect(result.exitCode).not.toBe(0);

    const modelTempDir = (pty as unknown as { _modelTempDir: string })._modelTempDir;
    const alias = join(modelTempDir, 'socket-alias');
    const aliasScript = [
      "const net=require('net')",
      `const socket=net.createConnection(${JSON.stringify(alias)})`,
      "socket.on('connect',()=>process.exit(0))",
      "socket.on('error',()=>process.exit(7))",
      "setTimeout(()=>process.exit(8),1000)",
    ].join(';');
    const aliased = await command(
      `ln -s '${socketPath}' '${alias}' && ${JSON.stringify(process.execPath)} -e ${JSON.stringify(aliasScript)}`,
    );
    expect(aliased.exitCode).not.toBe(0);
  });

  it('rejects descendant and symlink capability entries that would reopen stronger policy', () => {
    const alias = join(root, 'secret-alias');
    symlinkSync(secretPath, alias);
    const base = {
      runtime: 'codex-app-server' as const,
      working_directory: policyDir,
      codex_credential_deny_paths: [secretPath],
      codex_writable_paths: [roleWorkDir],
      codex_readonly_paths: [nestedControlPath],
      codex_network_allow_domains: [],
      codex_web_search_enabled: false,
      codex_env_allowlist: [],
      codex_mcp_allowlist: [],
    };

    expect(() => new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-alias'),
      frameworkRoot: root, agentName: 'alias-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, { ...base, codex_readonly_paths: [alias] })).toThrow(/must not contain symbolic links/);
    expect(() => new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-denied-child'),
      frameworkRoot: root, agentName: 'denied-child-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, {
      ...base,
      codex_credential_deny_paths: [policyDir],
      codex_writable_paths: [roleWorkDir],
      codex_readonly_paths: [immutablePath],
    })).toThrow(/must not equal or descend/);
    expect(() => new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-read-child'),
      frameworkRoot: root, agentName: 'read-child-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, {
      ...base,
      codex_readonly_paths: [roleWorkDir],
      codex_writable_paths: [join(roleWorkDir, 'output')],
    })).toThrow(/must not equal or descend/);

    const nested = join(roleWorkDir, 'renameable', 'controls');
    mkdirSync(nested, { recursive: true });
    const nestedPolicy = join(nested, 'AGENTS.md');
    const nestedCredential = join(nested, 'secret.env');
    writeFileSync(nestedPolicy, 'control\n');
    writeFileSync(nestedCredential, 'private\n');
    expect(() => new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-nested-readonly'),
      frameworkRoot: root, agentName: 'nested-readonly-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, {
      ...base,
      codex_readonly_paths: [nestedPolicy],
    })).toThrow(/renameable writable intermediate/);
    expect(() => new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-nested-deny'),
      frameworkRoot: root, agentName: 'nested-deny-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, {
      ...base,
      codex_credential_deny_paths: [nestedCredential],
      codex_readonly_paths: [],
    })).toThrow(/renameable writable intermediate/);
  });

  it('accepts the role cwd as an implicit writable root', async () => {
    const implicitCwd = join(root, 'implicit-role-work');
    mkdirSync(implicitCwd);
    const implicit = new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-implicit'),
      frameworkRoot: root, agentName: 'implicit-cwd-test', agentDir: implicitCwd,
      org: 'audit', projectRoot: root,
    }, {
      runtime: 'codex-app-server', working_directory: implicitCwd,
      codex_credential_deny_paths: [secretPath],
      codex_writable_paths: [implicitCwd], codex_readonly_paths: [],
      codex_network_allow_domains: [], codex_web_search_enabled: false,
      codex_env_allowlist: [],
      codex_mcp_allowlist: [],
    });
    try {
      await implicit.spawn('fresh', '');
      const output = join(implicitCwd, 'created.txt');
      const result = await commandFor(implicit, implicitCwd, `printf work > '${output}'`);
      expect(result.exitCode).toBe(0);
      expect(existsSync(output)).toBe(true);
    } finally {
      implicit.kill();
    }
  }, 30_000);

  it('accepts a fully read-only profile with no writableRoots member', async () => {
    const readonly = new CodexAppServerPTY({
      instanceId: 'permission-profile-live', ctxRoot: join(root, 'ctx-readonly'),
      frameworkRoot: root, agentName: 'readonly-test', agentDir: policyDir,
      org: 'audit', projectRoot: root,
    }, {
      runtime: 'codex-app-server', working_directory: policyDir,
      codex_credential_deny_paths: [secretPath], codex_writable_paths: [],
      codex_readonly_paths: [], codex_network_allow_domains: [],
      codex_web_search_enabled: false, codex_env_allowlist: [],
      codex_mcp_allowlist: [],
    });
    try {
      await readonly.spawn('fresh', '');
      const result = await commandFor(
        readonly, policyDir, `printf changed >> '${immutablePath}'`,
      );
      expect(result.exitCode).not.toBe(0);
    } finally {
      readonly.kill();
    }
  }, 30_000);

  it('denies both canonical loopback surfaces when raw network is disabled', async () => {
    const nodeSurface = await command(
      `/usr/bin/curl --silent --show-error --fail --max-time 3 http://127.0.0.1:${nodeSurfacePort}/`,
    );
    expect(nodeSurface.exitCode).not.toBe(0);
    expect(nodeSurface.stdout).not.toContain('node-surface-target');

    const brainSurface = await command(
      `/usr/bin/curl --silent --show-error --fail --max-time 3 http://127.0.0.1:${brainSurfacePort}/`,
    );
    expect(brainSurface.exitCode).not.toBe(0);
    expect(brainSurface.stdout).not.toContain('brain-surface-target');
  });
});
