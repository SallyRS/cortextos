import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  appendFileSync: vi.fn(),
  chmodSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get chmodSync() { return fsMocks.chmodSync; },
    get lstatSync() { return fsMocks.lstatSync; },
    get mkdirSync() { return fsMocks.mkdirSync; },
    get readdirSync() { return fsMocks.readdirSync; },
    get rmSync() { return fsMocks.rmSync; },
  };
});

const atomicWriteSyncMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: atomicWriteSyncMock,
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 88,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  }),
}));

const requestMock = vi.fn();
const notifyMock = vi.fn();
const closeMock = vi.fn();
const respondErrorMock = vi.fn();
const logEventMock = vi.fn();
let messageHandler: ((message: unknown) => void) | null = null;

vi.mock('../../../src/utils/ws-unix-client.js', () => ({
  WsUnixJsonRpcClient: vi.fn().mockImplementation(function WsUnixJsonRpcClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: closeMock,
      notify: notifyMock,
      respondError: respondErrorMock,
      onMessage: vi.fn().mockImplementation((handler: (message: unknown) => void) => {
        messageHandler = handler;
        return vi.fn();
      }),
      request: requestMock,
    };
  }),
}));

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: logEventMock,
}));

const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const credentialSecretPath = '/tmp/command-center/brain/.env';
const secureConfig = {
  codex_credential_deny_paths: [credentialSecretPath],
  codex_writable_paths: ['/tmp/fw/role-work'],
  codex_readonly_paths: ['/tmp/fw/role-work/AGENTS.md'],
  codex_network_allow_domains: [],
  codex_env_allowlist: ['CC_AGENT_ACTION_TOKEN'],
  codex_mcp_allowlist: [],
};

function permissionProfileId(pty: InstanceType<typeof CodexAppServerPTY>): string {
  return (pty as unknown as { _permissionProfileId: string })._permissionProfileId;
}

function effectiveWritablePaths(pty: InstanceType<typeof CodexAppServerPTY>): string[] {
  return (pty as unknown as { _writablePaths: string[] })._writablePaths;
}

function safeThreadResult(
  pty: InstanceType<typeof CodexAppServerPTY>,
  threadId: string,
) {
  return {
    thread: { id: threadId },
    activePermissionProfile: { id: permissionProfileId(pty), extends: ':read-only' },
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: effectiveWritablePaths(pty),
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    },
  };
}

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.chmodSync.mockReset();
  fsMocks.lstatSync.mockReset().mockReturnValue({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
    nlink: 1,
  });
  fsMocks.mkdirSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
  fsMocks.rmSync.mockReset();
  requestMock.mockReset();
  notifyMock.mockReset();
  closeMock.mockReset();
  respondErrorMock.mockReset();
  logEventMock.mockReset();
  atomicWriteSyncMock.mockReset();
  spawnSyncMock.mockReset().mockReturnValue({
    status: 0,
    stdout: '[]',
    stderr: '',
    error: undefined,
  });
  messageHandler = null;
});

describe('CodexAppServerPTY socket path policy', () => {
  it('does not launch a replacement app-server after kill cancels retry backoff', async () => {
    vi.useFakeTimers();
    let start: ReturnType<typeof vi.spyOn> | null = null;
    try {
      const pty = new CodexAppServerPTY(mockEnv, secureConfig);
      const internals = pty as unknown as {
        _alive: boolean;
        startAppServer(): Promise<void>;
        startAppServerWithRetry(): Promise<void>;
      };
      internals._alive = true;
      start = vi.spyOn(internals, 'startAppServer')
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValue(undefined);

      const retry = internals.startAppServerWithRetry();
      const result = retry.then(
        () => null,
        (err: unknown) => err as Error,
      );
      await Promise.resolve();
      pty.kill();
      await vi.advanceTimersByTimeAsync(1_000);

      expect((await result)?.message).toMatch(/startup was cancelled/);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      start?.mockRestore();
      vi.useRealTimers();
    }
  });

  it('still retries an unexpected app-server exit that was not an operator cancellation', async () => {
    vi.useFakeTimers();
    let start: ReturnType<typeof vi.spyOn> | null = null;
    let prepareTemp: ReturnType<typeof vi.spyOn> | null = null;
    try {
      const pty = new CodexAppServerPTY(mockEnv, secureConfig);
      const internals = pty as unknown as {
        _alive: boolean;
        preparePrivateModelTempDir(): void;
        startAppServer(): Promise<void>;
        startAppServerWithRetry(): Promise<void>;
      };
      internals._alive = true;
      prepareTemp = vi.spyOn(internals, 'preparePrivateModelTempDir');
      start = vi.spyOn(internals, 'startAppServer')
        .mockImplementationOnce(async () => {
          internals._alive = false;
          throw new Error('child exited');
        })
        .mockResolvedValue(undefined);

      const retry = internals.startAppServerWithRetry();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(retry).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(2);
      expect(prepareTemp).toHaveBeenCalledTimes(2);
    } finally {
      prepareTemp?.mockRestore();
      start?.mockRestore();
      vi.useRealTimers();
    }
  });

  it('uses codex.sock in the agent state dir by default', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    expect((pty as unknown as { _socketPath: string })._socketPath).toBe('/tmp/ctx/state/codex-app-agent/codex.sock');
    expect((pty as unknown as { _socketListenArg: string })._socketListenArg).toBe('unix://./codex.sock');
  });

  it('falls back to /tmp/cas-*.sock when the state socket path is too long', () => {
    const longEnv = {
      ...mockEnv,
      ctxRoot: `/tmp/${'x'.repeat(120)}`,
    };
    const pty = new CodexAppServerPTY(longEnv, secureConfig);
    const socketPath = (pty as unknown as { _socketPath: string })._socketPath;
    const profileId = permissionProfileId(pty);
    const args = (pty as unknown as { _permissionProfileConfigArgs: string[] })._permissionProfileConfigArgs;
    const overrides = args.filter((_, index) => index % 2 === 1);
    expect(socketPath).toMatch(/\/cas-[a-f0-9]{8}\.sock$/);
    expect((pty as unknown as { _socketListenArg: string })._socketListenArg).toMatch(/^unix:\/\/\.\/cas-[a-f0-9]{8}\.sock$/);
    expect((pty as unknown as { _socketCwd: string })._socketCwd).toBe('/tmp');
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-socket.json'),
      expect.stringContaining('"fallback": true'),
      'utf-8',
    );
    expect(overrides.find((value) => value.startsWith(`permissions.${profileId}.filesystem=`)))
      .toContain(`${JSON.stringify(socketPath)}=\"deny\"`);
    expect(overrides).toContain(
      `permissions.${profileId}.network.unix_sockets={${JSON.stringify(socketPath)}=\"deny\"}`,
    );
  });
});

describe('CodexAppServerPTY permission profile policy', () => {
  it('rejects a hard-linked read-only control file before RPC setup', () => {
    const readonlyPath = secureConfig.codex_readonly_paths[0];
    fsMocks.existsSync.mockImplementation((path) => path === readonlyPath);
    fsMocks.lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
      nlink: 2,
    });

    expect(() => new CodexAppServerPTY(mockEnv, secureConfig))
      .toThrow(/codex_readonly_paths contains a hard-linked file/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    [],
    ['relative/brain/.env'],
    ['/tmp/../brain/.env'],
    [''],
    [' /tmp/brain/.env'],
    ['/tmp/brain/.env\0suffix'],
    [42],
  ])('rejects a missing or malformed absolute credential deny list before RPC setup: %j', (paths) => {
    expect(() => new CodexAppServerPTY(mockEnv, {
      codex_credential_deny_paths: paths,
    })).toThrow(/codex_credential_deny_paths/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...secureConfig, codex_writable_paths: undefined }, /codex_writable_paths/],
    [{ ...secureConfig, codex_writable_paths: ['relative'] }, /codex_writable_paths/],
    [{
      ...secureConfig,
      codex_credential_deny_paths: ['/tmp/denied'],
      codex_writable_paths: ['/tmp/denied/child'],
    }, /must not equal or descend/],
    [{ ...secureConfig, codex_readonly_paths: undefined }, /codex_readonly_paths/],
    [{ ...secureConfig, codex_readonly_paths: ['relative'] }, /codex_readonly_paths/],
    [{
      ...secureConfig,
      codex_credential_deny_paths: ['/tmp/denied'],
      codex_readonly_paths: ['/tmp/denied/child'],
    }, /must not equal or descend/],
    [{
      ...secureConfig,
      codex_readonly_paths: ['/tmp/role-policy'],
      codex_writable_paths: ['/tmp/role-policy/output'],
    }, /must not equal or descend/],
    [{
      ...secureConfig,
      codex_writable_paths: ['/tmp/role-work'],
      codex_readonly_paths: ['/tmp/role-work/nested/AGENTS.md'],
    }, /renameable writable intermediate/],
    [{
      ...secureConfig,
      codex_credential_deny_paths: ['/tmp/role-work/nested/secret.env'],
      codex_writable_paths: ['/tmp/role-work'],
      codex_readonly_paths: [],
    }, /renameable writable intermediate/],
    [{ ...secureConfig, codex_network_allow_domains: undefined }, /codex_network_allow_domains/],
    [{ ...secureConfig, codex_network_allow_domains: ['*'] }, /codex_network_allow_domains/],
    [{ ...secureConfig, codex_network_allow_domains: ['127.0.0.1:8091'] }, /must remain empty/],
    [{ ...secureConfig, codex_env_allowlist: undefined }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_env_allowlist: ['PATH'] }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_env_allowlist: ['CTX_ROOT'] }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_env_allowlist: ['DYLD_INSERT_LIBRARIES'] }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_env_allowlist: ['NODE_OPTIONS'] }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_env_allowlist: ['HTTPS_PROXY'] }, /codex_env_allowlist/],
    [{ ...secureConfig, codex_mcp_allowlist: undefined }, /codex_mcp_allowlist/],
    [{ ...secureConfig, codex_mcp_allowlist: [' bad '] }, /codex_mcp_allowlist/],
  ])('rejects malformed explicit role capability policy: %j', (config, expected) => {
    expect(() => new CodexAppServerPTY(mockEnv, config)).toThrow(expected);
  });

  it('compiles a unique read-only-base profile with broad role-work writes and exact control-plane denies', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const secondPty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    const socketPath = '/tmp/ctx/state/codex-app-agent/codex.sock';
    const args = (pty as unknown as { _permissionProfileConfigArgs: string[] })._permissionProfileConfigArgs;
    const overrides = args.filter((_, index) => index % 2 === 1);

    expect(profileId).toMatch(/^cortextos-fleet-[a-f0-9]{16}$/);
    expect(permissionProfileId(secondPty)).not.toBe(profileId);
    expect(overrides).toContain(`permissions.${profileId}.extends=\":read-only\"`);
    const filesystem = overrides.find((value) => value.startsWith(`permissions.${profileId}.filesystem=`));
    expect(filesystem).toContain(`${JSON.stringify(credentialSecretPath)}=\"deny\"`);
    expect(filesystem).toContain(`${JSON.stringify(socketPath)}=\"deny\"`);
    expect(filesystem).toContain(`${JSON.stringify('/tmp/fw/role-work')}=\"write\"`);
    expect(filesystem).toContain(`${JSON.stringify('/tmp/ctx/state/codex-app-agent/model-tmp')}=\"write\"`);
    expect(filesystem).toContain(`${JSON.stringify('/tmp/fw/role-work/AGENTS.md')}=\"read\"`);
    expect(overrides).toContain(
      `permissions.${profileId}.network.unix_sockets={${JSON.stringify(socketPath)}=\"deny\"}`,
    );
    expect(overrides).toContain(`permissions.${profileId}.network.enabled=false`);
    expect(overrides.some((value) => value.startsWith(
      `permissions.${profileId}.network.domains=`,
    ))).toBe(false);
    expect(JSON.stringify(args)).not.toContain('*');
    expect(JSON.stringify(args)).not.toMatch(/danger-full-access|dangerFullAccess|sandbox_mode/);
  });

  it.each([
    { entries: [], expected: /not available/ },
    { entries: [{ id: 'PROFILE_ID', allowed: false }], expected: /not allowed/ },
  ])('fails closed when the provisioned named profile is missing or disallowed', async ({ entries, expected }) => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    requestMock.mockResolvedValue({
      result: {
        data: entries.map((entry) => ({
          ...entry,
          id: entry.id === 'PROFILE_ID' ? profileId : entry.id,
        })),
        nextCursor: null,
      },
    });

    await expect((pty as unknown as { verifyPermissionProfileAvailable(): Promise<void> })
      .verifyPermissionProfileAvailable()).rejects.toThrow(expected);
    expect(requestMock).toHaveBeenCalledWith('permissionProfile/list', {
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
    });
  });

  it('verifies paginated active MCP status and accepts only inert unapproved placeholders', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    requestMock
      .mockResolvedValueOnce({ result: {
        data: [{
          name: 'ambient-one', serverInfo: null, tools: {}, resources: [],
          resourceTemplates: [], authStatus: 'unsupported',
        }],
        nextCursor: 'page-2',
      } })
      .mockResolvedValueOnce({ result: {
        data: [{
          name: 'ambient-two', serverInfo: null, tools: {}, resources: [],
          resourceTemplates: [], authStatus: 'unsupported',
        }],
        nextCursor: null,
      } });

    await expect((pty as unknown as { verifyMcpStatusReadback(): Promise<void> })
      .verifyMcpStatusReadback()).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenNthCalledWith(2, 'mcpServerStatus/list', {
      cursor: 'page-2', limit: 100, detail: 'toolsAndAuthOnly',
    });
  });

  it('waits for an approved MCP to move from starting to ready before paginated inventory read-back', async () => {
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    requestMock
      .mockResolvedValueOnce({ result: {
        data: [{
          name: 'ambient', serverInfo: null, tools: {}, resources: [],
          resourceTemplates: [], authStatus: 'unsupported',
        }],
        nextCursor: 'page-2',
      } })
      .mockResolvedValueOnce({ result: {
        data: [{
          name: 'approved-role-server', serverInfo: { name: 'approved-role-server' },
          tools: { read: {} }, resources: [], resourceTemplates: [], authStatus: 'notRequired',
        }],
        nextCursor: null,
      } });
    const internals = pty as unknown as {
      _alive: boolean;
      verifyMcpStatusReadback(timeoutMs?: number): Promise<void>;
      handleRpcMessage(message: unknown): void;
    };
    internals._alive = true;

    const verification = internals.verifyMcpStatusReadback(1_000);
    internals.handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'approved-role-server', status: 'starting' },
    });
    await Promise.resolve();
    expect(requestMock).not.toHaveBeenCalled();

    internals.handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'approved-role-server', status: 'ready' },
    });
    await expect(verification).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenNthCalledWith(2, 'mcpServerStatus/list', {
      cursor: 'page-2', limit: 100, detail: 'toolsAndAuthOnly',
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'fails readiness immediately when an approved MCP reports %s',
    async (status) => {
      const pty = new CodexAppServerPTY(mockEnv, {
        ...secureConfig,
        codex_mcp_allowlist: ['approved-role-server'],
      });
      const internals = pty as unknown as {
        _alive: boolean;
        verifyMcpStatusReadback(timeoutMs?: number): Promise<void>;
        handleRpcMessage(message: unknown): void;
      };
      internals._alive = true;

      const verification = internals.verifyMcpStatusReadback(10_000);
      internals.handleRpcMessage({
        method: 'mcpServer/startupStatus/updated',
        params: { name: 'approved-role-server', status },
      });

      await expect(verification).rejects.toThrow(/did not become available/);
      expect(requestMock).not.toHaveBeenCalled();
    },
  );

  it('fails readiness on a bounded timeout without reading a premature inventory', async () => {
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });
    (pty as unknown as { _alive: boolean })._alive = true;

    await expect((pty as unknown as {
      verifyMcpStatusReadback(timeoutMs?: number): Promise<void>;
    }).verifyMcpStatusReadback(5)).rejects.toThrow(
      /Timed out waiting for approved MCP servers to become ready: approved-role-server=pending/,
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('fails active read-back for a capable ambient MCP or an inactive approved MCP', async () => {
    const ambient = new CodexAppServerPTY(mockEnv, secureConfig);
    (ambient as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    requestMock.mockResolvedValue({ result: {
      data: [{
        name: 'ambient', serverInfo: { name: 'ambient' }, tools: { send: {} },
        resources: [], resourceTemplates: [], authStatus: 'bearerToken',
      }],
      nextCursor: null,
    } });
    await expect((ambient as unknown as { verifyMcpStatusReadback(): Promise<void> })
      .verifyMcpStatusReadback()).rejects.toThrow(/not inert/);

    requestMock.mockReset().mockResolvedValue({ result: {
      data: [{
        name: 'approved-role-server', serverInfo: null, tools: {},
        resources: [], resourceTemplates: [], authStatus: 'unsupported',
      }],
      nextCursor: null,
    } });
    const approved = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });
    (approved as unknown as { _alive: boolean })._alive = true;
    (approved as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    (approved as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'approved-role-server', status: 'ready' },
    });
    await expect((approved as unknown as { verifyMcpStatusReadback(): Promise<void> })
      .verifyMcpStatusReadback()).rejects.toThrow(/not active/);
  });

  it('spawns app-server with strict generated config and no danger override', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ name: 'ambient-host-server', enabled: true }]),
      stderr: '',
      error: undefined,
    });
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const spawn = vi.fn().mockReturnValue({
      pid: 88,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
    });
    (pty as unknown as { _spawnFn: typeof spawn })._spawnFn = spawn;
    (pty as unknown as { _alive: boolean })._alive = true;
    fsMocks.existsSync.mockReturnValue(true);

    await (pty as unknown as { startAppServer(): Promise<void> }).startAppServer();

    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toContain('--strict-config');
    for (const feature of ['apps', 'plugins', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation']) {
      expect(args).toContain(feature);
    }
    expect(args).toContain('mcp_servers={\"ambient-host-server\"={enabled=false}}');
    expect(args.some((arg) => arg.includes(permissionProfileId(pty)))).toBe(true);
    expect(JSON.stringify(args)).not.toMatch(/danger-full-access|dangerFullAccess|sandbox_mode/);
  });

  it('cleans private temp and socket state on an unexpected app-server exit', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const publishedExit = vi.fn();
    pty.onExit(publishedExit);
    let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    const spawn = vi.fn().mockReturnValue({
      pid: 88,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((handler) => { exitHandler = handler; }),
      kill: vi.fn(),
    });
    (pty as unknown as { _spawnFn: typeof spawn; _alive: boolean })._spawnFn = spawn;
    (pty as unknown as { _alive: boolean })._alive = true;
    (pty as unknown as { _startupComplete: boolean })._startupComplete = true;
    fsMocks.existsSync.mockReturnValue(true);

    await (pty as unknown as { startAppServer(): Promise<void> }).startAppServer();
    expect(exitHandler).not.toBeNull();
    (exitHandler as unknown as (event: { exitCode: number }) => void)({ exitCode: 1 });

    expect(fsMocks.rmSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/codex-app-agent/model-tmp',
      { recursive: true, force: true },
    );
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/codex-app-agent/codex.sock',
    );
    expect(publishedExit).toHaveBeenCalledWith(1, undefined);
  });

  it('keeps a failed internal app-server attempt inside the adapter retry boundary', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const publishedExit = vi.fn();
    pty.onExit(publishedExit);
    let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    const spawn = vi.fn().mockReturnValue({
      pid: 88,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((handler) => { exitHandler = handler; }),
      kill: vi.fn(),
    });
    (pty as unknown as { _spawnFn: typeof spawn; _alive: boolean })._spawnFn = spawn;
    (pty as unknown as { _alive: boolean })._alive = true;
    fsMocks.existsSync.mockReturnValue(true);

    await (pty as unknown as { startAppServer(): Promise<void> }).startAppServer();
    (exitHandler as unknown as (event: { exitCode: number }) => void)({ exitCode: 1 });

    expect(publishedExit).not.toHaveBeenCalled();
  });

  it('discovers host MCP configuration privately and disables every server outside the role allowlist', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { name: 'approved-role-server', enabled: true, transport: { authorization: 'must-not-log' } },
        { name: 'ambient-host-server', enabled: true, transport: { authorization: 'must-not-log' } },
      ]),
      stderr: '',
      error: undefined,
    });
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });

    const args = (pty as unknown as { buildMcpConfigArgs(): string[] }).buildMcpConfigArgs();

    expect(args).toEqual(['-c', 'mcp_servers={"ambient-host-server"={enabled=false}}']);
    expect(JSON.stringify(args)).not.toContain('must-not-log');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['--disable', 'apps', '--disable', 'plugins', 'mcp', 'list', '--json']),
      expect.objectContaining({
        cwd: mockEnv.agentDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      }),
    );
  });

  it('fails closed when an allowlisted MCP server is absent or disabled', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ name: 'approved-role-server', enabled: false }]),
      stderr: '',
      error: undefined,
    });
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });

    expect(() => (pty as unknown as { buildMcpConfigArgs(): string[] }).buildMcpConfigArgs())
      .toThrow(/not configured and enabled/);
  });

  it('loads only explicitly allowlisted role secrets from inherited env files', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue([
      'CC_AGENT_ACTION_TOKEN=scoped-test-token',
      'ANTHROPIC_API_KEY=must-not-inherit',
      'PATH=/hostile/path',
      '',
    ].join('\n'));
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);

    const env = (pty as unknown as { buildEnv(): Record<string, string> }).buildEnv();

    expect(env.CC_AGENT_ACTION_TOKEN).toBe('scoped-test-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).not.toBe('/hostile/path');
    expect(env.CTX_AGENT_NAME).toBe('codex-app-agent');
    expect(env.TMPDIR).toBe('/tmp/ctx/state/codex-app-agent/model-tmp');
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
  });

  it('prepares only a private model temp child and rejects a symlinked state directory', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { preparePrivateModelTempDir(): void }).preparePrivateModelTempDir();

    expect(fsMocks.chmodSync).toHaveBeenCalledWith('/tmp/ctx/state/codex-app-agent', 0o700);
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/codex-app-agent/model-tmp',
      { recursive: false, mode: 0o700 },
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith(
      '/tmp/ctx/state/codex-app-agent/model-tmp',
      0o700,
    );

    fsMocks.lstatSync.mockReturnValueOnce({
      isSymbolicLink: () => true,
      isDirectory: () => false,
    });
    expect(() => (pty as unknown as { preparePrivateModelTempDir(): void })
      .preparePrivateModelTempDir()).toThrow(/state directory must be a real directory/);
  });
});

describe('CodexAppServerPTY command mapping', () => {
  function makeReadyPty() {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';
    (pty as unknown as { _rpc: { request: typeof requestMock; respondError: typeof respondErrorMock } })._rpc = {
      request: requestMock,
      respondError: respondErrorMock,
    };
    return pty;
  }

  it('maps /goal to thread/goal/get', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(pty.getOutputBuffer().getRecent()).toContain('[goal] none set');
  });

  it('maps Telegram-delivered /goal with bot suffix to native goal get', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
[Recent conversation:]
[user]: prior
\`\`\`
old fenced text
\`\`\`
/goal@codex_app_server_test_bot
[Your last message: "previous"]
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(pty.getOutputBuffer().getRecent()).toContain('[goal] none set');
  });

  it('maps Telegram-delivered /goal set and clear variants without starting a turn', async () => {
    requestMock
      .mockResolvedValueOnce({ result: { goal: { status: 'active' } } })
      .mockResolvedValueOnce({ result: { cleared: true } });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/goal@codex_app_server_test_bot Ship native slash routing
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/goal clear
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'thread/goal/set', {
      threadId: 'thread-1',
      objective: 'Ship native slash routing',
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'thread/goal/clear', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('maps /goal clear to thread/goal/clear', async () => {
    requestMock.mockResolvedValue({ result: { cleared: true } });
    const pty = makeReadyPty();
    pty.write('/goal clear');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/clear', { threadId: 'thread-1' });
  });

  it('mirrors /goal get reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] none set', undefined, { parseMode: null });
  });

  it('mirrors /goal set reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { goal: { status: 'active' } } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal Ship native slash routing');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] active: Ship native slash routing', undefined, { parseMode: null });
  });

  it('mirrors /goal clear reply to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { cleared: true } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/goal clear');
    pty.write('\r');
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith('7940429114', '[goal] cleared', undefined, { parseMode: null });
  });

  it('mirrors unknown $skill error to Telegram when handle is bound', async () => {
    requestMock.mockResolvedValue({ result: { data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }] } });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('$nonexistent_skill');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(
      '7940429114',
      '[skill] unknown "nonexistent_skill". No enabled matches found.',
      undefined,
      { parseMode: null },
    );
  });

  it('does not fall back to text for unknown skills', async () => {
    requestMock.mockResolvedValue({ result: { data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }] } });
    const pty = makeReadyPty();
    pty.write('$imag');
    pty.write('\r');
    await Promise.resolve();
    expect(pty.getOutputBuffer().getRecent()).toContain('Did you mean: imagegen');
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('maps Telegram-fenced $skill input to native UserInput.skill', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
\`\`\`
$imagegen make a logo
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'imagegen', path: '/skill.md' },
        { type: 'text', text: 'make a logo', text_elements: [] },
      ],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });
  });

  it('maps exact $skill input to native UserInput.skill', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'imagegen', path: '/skill.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('$imagegen make a logo');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'imagegen', path: '/skill.md' },
        { type: 'text', text: 'make a logo', text_elements: [] },
      ],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'turn/completed',
      params: {},
    });
  });

  it('rewrites /skill_name to native UserInput.skill via skills/list', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('/heartbeat');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(1, 'skills/list', {
      cwds: ['/tmp/fw/orgs/acme/agents/codex-app-agent'],
      forceReload: false,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'skill', name: 'heartbeat', path: '/h.md' }],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });
  });

  it('preserves /goal in the local goal handler (does not rewrite to skill)', async () => {
    requestMock.mockResolvedValue({ result: { goal: null } });
    const pty = makeReadyPty();
    pty.write('/goal');
    pty.write('\r');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' });
    expect(requestMock).not.toHaveBeenCalledWith('skills/list', expect.anything());
  });

  it('replies with [skill] unknown for an unknown slash command', async () => {
    requestMock.mockResolvedValue({
      result: { data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }] },
    });
    const pty = makeReadyPty();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    pty.setTelegramHandle({ sendMessage } as unknown as Parameters<typeof pty.setTelegramHandle>[0], '7940429114');
    pty.write('/notaskill');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(
      '7940429114',
      '[skill] unknown "notaskill". No enabled matches found.',
      undefined,
      { parseMode: null },
    );
    expect(requestMock).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('preserves trailing text payload through the slash rewrite', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write('/heartbeat extra context here');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'skill', name: 'heartbeat', path: '/h.md' },
        { type: 'text', text: 'extra context here', text_elements: [] },
      ],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });
  });

  it('appends bus reply directive to plain-text Telegram turn so codex routes responses through cortextos bus', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
\`\`\`
Hello? Are you working right?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenCalledTimes(1);
    const call = requestMock.mock.calls[0];
    expect(call[0]).toBe('turn/start');
    const text = (call[1] as { input: Array<{ text: string }> }).input[0].text;
    expect(text).toContain('Hello? Are you working right?');
    expect(text).toContain("cortextos bus send-telegram 7940429114 '<your reply>'");
    expect(text).toContain('Do not reply through the codex channel.');
  });

  it('routes Telegram-delivered /heartbeat through the slash rewrite', async () => {
    requestMock
      .mockResolvedValueOnce({
        result: {
          data: [{ cwd: '/tmp', skills: [{ name: 'heartbeat', path: '/h.md', enabled: true }] }],
        },
      })
      .mockResolvedValueOnce({ result: {} });
    const pty = makeReadyPty();

    pty.write(`=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
/heartbeat
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`);
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'skill', name: 'heartbeat', path: '/h.md' }],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });
  });

  it('queues turns until native turn/completed arrives', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();
    const internals = pty as unknown as { handleRpcMessage(message: unknown): void };

    pty.write('first');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'first', text_elements: [] }],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });

    pty.write('second');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);

    internals.handleRpcMessage({ method: 'turn/completed', params: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'second', text_elements: [] }],
      approvalPolicy: 'never',
      permissions: permissionProfileId(pty),
    });

    internals.handleRpcMessage({ method: 'turn/completed', params: {} });
  });
});

describe('CodexAppServerPTY mid-turn steer', () => {
  function makeReadyPty() {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';
    (pty as unknown as { _rpc: { request: typeof requestMock; respondError: typeof respondErrorMock } })._rpc = {
      request: requestMock,
      respondError: respondErrorMock,
    };
    return pty;
  }

  function rpc(pty: InstanceType<typeof CodexAppServerPTY>) {
    return pty as unknown as { handleRpcMessage(message: unknown): void };
  }

  async function startExecutingTurn(pty: InstanceType<typeof CodexAppServerPTY>, turnId = 'turn-abc') {
    pty.write('long task');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1' }));
    rpc(pty).handleRpcMessage({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: turnId, items: [], status: 'inProgress' } },
    });
  }

  function callsTo(method: string) {
    return requestMock.mock.calls.filter(([m]) => m === method);
  }

  // Drain the full microtask queue (steer rejection -> catch -> enqueue -> drain
  // chains span more ticks than a fixed number of Promise.resolve() awaits).
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('steers the active turn instead of queueing when executing', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();
    await startExecutingTurn(pty);

    pty.write('mid-turn message');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(callsTo('turn/steer')).toHaveLength(1);
    expect(requestMock).toHaveBeenLastCalledWith('turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'turn-abc',
      input: [{ type: 'text', text: 'mid-turn message', text_elements: [] }],
    });

    // Steered input must NOT also be queued: completing the turn fires no new turn/start.
    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-abc' } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(callsTo('turn/start')).toHaveLength(1);
  });

  it('falls back to the queue when steer is rejected (non-steerable turn)', async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === 'turn/steer') {
        return Promise.reject(new Error('ActiveTurnNotSteerable'));
      }
      return Promise.resolve({ result: {} });
    });
    const pty = makeReadyPty();
    await startExecutingTurn(pty);

    pty.write('steer me');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(callsTo('turn/steer')).toHaveLength(1);
    expect(callsTo('turn/start')).toHaveLength(1); // not submitted yet

    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-abc' } } });
    await Promise.resolve();
    await Promise.resolve();

    expect(callsTo('turn/start')).toHaveLength(2);
    expect(callsTo('turn/start')[1][1]).toMatchObject({
      input: [{ type: 'text', text: 'steer me', text_elements: [] }],
    });
    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
  });

  it('preserves ordering across multiple rejected steers', async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === 'turn/steer') {
        return Promise.reject(new Error('ExpectedTurnMismatch'));
      }
      return Promise.resolve({ result: {} });
    });
    const pty = makeReadyPty();
    await startExecutingTurn(pty);

    for (const text of ['one', 'two']) {
      pty.write(text);
      pty.write('\r');
      await flush();
    }
    expect(callsTo('turn/steer')).toHaveLength(2);

    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-abc' } } });
    await flush();
    expect(callsTo('turn/start')[1][1]).toMatchObject({
      input: [{ type: 'text', text: 'one', text_elements: [] }],
    });

    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
    await flush();
    expect(callsTo('turn/start')[2][1]).toMatchObject({
      input: [{ type: 'text', text: 'two', text_elements: [] }],
    });
    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
  });

  it('queues without steering while executing but before turn/started arrives', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();
    pty.write('long task');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();
    // _executing is true but no turn/started notification has been seen.

    pty.write('early message');
    pty.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(callsTo('turn/steer')).toHaveLength(0);
    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(callsTo('turn/start')).toHaveLength(2);
    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
  });

  it('honors the CODEX_STEER_DISABLED kill-switch', async () => {
    process.env.CODEX_STEER_DISABLED = '1';
    try {
      requestMock.mockResolvedValue({ result: {} });
      const pty = makeReadyPty();
      await startExecutingTurn(pty);

      pty.write('mid-turn message');
      pty.write('\r');
      await Promise.resolve();
      await Promise.resolve();

      expect(callsTo('turn/steer')).toHaveLength(0);
      rpc(pty).handleRpcMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-abc' } } });
      await Promise.resolve();
      await Promise.resolve();
      expect(callsTo('turn/start')).toHaveLength(2);
      rpc(pty).handleRpcMessage({ method: 'turn/completed', params: {} });
    } finally {
      delete process.env.CODEX_STEER_DISABLED;
    }
  });

  it('clears the active turn id on turn/completed and on error notifications', async () => {
    requestMock.mockResolvedValue({ result: {} });
    const pty = makeReadyPty();
    await startExecutingTurn(pty);
    const internals = pty as unknown as { _activeTurnId: string | null };
    expect(internals._activeTurnId).toBe('turn-abc');

    rpc(pty).handleRpcMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-abc' } } });
    expect(internals._activeTurnId).toBeNull();

    await startExecutingTurn(pty, 'turn-def');
    expect(internals._activeTurnId).toBe('turn-def');
    rpc(pty).handleRpcMessage({ method: 'error', params: { message: 'boom' } });
    expect(internals._activeTurnId).toBeNull();
  });
});

describe('CodexAppServerPTY extractTelegramPayload media types', () => {
  function extract(content: string, options?: { existsSync?: boolean; readFileSync?: string }): string | null {
    if (options?.existsSync !== undefined) fsMocks.existsSync.mockReturnValue(options.existsSync);
    if (options?.readFileSync !== undefined) fsMocks.readFileSync.mockReturnValue(options.readFileSync);
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = (pty as unknown as {
      extractTelegramPayload(c: string): { payload: string; replyDirective: string | null } | null;
    }).extractTelegramPayload(content);
    return result?.payload ?? null;
  }
  function extractWithDirective(content: string): { payload: string; replyDirective: string | null } | null {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    return (pty as unknown as {
      extractTelegramPayload(c: string): { payload: string; replyDirective: string | null } | null;
    }).extractTelegramPayload(content);
  }

  it('photo: surfaces both caption and local_file path', () => {
    const inject = `=== TELEGRAM PHOTO from James (chat_id:7940429114) ===
caption:
\`\`\`
what's in this image
\`\`\`
local_file: telegram-images/2026-05-08_xyz.jpg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[PHOTO]');
    expect(out).toContain("caption: what's in this image");
    expect(out).toContain('local_file: telegram-images/2026-05-08_xyz.jpg');
  });

  it('document: surfaces caption + file_name + local_file', () => {
    const inject = `=== TELEGRAM DOCUMENT from James (chat_id:7940429114) ===
caption:
\`\`\`
have a look at this PDF
\`\`\`
local_file: telegram-images/myfile.pdf
file_name: myfile.pdf
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[DOCUMENT]');
    expect(out).toContain('caption: have a look at this PDF');
    expect(out).toContain('file_name: myfile.pdf');
    expect(out).toContain('local_file: telegram-images/myfile.pdf');
  });

  it('voice without transcript: surfaces local_file + duration but no transcript line', () => {
    const inject = `=== TELEGRAM VOICE from James (chat_id:7940429114) ===
duration: 5s
local_file: telegram-images/voice_1234.ogg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VOICE]');
    expect(out).toContain('local_file: telegram-images/voice_1234.ogg');
    expect(out).toContain('duration: 5s');
    expect(out).not.toContain('transcript:');
  });

  it('voice with transcript: surfaces transcript text', () => {
    const inject = `=== TELEGRAM VOICE from James (chat_id:7940429114) ===
duration: 5s
local_file: telegram-images/voice_1234.ogg
transcript:
\`\`\`
say hi back
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VOICE]');
    expect(out).toContain('transcript: say hi back');
    expect(out).toContain('local_file: telegram-images/voice_1234.ogg');
  });

  it('video: surfaces caption + file_name + local_file + duration', () => {
    const inject = `=== TELEGRAM VIDEO from James (chat_id:7940429114) ===
caption:
\`\`\`
demo clip
\`\`\`
duration: 12s
local_file: telegram-images/video_1234.mp4
file_name: video_1234.mp4
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[VIDEO]');
    expect(out).toContain('caption: demo clip');
    expect(out).toContain('file_name: video_1234.mp4');
    expect(out).toContain('local_file: telegram-images/video_1234.mp4');
    expect(out).toContain('duration: 12s');
  });

  it('plain-text TELEGRAM (no media token) preserves existing fenced-block behavior', () => {
    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
\`\`\`
just a chat message
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toBe('just a chat message');
  });

  it('reply_to with no outbound log: appends bare in-reply-to marker', () => {
    fsMocks.existsSync.mockImplementation((p: string) => !String(p).endsWith('outbound-messages.jsonl'));
    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
[reply_to: 4242]
\`\`\`
what did you mean by that?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('what did you mean by that?');
    expect(out).toContain('[in reply to message 4242]');
  });

  it('reply_to with matching outbound log entry: appends prior message body (truncated)', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue([
      JSON.stringify({ message_id: 4241, text: 'something else' }),
      JSON.stringify({ message_id: 4242, text: 'My earlier message about the deploy' }),
      JSON.stringify({ message_id: 4243, text: 'a later one' }),
    ].join('\n'));

    const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
[reply_to: 4242]
\`\`\`
what did you mean by that?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('what did you mean by that?');
    expect(out).toContain('[in reply to: My earlier message about the deploy]');
  });

  it('Telegram in-thread reply ([Replying to: "..."]) surfaces in-reply-to marker', () => {
    fsMocks.existsSync.mockReturnValue(false);
    const inject = `=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
[Replying to: "Created the DOCX about Donald Trump and attached it here."]
\`\`\`
what's this again?
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain("what's this again?");
    expect(out).toContain('[in reply to: Created the DOCX about Donald Trump and attached it here.]');
  });

  it('Telegram in-thread reply truncates to 200 chars', () => {
    fsMocks.existsSync.mockReturnValue(false);
    const long = 'A'.repeat(500);
    const inject = `=== TELEGRAM from [USER: James] (chat_id:7940429114) ===
[Replying to: "${long}"]
\`\`\`
short follow-up
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('short follow-up');
    expect(out).toContain(`[in reply to: ${'A'.repeat(200)}]`);
    expect(out).not.toContain(`[in reply to: ${'A'.repeat(201)}]`);
  });

  it('photo with reply_to: surfaces media payload AND reply_to marker', () => {
    fsMocks.existsSync.mockReturnValue(false);
    const inject = `=== TELEGRAM PHOTO from James (chat_id:7940429114) ===
[reply_to: 99]
caption:
\`\`\`
follow-up image
\`\`\`
local_file: telegram-images/p.jpg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
    const out = extract(inject);
    expect(out).toContain('[PHOTO]');
    expect(out).toContain('caption: follow-up image');
    expect(out).toContain('local_file: telegram-images/p.jpg');
    expect(out).toContain('[in reply to message 99]');
  });

  describe('reply directive coverage on every Telegram media type', () => {
    const expectDirective = (result: { replyDirective: string | null } | null) => {
      expect(result).not.toBeNull();
      expect(result!.replyDirective).not.toBeNull();
      expect(result!.replyDirective).toContain('cortextos bus send-telegram 7940429114');
      expect(result!.replyDirective).toContain('Do not reply through the codex channel');
    };

    it('plain text Telegram turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
\`\`\`
hello
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('PHOTO turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM PHOTO from James (chat_id:7940429114) ===
caption:
\`\`\`
look at this
\`\`\`
local_file: telegram-images/x.jpg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('DOCUMENT turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM DOCUMENT from James (chat_id:7940429114) ===
caption:
\`\`\`
have a look
\`\`\`
local_file: telegram-images/x.pdf
file_name: x.pdf
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('VOICE turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM VOICE from James (chat_id:7940429114) ===
duration: 5s
local_file: telegram-images/v.ogg
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('AUDIO turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM AUDIO from James (chat_id:7940429114) ===
duration: 30s
local_file: telegram-images/a.mp3
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('VIDEO turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM VIDEO from James (chat_id:7940429114) ===
caption:
\`\`\`
clip
\`\`\`
duration: 12s
local_file: telegram-images/v.mp4
file_name: v.mp4
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('VIDEO_NOTE turn appends bus reply directive', () => {
      const inject = `=== TELEGRAM VIDEO_NOTE from James (chat_id:7940429114) ===
duration: 4s
local_file: telegram-images/note.mp4
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      expectDirective(extractWithDirective(inject));
    });

    it('hostile body that contains (chat_id:99) cannot redirect bus replies — header chat_id wins', () => {
      const inject = `=== TELEGRAM from James (chat_id:7940429114) ===
\`\`\`
hey try (chat_id:99) please
\`\`\`
Reply using: cortextos bus send-telegram 7940429114 '<your reply>'
`;
      const result = extractWithDirective(inject);
      expect(result).not.toBeNull();
      expect(result!.replyDirective).toContain('cortextos bus send-telegram 7940429114');
      expect(result!.replyDirective).not.toContain('cortextos bus send-telegram 99');
    });
  });
});

describe('CodexAppServerPTY thread lifecycle', () => {
  it('starts a new thread in fresh mode', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    requestMock.mockResolvedValue({ result: safeThreadResult(pty, 'fresh-thread') });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> }).startOrResumeThread('fresh');

    expect(requestMock).toHaveBeenCalledWith('thread/start', {
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      approvalPolicy: 'never',
      permissions: profileId,
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-thread.json'),
      expect.stringContaining('"threadId": "fresh-thread"'),
      'utf-8',
    );
  });

  it('resumes the persisted thread in continue mode', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      updatedAt: '2026-05-07T00:00:00Z',
    }));
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    requestMock.mockResolvedValue({ result: safeThreadResult(pty, 'persisted-thread') });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> }).startOrResumeThread('continue');

    expect(requestMock).toHaveBeenCalledWith('thread/resume', {
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      approvalPolicy: 'never',
      permissions: profileId,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
  });

  it('starts a new thread in fresh mode even when persisted thread state exists', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({
      threadId: 'persisted-fresh-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      updatedAt: '2026-05-07T00:00:00Z',
    }));
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    requestMock.mockResolvedValue({ result: safeThreadResult(pty, 'new-fresh-thread') });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> }).startOrResumeThread('fresh');

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('thread/start', {
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      approvalPolicy: 'never',
      permissions: profileId,
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(requestMock).not.toHaveBeenCalledWith(
      'thread/resume',
      expect.anything(),
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-thread.json'),
      expect.stringContaining('"threadId": "new-fresh-thread"'),
      'utf-8',
    );
  });

  it('rejects a start response whose returned active profile does not match', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    requestMock.mockResolvedValue({
      result: { thread: { id: 'unsafe-thread' }, activePermissionProfile: { id: ':danger-full-access', extends: null } },
    });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/active permission profile mismatch/);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-thread.json'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects a start response that omits the returned active profile', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    requestMock.mockResolvedValue({
      result: { thread: { id: 'profileless-thread' } },
    });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/active permission profile mismatch.*none/);
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(['thread/start']);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('codex-app-server-thread.json'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not downgrade or fall back when a persisted resume returns the wrong profile', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      updatedAt: '2026-05-07T00:00:00Z',
    }));
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    requestMock.mockResolvedValue({
      result: { thread: { id: 'persisted-thread' }, activePermissionProfile: { id: ':workspace', extends: null } },
    });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'continue'): Promise<void> })
      .startOrResumeThread('continue')).rejects.toThrow(/active permission profile mismatch/);
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(['thread/resume']);
  });

  it('does not downgrade or fall back when a persisted resume omits the returned active profile', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({
      threadId: 'persisted-thread',
      cwd: '/tmp/fw/orgs/acme/agents/codex-app-agent',
      updatedAt: '2026-05-07T00:00:00Z',
    }));
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    requestMock.mockResolvedValue({
      result: { thread: { id: 'persisted-thread' } },
    });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'continue'): Promise<void> })
      .startOrResumeThread('continue')).rejects.toThrow(/active permission profile mismatch.*none/);
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(['thread/resume']);
  });

  it('rejects a matching profile id whose parent is not the read-only base', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = safeThreadResult(pty, 'unsafe-parent');
    result.activePermissionProfile.extends = ':workspace';
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/profile parent mismatch/);
  });

  it('rejects extra writable roots not declared by the role policy', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = safeThreadResult(pty, 'extra-root');
    result.sandbox.writableRoots = [...result.sandbox.writableRoots, '/tmp/unapproved'];
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/writable roots mismatch/);
  });

  it('does not hide an unexpected writable cwd when the role declared other roots', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = safeThreadResult(pty, 'cwd-leak');
    result.sandbox.writableRoots = [
      ...result.sandbox.writableRoots,
      mockEnv.agentDir,
    ];
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/writable roots mismatch/);
  });

  it('rejects malformed writable-root entries instead of filtering them out', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = safeThreadResult(pty, 'malformed-roots');
    (result.sandbox as { writableRoots: unknown[] }).writableRoots = [
      ...result.sandbox.writableRoots,
      42,
    ];
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/malformed writable roots/);
  });

  it('accepts a declared writable cwd as the implicit workspace root while retaining private temp', async () => {
    const config = {
      ...secureConfig,
      working_directory: mockEnv.agentDir,
      codex_writable_paths: [mockEnv.agentDir],
      codex_readonly_paths: [],
    };
    const pty = new CodexAppServerPTY(mockEnv, config);
    const result = {
      thread: { id: 'implicit-cwd' },
      activePermissionProfile: { id: permissionProfileId(pty), extends: ':read-only' },
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/ctx/state/codex-app-agent/model-tmp'],
        networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true,
      },
    };
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).resolves.toBeUndefined();
  });

  it('keeps a no-role-write profile limited to the adapter-owned private temp root', async () => {
    const config = {
      ...secureConfig,
      codex_writable_paths: [],
      codex_readonly_paths: [],
    };
    const pty = new CodexAppServerPTY(mockEnv, config);
    const base = {
      thread: { id: 'read-only' },
      activePermissionProfile: { id: permissionProfileId(pty), extends: ':read-only' },
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/ctx/state/codex-app-agent/model-tmp'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      } as {
        type: string; networkAccess: boolean; writableRoots?: string[];
        excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean;
      },
    };
    requestMock.mockResolvedValue({ result: base });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };
    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).resolves.toBeUndefined();

    base.sandbox.writableRoots = [
      '/tmp/ctx/state/codex-app-agent/model-tmp',
      '/tmp/leaked',
    ];
    requestMock.mockResolvedValue({ result: base });
    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/writable roots mismatch/);
  });

  it('rejects effective network access for an offline model process', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const result = safeThreadResult(pty, 'network-drift');
    result.sandbox.networkAccess = true;
    requestMock.mockResolvedValue({ result });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await expect((pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> })
      .startOrResumeThread('fresh')).rejects.toThrow(/network access mismatch/);
  });

  it('never emits legacy sandbox payloads on thread or turn RPCs', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const profileId = permissionProfileId(pty);
    requestMock.mockResolvedValue({ result: safeThreadResult(pty, 'safe-thread') });
    (pty as unknown as { _rpc: { request: typeof requestMock } })._rpc = { request: requestMock };

    await (pty as unknown as { startOrResumeThread(mode: 'fresh'): Promise<void> }).startOrResumeThread('fresh');
    const turn = (pty as unknown as { startTurn(input: unknown[]): Promise<void> })
      .startTurn([{ type: 'text', text: 'safe', text_elements: [] }]);
    await Promise.resolve();
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'turn/completed',
      params: { threadId: 'safe-thread', turn: { id: 'turn-1' } },
    });
    await turn;

    expect(requestMock).toHaveBeenCalledWith('turn/start', {
      threadId: 'safe-thread',
      input: [{ type: 'text', text: 'safe', text_elements: [] }],
      approvalPolicy: 'never',
      permissions: profileId,
    });
    expect(JSON.stringify(requestMock.mock.calls)).not.toMatch(
      /danger-full-access|dangerFullAccess|sandboxPolicy|\"sandbox\"/,
    );
  });
});

describe('CodexAppServerPTY event handling', () => {
  it('bootstraps on the app-server ready marker', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    pty.getOutputBuffer().push('[codex-app-server] ready thread=abc\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('responds with an error for unsupported server requests', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _rpc: { respondError: typeof respondErrorMock } })._rpc = { respondError: respondErrorMock };
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    expect(respondErrorMock).toHaveBeenCalledWith(7, -32601, 'Unsupported app-server request: item/commandExecution/requestApproval');
    expect(logEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'codex-app-agent',
      'acme',
      'error',
      'codex_app_server_unsupported_request',
      'error',
      {
        runtime: 'codex-app-server',
        method: 'item/commandExecution/requestApproval',
        thread_id: null,
      },
    );
    expect(pty.getOutputBuffer().getRecent()).toContain('unsupported request');
  });

  it('fires Telegram typing from streamed assistant deltas', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };
    pty.setTelegramHandle(api as unknown as Parameters<typeof pty.setTelegramHandle>[0], '12345');
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' },
    });
    expect(api.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
    expect(pty.getOutputBuffer().getRecent()).toContain('hello');
  });

  it('registers a message handler when connecting RPC', async () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    await (pty as unknown as { connectRpc(): Promise<void> }).connectRpc();
    expect(messageHandler).not.toBeNull();
  });

  it('keeps an explicitly allowlisted role MCP available', () => {
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });
    (pty as unknown as { _alive: boolean })._alive = true;

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'approved-role-server', status: 'ready' },
    });

    expect(pty.isAlive()).toBe(true);
    expect(pty.getOutputBuffer().getRecent()).toContain('approved-role-server ready');
  });

  it('fails closed if any ambient host MCP server attempts startup', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean })._alive = true;

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'ambient-host-server', status: 'starting' },
    });

    expect(pty.isAlive()).toBe(false);
    expect(pty.getOutputBuffer().getRecent()).toContain('Unapproved MCP server ambient-host-server reported starting');
  });

  it('fails closed when an allowlisted role MCP cannot start', () => {
    const pty = new CodexAppServerPTY(mockEnv, {
      ...secureConfig,
      codex_mcp_allowlist: ['approved-role-server'],
    });
    (pty as unknown as { _alive: boolean })._alive = true;

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'approved-role-server', status: 'failed', error: 'sensitive detail' },
    });

    expect(pty.isAlive()).toBe(false);
    expect(pty.getOutputBuffer().getRecent()).toContain('did not become available');
    expect(pty.getOutputBuffer().getRecent()).not.toContain('sensitive detail');
  });

  it('fails closed if a settings update reports a different active profile', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean; _threadId: string })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: { activePermissionProfile: { id: ':workspace', extends: null } },
      },
    });

    expect(pty.isAlive()).toBe(false);
    expect(pty.getOutputBuffer().getRecent()).toContain('active permission profile mismatch');
  });

  it('keeps a matching full settings update alive', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean; _threadId: string })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';
    const safe = safeThreadResult(pty, 'thread-1');

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          activePermissionProfile: safe.activePermissionProfile,
          sandboxPolicy: safe.sandbox,
        },
      },
    });

    expect(pty.isAlive()).toBe(true);
  });

  it.each([
    {
      label: 'same id with wrong parent',
      mutate: (settings: { activePermissionProfile: { extends: string | null } }) => {
        settings.activePermissionProfile.extends = ':workspace';
      },
      expected: /profile parent mismatch/,
    },
    {
      label: 'same id with network expansion',
      mutate: (settings: { sandboxPolicy: { networkAccess: boolean } }) => {
        settings.sandboxPolicy.networkAccess = true;
      },
      expected: /network access mismatch/,
    },
    {
      label: 'same id with writable-root expansion',
      mutate: (settings: { sandboxPolicy: { writableRoots: string[] } }) => {
        settings.sandboxPolicy.writableRoots.push('/tmp/unapproved');
      },
      expected: /writable roots mismatch/,
    },
  ])('fails closed on $label in a settings update', ({ mutate, expected }) => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean; _threadId: string })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';
    const safe = safeThreadResult(pty, 'thread-1');
    const settings = {
      activePermissionProfile: { ...safe.activePermissionProfile },
      sandboxPolicy: {
        ...safe.sandbox,
        writableRoots: [...safe.sandbox.writableRoots],
      },
    };
    mutate(settings as never);

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/settings/updated',
      params: { threadId: 'thread-1', threadSettings: settings },
    });

    expect(pty.isAlive()).toBe(false);
    expect(pty.getOutputBuffer().getRecent()).toMatch(expected);
  });

  it('fails closed with no fallback if a settings update omits the active profile', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _alive: boolean; _threadId: string })._alive = true;
    (pty as unknown as { _threadId: string })._threadId = 'thread-1';

    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {},
      },
    });

    expect(pty.isAlive()).toBe(false);
    expect(pty.getOutputBuffer().getRecent()).toContain('active permission profile mismatch');
    expect(pty.getOutputBuffer().getRecent()).toContain('got none');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('CodexAppServerPTY thread/tokenUsage/updated → context_status.json', () => {
  function feedTokenUsage(pty: InstanceType<typeof CodexAppServerPTY>, tokenUsage: unknown) {
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId: 'turn-1', tokenUsage },
    });
  }

  function lastWrittenPayload(): Record<string, unknown> | null {
    if (atomicWriteSyncMock.mock.calls.length === 0) return null;
    const lastCall = atomicWriteSyncMock.mock.calls.at(-1) as [string, string];
    return JSON.parse(lastCall[1]) as Record<string, unknown>;
  }

  it('writes context_status.json atomically with computed used_percentage', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 5000, inputTokens: 60000, outputTokens: 4000, reasoningOutputTokens: 1000, totalTokens: 70000 },
      total: { cachedInputTokens: 5000, inputTokens: 60000, outputTokens: 4000, reasoningOutputTokens: 1000, totalTokens: 70000 },
      modelContextWindow: 200000,
    });

    expect(atomicWriteSyncMock).toHaveBeenCalledTimes(1);
    const [path] = atomicWriteSyncMock.mock.calls[0];
    expect(path).toBe('/tmp/ctx/state/codex-app-agent/context_status.json');
    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBeCloseTo(35, 5);
    expect(payload.context_window_size).toBe(200000);
    expect(payload.exceeds_200k_tokens).toBe(false);
    expect(payload.session_id).toBe('thread-9');
    expect(typeof payload.written_at).toBe('string');
    expect(payload.current_usage).toEqual({
      input_tokens: 60000,
      output_tokens: 4000,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 0,
    });
  });

  it('falls back to default 256000 cap when modelContextWindow is null', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 64000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 64000 },
      total: { cachedInputTokens: 0, inputTokens: 640000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 640000 },
      modelContextWindow: null,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.context_window_size).toBe(256000);
    expect(payload.used_percentage).toBeCloseTo(25, 5);
  });

  it('honours codex_context_cap config override when modelContextWindow is null', () => {
    const pty = new CodexAppServerPTY(mockEnv, { ...secureConfig, codex_context_cap: 100000 });
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 50000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 50000 },
      total: { cachedInputTokens: 0, inputTokens: 500000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 500000 },
      modelContextWindow: null,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.context_window_size).toBe(100000);
    expect(payload.used_percentage).toBeCloseTo(50, 5);
  });

  it('flags exceeds_200k_tokens once total > 200k', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 210000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 210000 },
      total: { cachedInputTokens: 0, inputTokens: 2100000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2100000 },
      modelContextWindow: 1000000,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.exceeds_200k_tokens).toBe(true);
  });

  it('clamps used_percentage to 100 when totals exceed cap', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 300000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 300000 },
      total: { cachedInputTokens: 0, inputTokens: 3000000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3000000 },
      modelContextWindow: 256000,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBe(100);
  });

  it('uses current-window last tokens instead of lifetime total tokens', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 30000, inputTokens: 80000, outputTokens: 2000, reasoningOutputTokens: 0, totalTokens: 82000 },
      total: { cachedInputTokens: 312000000, inputTokens: 323000000, outputTokens: 880000, reasoningOutputTokens: 0, totalTokens: 324000000 },
      modelContextWindow: 258400,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBeCloseTo((82000 / 258400) * 100, 5);
    expect(payload.used_percentage).not.toBe(100);
    expect(payload.current_usage).toEqual({
      input_tokens: 80000,
      output_tokens: 2000,
      cache_read_input_tokens: 30000,
      cache_creation_input_tokens: 0,
    });
  });

  it('writes null used_percentage instead of false-100 when current-window data is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      total: { cachedInputTokens: 312000000, inputTokens: 323000000, outputTokens: 880000, reasoningOutputTokens: 0, totalTokens: 324000000 },
      modelContextWindow: 258400,
    });

    const payload = lastWrittenPayload()!;
    expect(payload.used_percentage).toBeNull();
    expect(payload.exceeds_200k_tokens).toBe(false);
    expect(payload.current_usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('skips the write when params.tokenUsage is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId: 'turn-1' },
    });
    expect(atomicWriteSyncMock).not.toHaveBeenCalled();
  });

  it('writes null used_percentage when total.totalTokens is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    });
    expect(lastWrittenPayload()?.used_percentage).toBe(0);
  });

  it('still emits the event log line even on a successful context write', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1000 },
      modelContextWindow: 200000,
    });
    expect(pty.getOutputBuffer().getRecent()).toContain('[codex-app-server:event] thread/tokenUsage/updated');
  });

  it('does not throw when atomicWriteSync rejects (write failure is non-fatal)', () => {
    atomicWriteSyncMock.mockImplementationOnce(() => { throw new Error('disk full'); });
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    expect(() => feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 1000, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1000 },
      modelContextWindow: 200000,
    })).not.toThrow();
  });
});

describe('CodexAppServerPTY thread/tokenUsage/updated → codex-tokens.jsonl', () => {
  function feedTokenUsage(
    pty: InstanceType<typeof CodexAppServerPTY>,
    tokenUsage: unknown,
    turnId: string | null = 'turn-1',
  ) {
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId, tokenUsage },
    });
  }

  function lastAppendedEntry(): Record<string, unknown> | null {
    if (fsMocks.appendFileSync.mock.calls.length === 0) return null;
    const lastCall = fsMocks.appendFileSync.mock.calls.at(-1) as [string, string];
    const trimmed = lastCall[1].replace(/\n$/, '');
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  it('appends a JSONL line to <ctxRoot>/logs/<agent>/codex-tokens.jsonl on tokenUsage', () => {
    const pty = new CodexAppServerPTY(mockEnv, { ...secureConfig, model: 'gpt-5-codex' });
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 1234, inputTokens: 5000, outputTokens: 800, reasoningOutputTokens: 0, totalTokens: 7034 },
      modelContextWindow: 200000,
    });

    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [path, line] = fsMocks.appendFileSync.mock.calls[0] as [string, string];
    expect(path).toBe('/tmp/ctx/logs/codex-app-agent/codex-tokens.jsonl');
    expect(line.endsWith('\n')).toBe(true);

    const entry = lastAppendedEntry()!;
    expect(entry.model).toBe('gpt-5-codex');
    expect(entry.input_tokens).toBe(5000);
    expect(entry.output_tokens).toBe(800);
    expect(entry.cache_read_tokens).toBe(1234);
    expect(entry.cache_write_tokens).toBe(0);
    expect(entry.session_id).toBe('thread-9');
    expect(entry.turn_id).toBe('turn-1');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('defaults model to gpt-5-codex when config.model is unset', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    });

    const entry = lastAppendedEntry()!;
    expect(entry.model).toBe('gpt-5-codex');
  });

  it('preserves config.model override when set', () => {
    const pty = new CodexAppServerPTY(mockEnv, { ...secureConfig, model: 'gpt-5-codex-preview' });
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    });

    const entry = lastAppendedEntry()!;
    expect(entry.model).toBe('gpt-5-codex-preview');
  });

  it('skips append when turnId is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    }, null);

    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });

  it('skips append when threadId has not been set', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    });

    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });

  it('skips append when params.tokenUsage is missing', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    (pty as unknown as { handleRpcMessage(message: unknown): void }).handleRpcMessage({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-9', turnId: 'turn-1' },
    });
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });

  it('produces a separate JSONL line per turn (no implicit dedup at writer)', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    }, 'turn-1');
    feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 200, outputTokens: 75, reasoningOutputTokens: 0, totalTokens: 275 },
      modelContextWindow: 200000,
    }, 'turn-2');

    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(2);
    const turnIds = fsMocks.appendFileSync.mock.calls.map((c) => {
      const line = (c as [string, string])[1].replace(/\n$/, '');
      return (JSON.parse(line) as { turn_id: string }).turn_id;
    });
    expect(turnIds).toEqual(['turn-1', 'turn-2']);
  });

  it('does not throw when appendFileSync rejects (cost logging is non-fatal)', () => {
    fsMocks.appendFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    (pty as unknown as { _threadId: string })._threadId = 'thread-9';
    expect(() => feedTokenUsage(pty, {
      last: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 150 },
      modelContextWindow: 200000,
    })).not.toThrow();
  });
});

describe('CodexAppServerPTY buildMediaPayload — dynamic fence parsing', () => {
  it('extracts a caption wrapped in a dynamically-sized (4-backtick) fence', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    // wrapFenceSafe grows the fence to 4 backticks when the caption contains ```;
    // the consumer must match the same fence length, not a hard-coded ```.
    const beforeReply = [
      '=== TELEGRAM PHOTO from Alice (chat_id:1) ===',
      'caption:',
      '````',
      'look at this ``` code',
      '````',
      'local_file: /tmp/p.jpg',
    ].join('\n');
    const payload = (pty as unknown as { buildMediaPayload(t: string, b: string): string | null })
      .buildMediaPayload('PHOTO', beforeReply);
    expect(payload).toContain('caption: look at this ``` code');
  });

  it('still extracts a caption in a plain 3-backtick fence', () => {
    const pty = new CodexAppServerPTY(mockEnv, secureConfig);
    const beforeReply = '=== TELEGRAM PHOTO from Bob (chat_id:2) ===\ncaption:\n```\nhello\n```\nlocal_file: /tmp/x.jpg';
    const payload = (pty as unknown as { buildMediaPayload(t: string, b: string): string | null })
      .buildMediaPayload('PHOTO', beforeReply);
    expect(payload).toContain('caption: hello');
  });
});
