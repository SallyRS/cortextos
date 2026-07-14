import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { WsUnixJsonRpcClient, type JsonRpcResponse } from '../utils/ws-unix-client.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

interface ThreadState {
  threadId: string;
  cwd: string;
  updatedAt: string;
}

interface SocketPointer {
  socketPath: string;
  fallback: boolean;
  reason?: string;
  updatedAt: string;
}

interface ThreadResponse {
  thread: {
    id: string;
    status?: unknown;
  };
  activePermissionProfile: {
    id: string;
    extends?: string | null;
  } | null;
  sandbox?: {
    type?: unknown;
    writableRoots?: unknown;
    networkAccess?: unknown;
    excludeTmpdirEnvVar?: unknown;
    excludeSlashTmp?: unknown;
  };
}

interface PermissionProfileListResponse {
  data: Array<{
    id: string;
    allowed: boolean;
  }>;
  nextCursor?: string | null;
}

interface McpServerStatusListResponse {
  data: Array<{
    name: string;
    serverInfo: unknown;
    tools: unknown;
    resources: unknown;
    resourceTemplates: unknown;
    authStatus: unknown;
  }>;
  nextCursor: string | null;
}

type McpServerStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';

interface McpReadinessWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SkillsListResponse {
  data?: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      path: string;
      scope?: string;
      enabled?: boolean;
    }>;
  }>;
}

interface GoalResponse {
  goal: {
    objective?: string | null;
    status?: string | null;
  } | null;
}

class PermissionProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionProfileError';
  }
}

const SOCKET_BASENAME = 'codex.sock';
const SOCKET_PATH_WARN_BYTES = 100;
const BOOTSTRAP_PATTERN = '[codex-app-server] ready';
const PERMISSION_PROFILE_PREFIX = 'cortextos-fleet';
const MCP_STARTUP_TIMEOUT_MS = 10_000;
const EXTERNAL_FEATURES_DISABLED_FOR_FLEET = [
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'remote_plugin',
  'plugin_sharing',
] as const;
const BASE_ENV_VARS = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'] as const;
const RESERVED_ENV_VARS = new Set([
  ...BASE_ENV_VARS,
  'ALL_PROXY',
  'BASH_ENV',
  'CODEX_HOME',
  'CURL_CA_BUNDLE',
  'ENV',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NO_PROXY',
  'PERL5OPT',
  'PYTHONHOME',
  'PYTHONPATH',
  'RUBYOPT',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'ZDOTDIR',
]);

const SLASH_REWRITE_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const LOCAL_SLASH_COMMANDS = new Set(['goal']);

/**
 * Codex app-server PTY adapter for cortextOS.
 *
 * Uses a persistent `codex app-server` process and speaks JSON-RPC over the
 * app-server's WebSocket-framed Unix socket transport. The approved default
 * socket is `$CTX_ROOT/state/<agent>/codex.sock`; if that resolved path is
 * longer than the conservative 100-byte Unix socket threshold, the adapter
 * falls back to `/tmp/cas-<short-uuid>.sock` and writes a state-dir pointer.
 */
export class CodexAppServerPTY {
  private _alive = false;
  private _startupCancelled = false;
  private _startupComplete = false;
  private _executing = false;
  private _activeTurnId: string | null = null;
  private _writeBuffer = '';
  private _turnQueue: unknown[][] = [];
  private _turnCompletion: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _spawnFn: SpawnFn | null = null;
  private _appServerPty: IPty | null = null;
  private _rpc: WsUnixJsonRpcClient | null = null;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private readonly _modelTempDir: string;
  private _cwd: string;
  private _socketPath: string;
  private _socketListenArg: string;
  private _socketCwd: string;
  private _threadStatePath: string;
  private _socketPointerPath: string;
  private readonly _permissionProfileId: string;
  private readonly _permissionProfileConfigArgs: string[];
  private readonly _writablePaths: string[];
  private readonly _readonlyPaths: string[];
  private readonly _networkAllowDomains: string[];
  private readonly _envAllowlist: Set<string>;
  private readonly _mcpAllowlist: Set<string>;
  private readonly _mcpStartupStates = new Map<string, McpServerStartupState>();
  private _mcpReadinessWaiter: McpReadinessWaiter | null = null;
  private _threadId: string | null = null;
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._modelTempDir = join(this._stateDir, 'model-tmp');
    this._threadStatePath = join(this._stateDir, 'codex-app-server-thread.json');
    this._socketPointerPath = join(this._stateDir, 'codex-app-server-socket.json');
    const socket = this.resolveSocketPath();
    this._socketPath = socket.path;
    this._socketListenArg = socket.listenArg;
    this._socketCwd = socket.cwd;
    const compiled = compileCodexCapabilityPolicy(
      config,
      this._modelTempDir,
      this._socketPath,
    );
    this._writablePaths = compiled.writablePaths;
    this._readonlyPaths = compiled.readonlyPaths;
    this._networkAllowDomains = compiled.networkAllowDomains;
    this._envAllowlist = new Set(compiled.envAllowlist);
    this._mcpAllowlist = new Set(compiled.mcpAllowlist);
    this._permissionProfileId = compiled.profile.id;
    this._permissionProfileConfigArgs = compiled.profile.configArgs;
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexAppServerPTY already spawned. Kill first.');
    }

    assertSensitivePathsHaveNoAliases(
      validateCredentialDenyPaths(this._config.codex_credential_deny_paths),
      'codex_credential_deny_paths',
    );
    assertSensitivePathsHaveNoAliases(
      validateReadonlyPaths(this._config.codex_readonly_paths),
      'codex_readonly_paths',
    );
    this._mcpStartupStates.clear();
    this._startupCancelled = false;
    this._startupComplete = false;
    this._alive = true;

    try {
      await this.startAppServerWithRetry();
      await this.connectRpc();
      await this.initializeRpc();
      await this.startOrResumeThread(mode);
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      this._startupComplete = true;
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
    } catch (err) {
      this._alive = false;
      this._startupComplete = false;
      this._outputBuffer.push(`[codex-app-server] degraded: ${err}\n`);
      // This adapter never became a running AgentProcess. Suppress the normal
      // runtime-exit callback while cleaning up so AgentProcess does not queue
      // a phantom recovery timer for a synchronous setup failure.
      this._onExitHandler = null;
      this.kill();
      throw err;
    }
  }

  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.handleInput(content).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] input failed: ${err}\n`);
        });
      }
    } else {
      this._writeBuffer += data;
    }
  }

  kill(): void {
    this._startupCancelled = true;
    this._startupComplete = false;
    this._alive = false;
    this.rejectMcpReadiness(new PermissionProfileError('Codex app-server stopped before MCP startup completed'));
    this._mcpStartupStates.clear();
    this._activeTurnId = null;
    this._turnQueue = [];
    this.rejectTurnCompletion(new Error('Codex app-server stopped'));
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    if (this._appServerPty) {
      try {
        this._appServerPty.kill();
      } catch {
        // Ignore shutdown errors.
      }
      this._appServerPty = null;
    }
    this.removeSocket();
    this.cleanupPrivateModelTempDir();
    this._onExitHandler?.(0, undefined);
    this._onExitHandler = null;
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._appServerPty?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
  }

  private async handleInput(content: string): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    const goalCommand = this.parseGoalCommand(input);
    if (goalCommand?.type === 'get') {
      await this.getGoal();
      return;
    }
    if (goalCommand?.type === 'clear') {
      await this.clearGoal();
      return;
    }
    if (goalCommand?.type === 'set') {
      await this.setGoal(goalCommand.objective);
      return;
    }
    if (input.startsWith('$')) {
      await this.handleSkillInput(input);
      return;
    }
    const slashMatch = input.match(SLASH_REWRITE_RE);
    if (slashMatch && !LOCAL_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      await this.handleSkillInput(rewritten);
      return;
    }
    const turnText = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }]);
  }

  private extractTelegramPayload(
    content: string,
  ): { payload: string; replyDirective: string | null } | null {
    if (!content.startsWith('=== TELEGRAM')) return null;

    const headerMatch = content.match(/^=== TELEGRAM(?:\s+(PHOTO|DOCUMENT|VOICE|AUDIO|VIDEO|VIDEO_NOTE))?\s+from/);
    const mediaType = headerMatch?.[1] ?? null;

    const chatIdMatch = content.match(/^=== TELEGRAM[^\n]*\(chat_id:(-?\d+)\)/);
    const chatId = chatIdMatch?.[1] ?? null;

    const beforeReply = content
      .split('\n[Your last message:', 1)[0]
      .split('\nReply using:', 1)[0];

    const replyToContext = this.extractReplyToContext(beforeReply);
    const replyDirective = chatId
      ? `Reply via: cortextos bus send-telegram ${chatId} '<your reply>' — this is the only path that surfaces in Telegram and on the dashboard. Do not reply through the codex channel.`
      : null;
    const wrap = (payload: string | null): { payload: string; replyDirective: string | null } | null => {
      if (!payload) return null;
      const withReplyTo = replyToContext ? `${payload}\n\n${replyToContext}` : payload;
      return { payload: withReplyTo, replyDirective };
    };

    if (mediaType) {
      const mediaPayload = this.buildMediaPayload(mediaType, beforeReply);
      if (mediaPayload) return wrap(mediaPayload);
    }

    const lines = beforeReply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      if (line.startsWith('/') || line.startsWith('$')) return wrap(line);
      break;
    }

    const fencedBlocks = [...beforeReply.matchAll(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/g)];
    if (fencedBlocks.length > 0) {
      return wrap(fencedBlocks[fencedBlocks.length - 1]?.[1]?.trim() || null);
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      return wrap(line);
    }

    return null;
  }

  private buildMediaPayload(mediaType: string, beforeReply: string): string | null {
    // Match a dynamically-sized fence (3+ backticks): wrapFenceSafe grows the
    // fence to outlast any backtick run in the body, so the close must be the
    // same length as the open (backreference \1). Group 2 is the body.
    const captionMatch = beforeReply.match(/caption:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const caption = captionMatch?.[2]?.trim() ?? '';

    const transcriptMatch = beforeReply.match(/transcript:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const transcript = transcriptMatch?.[2]?.trim() ?? '';

    const localFileMatch = beforeReply.match(/^local_file:\s*(.+)$/m);
    const localFile = localFileMatch?.[1]?.trim() ?? '';

    const fileNameMatch = beforeReply.match(/^file_name:\s*(.+)$/m);
    const fileName = fileNameMatch?.[1]?.trim() ?? '';

    const durationMatch = beforeReply.match(/^duration:\s*(.+)$/m);
    const duration = durationMatch?.[1]?.trim() ?? '';

    const lines: string[] = [`[${mediaType}]`];
    if (caption) lines.push(`caption: ${caption}`);
    if (transcript) lines.push(`transcript: ${transcript}`);
    if (fileName) lines.push(`file_name: ${fileName}`);
    if (localFile) lines.push(`local_file: ${localFile}`);
    if (duration) lines.push(`duration: ${duration}`);

    return lines.length > 1 ? lines.join('\n') : null;
  }

  private extractReplyToContext(beforeReply: string): string | null {
    const telegramReplyMatch = beforeReply.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    if (telegramReplyMatch) {
      const text = telegramReplyMatch[1].slice(0, 200);
      if (text) return `[in reply to: ${text}]`;
    }

    const replyToMatch = beforeReply.match(/\[reply_to:\s*(\d+)\]/);
    if (!replyToMatch) return null;
    const messageId = replyToMatch[1];

    try {
      const outboundLog = join(this._stateDir, 'outbound-messages.jsonl');
      if (!existsSync(outboundLog)) return `[in reply to message ${messageId}]`;
      const fileLines = readFileSync(outboundLog, 'utf-8').split('\n').filter((l) => l.trim());
      for (let i = fileLines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(fileLines[i]) as { message_id?: number | string; text?: string };
          if (entry.message_id !== undefined && String(entry.message_id) === messageId) {
            const text = (entry.text || '').slice(0, 200);
            return text ? `[in reply to: ${text}]` : `[in reply to message ${messageId}]`;
          }
        } catch {
          // skip malformed lines
        }
      }
      return `[in reply to message ${messageId}]`;
    } catch {
      return `[in reply to message ${messageId}]`;
    }
  }

  private parseGoalCommand(content: string): { type: 'get' | 'clear' } | { type: 'set'; objective: string } | null {
    const match = content.trim().match(/^\/goal(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const objective = match[1]?.trim();
    if (!objective) return { type: 'get' };
    if (objective.toLowerCase() === 'clear') return { type: 'clear' };
    return { type: 'set', objective };
  }

  private async startAppServerWithRetry(): Promise<void> {
    const delays = [1000, 4000, 16000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (this._startupCancelled) {
        throw new Error('Codex app-server startup was cancelled');
      }
      // An app-server may have exited during the prior attempt. A new retry is
      // live again unless kill() explicitly cancelled the startup generation.
      // Unexpected exit cleanup removes model-tmp, so every attempt recreates
      // and revalidates the private TMPDIR before constructing the child env.
      this.preparePrivateModelTempDir();
      this._alive = true;
      try {
        this.removeSocket();
        await this.startAppServer();
        if (this._startupCancelled) {
          this.cleanupSpawnAttempt();
          throw new Error('Codex app-server startup was cancelled');
        }
        if (!this._alive) {
          throw new Error('Codex app-server exited during startup');
        }
        return;
      } catch (err) {
        lastErr = err;
        this.cleanupSpawnAttempt();
        this._outputBuffer.push(`[codex-app-server] spawn attempt ${attempt + 1} failed: ${err}\n`);
        if (this._startupCancelled) {
          throw new Error('Codex app-server startup was cancelled');
        }
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]);
          if (this._startupCancelled) {
            throw new Error('Codex app-server startup was cancelled');
          }
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private startAppServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._spawnFn) {
        const nodePty = require('node-pty');
        this._spawnFn = nodePty.spawn;
      }

      const spawnFn = this._spawnFn!;
      const mcpConfigArgs = this.buildMcpConfigArgs();
      const pty = spawnFn('codex', [
        'app-server',
        '--strict-config',
        '--enable', 'goals',
        ...EXTERNAL_FEATURES_DISABLED_FOR_FLEET.flatMap((feature) => ['--disable', feature]),
        ...mcpConfigArgs,
        ...this._permissionProfileConfigArgs,
        '--listen', this._socketListenArg,
      ], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this._socketCwd,
        env: this.buildEnv(),
      });

      this._appServerPty = pty;
      pty.onData((data) => {
        this._outputBuffer.push(data);
        if (data.includes('Error:')) {
          reject(new Error(data.trim()));
        }
      });
      pty.onExit(({ exitCode, signal }) => {
        if (this._appServerPty !== pty) return;
        const publishRuntimeExit = this._startupComplete;
        this._appServerPty = null;
        this._alive = false;
        this._startupComplete = false;
        this.rejectMcpReadiness(new PermissionProfileError(
          'Codex app-server exited before MCP startup completed',
        ));
        this._mcpStartupStates.clear();
        this.rejectTurnCompletion(new Error('Codex app-server exited'));
        if (this._rpc) {
          this._rpc.close();
          this._rpc = null;
        }
        this.removeSocket();
        this.cleanupPrivateModelTempDir();
        // A failed internal launch attempt belongs to the bounded adapter
        // retry loop. AgentProcess only receives exits after this adapter has
        // completed its profile/MCP/thread read-back and declared startup.
        if (publishRuntimeExit) this._onExitHandler?.(exitCode, signal);
      });

      this.waitForSocket().then(resolve, reject);
    });
  }

  private async waitForSocket(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this._startupCancelled) throw new Error('Codex app-server startup was cancelled');
      if (!this._alive) throw new Error('Codex app-server exited during startup');
      if (existsSync(this._socketPath)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for app-server socket: ${this._socketPath}`);
  }

  private async connectRpc(): Promise<void> {
    this._rpc = new WsUnixJsonRpcClient(this._socketPath);
    this._rpc.onMessage((message) => this.handleRpcMessage(message));
    await this._rpc.connect();
  }

  private async initializeRpc(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'cortextos',
        title: 'cortextOS',
        version: this.getPackageVersion(),
      },
      capabilities: { experimentalApi: true },
    });
    this._rpc?.notify('initialized');
    await this.verifyPermissionProfileAvailable();
    await this.verifyMcpStatusReadback();
  }

  private async verifyPermissionProfileAvailable(): Promise<void> {
    const response = await this.request<PermissionProfileListResponse>('permissionProfile/list', {
      cwd: this._cwd,
    });
    const profile = response.result?.data?.find((entry) => entry.id === this._permissionProfileId);
    if (!profile) {
      throw new PermissionProfileError(
        `Required Codex permission profile ${this._permissionProfileId} is not available`,
      );
    }
    if (profile.allowed !== true) {
      throw new PermissionProfileError(
        `Required Codex permission profile ${this._permissionProfileId} is not allowed`,
      );
    }
  }

  private async verifyMcpStatusReadback(
    readinessTimeoutMs = MCP_STARTUP_TIMEOUT_MS,
  ): Promise<void> {
    await this.waitForMcpReadiness(readinessTimeoutMs);
    await this.verifyMcpInventoryReadback();
  }

  private async waitForMcpReadiness(timeoutMs: number): Promise<void> {
    if (this._mcpAllowlist.size === 0) return;
    if (!this._alive) {
      throw new PermissionProfileError('Codex app-server stopped before MCP startup completed');
    }
    if (this.allApprovedMcpServersReady()) return;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new PermissionProfileError('MCP startup timeout must be a positive finite duration');
    }
    if (this._mcpReadinessWaiter) {
      throw new PermissionProfileError('MCP startup readiness is already being awaited');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._mcpReadinessWaiter = null;
        const pending = [...this._mcpAllowlist]
          .filter((name) => this._mcpStartupStates.get(name) !== 'ready')
          .sort()
          .map((name) => `${name}=${this._mcpStartupStates.get(name) ?? 'pending'}`)
          .join(', ');
        reject(new PermissionProfileError(
          `Timed out waiting for approved MCP servers to become ready: ${pending}`,
        ));
      }, timeoutMs);
      this._mcpReadinessWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this._mcpReadinessWaiter = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this._mcpReadinessWaiter = null;
          reject(error);
        },
      };
      this.settleMcpReadinessWaiter();
    });
  }

  private allApprovedMcpServersReady(): boolean {
    return [...this._mcpAllowlist]
      .every((name) => this._mcpStartupStates.get(name) === 'ready');
  }

  private settleMcpReadinessWaiter(): void {
    const waiter = this._mcpReadinessWaiter;
    if (!waiter) return;
    const failed = [...this._mcpAllowlist]
      .find((name) => {
        const status = this._mcpStartupStates.get(name);
        return status === 'failed' || status === 'cancelled';
      });
    if (failed) {
      waiter.reject(new PermissionProfileError(
        `Approved MCP server ${failed} did not become available`,
      ));
    } else if (this.allApprovedMcpServersReady()) {
      waiter.resolve();
    }
  }

  private rejectMcpReadiness(error: Error): void {
    this._mcpReadinessWaiter?.reject(error);
  }

  private async verifyMcpInventoryReadback(): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      pages += 1;
      if (pages > 100) throw new PermissionProfileError('MCP status pagination exceeded its bound');
      const response: JsonRpcResponse<McpServerStatusListResponse> =
        await this.request<McpServerStatusListResponse>('mcpServerStatus/list', {
        cursor,
        limit: 100,
        detail: 'toolsAndAuthOnly',
      });
      const result: McpServerStatusListResponse | undefined = response.result;
      if (!result || !Array.isArray(result.data)) {
        throw new PermissionProfileError('MCP status read-back had an invalid shape');
      }
      for (const entry of result.data) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || seen.has(entry.name)) {
          throw new PermissionProfileError('MCP status read-back contained an invalid or duplicate name');
        }
        seen.add(entry.name);
        const tools = isRecord(entry.tools) ? Object.keys(entry.tools) : null;
        const resources = Array.isArray(entry.resources) ? entry.resources : null;
        const templates = Array.isArray(entry.resourceTemplates) ? entry.resourceTemplates : null;
        if (!tools || !resources || !templates || typeof entry.authStatus !== 'string') {
          throw new PermissionProfileError(`MCP status read-back for ${entry.name} was malformed`);
        }
        if (this._mcpAllowlist.has(entry.name)) {
          if (!isRecord(entry.serverInfo)) {
            throw new PermissionProfileError(`Approved MCP server ${entry.name} is not active`);
          }
        } else if (
          entry.serverInfo !== null
          || tools.length !== 0
          || resources.length !== 0
          || templates.length !== 0
        ) {
          throw new PermissionProfileError(`Unapproved MCP server ${entry.name} is not inert`);
        }
      }
      if (result.nextCursor !== null && typeof result.nextCursor !== 'string') {
        throw new PermissionProfileError('MCP status read-back returned an invalid cursor');
      }
      cursor = result.nextCursor;
    } while (cursor !== null);

    for (const name of this._mcpAllowlist) {
      if (!seen.has(name)) {
        throw new PermissionProfileError(`Approved MCP server ${name} was absent from active read-back`);
      }
    }
  }

  private async startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> {
    if (mode === 'continue') {
      const persisted = this.readThreadState();
      if (persisted) {
        try {
          const resumed = await this.request<ThreadResponse>('thread/resume', {
            threadId: persisted.threadId,
            cwd: this._cwd,
            approvalPolicy: 'never',
            permissions: this._permissionProfileId,
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.verifyEffectivePermissionProfile(resumed, 'thread/resume');
          this.setThreadId(resumed.result?.thread.id || persisted.threadId);
          return;
        } catch (err) {
          if (err instanceof PermissionProfileError) throw err;
          this._outputBuffer.push(`[codex-app-server] persisted resume failed: ${err}\n`);
        }
      }

      const latest = await this.findLatestThreadForCwd();
      if (latest) {
        const resumed = await this.request<ThreadResponse>('thread/resume', {
          threadId: latest,
          cwd: this._cwd,
          approvalPolicy: 'never',
          permissions: this._permissionProfileId,
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        this.verifyEffectivePermissionProfile(resumed, 'thread/resume');
        this.setThreadId(resumed.result?.thread.id || latest);
        return;
      }
    }

    const started = await this.request<ThreadResponse>('thread/start', {
      cwd: this._cwd,
      approvalPolicy: 'never',
      permissions: this._permissionProfileId,
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.verifyEffectivePermissionProfile(started, 'thread/start');
    this.setThreadId(started.result!.thread.id);
  }

  private verifyEffectivePermissionProfile(response: JsonRpcResponse<ThreadResponse>, method: string): void {
    this.verifyEffectivePermissionState(
      response.result?.activePermissionProfile,
      response.result?.sandbox,
      method,
    );
  }

  private verifyEffectivePermissionState(
    activeProfile: unknown,
    sandboxValue: unknown,
    method: string,
  ): void {
    const profile = isRecord(activeProfile) ? activeProfile : null;
    const actual = typeof profile?.id === 'string' ? profile.id : null;
    if (actual !== this._permissionProfileId) {
      throw new PermissionProfileError(
        `${method} active permission profile mismatch: expected ${this._permissionProfileId}, got ${actual ?? 'none'}`,
      );
    }
    const parent = typeof profile?.extends === 'string' ? profile.extends : null;
    if (parent !== ':read-only') {
      throw new PermissionProfileError(
        `${method} active permission profile parent mismatch: expected :read-only, got ${parent ?? 'none'}`,
      );
    }

    const sandbox = isRecord(sandboxValue) ? sandboxValue : null;
    const expectedSandboxType = this._writablePaths.length > 0 ? 'workspaceWrite' : 'readOnly';
    if (sandbox?.type !== expectedSandboxType) {
      throw new PermissionProfileError(
        `${method} sandbox type mismatch: expected ${expectedSandboxType}`,
      );
    }
    const rawRoots = sandbox?.writableRoots;
    if (expectedSandboxType === 'readOnly') {
      if (rawRoots !== undefined && (!Array.isArray(rawRoots) || rawRoots.length !== 0)) {
        throw new PermissionProfileError(`${method} returned writable roots for a read-only profile`);
      }
    } else if (!Array.isArray(rawRoots) || !rawRoots.every((path) => typeof path === 'string')) {
      throw new PermissionProfileError(`${method} returned malformed writable roots`);
    }
    if (expectedSandboxType === 'workspaceWrite'
      && (typeof sandbox?.excludeTmpdirEnvVar !== 'boolean' || sandbox?.excludeSlashTmp !== true)) {
      throw new PermissionProfileError(`${method} ambient /tmp exclusion is not fail-closed`);
    }
    const cwd = canonicalizeExistingPath(this._cwd);
    const configuredRoots = this._writablePaths.map(canonicalizeExistingPath);
    const cwdIsDeclaredWritable = configuredRoots.includes(cwd);
    const actualRoots = (Array.isArray(rawRoots) ? rawRoots : [])
      .map(canonicalizeExistingPath)
      .filter((path) => !(cwdIsDeclaredWritable && path === cwd));
    // Codex represents a writable cwd as the implicit workspace root and omits
    // it from writableRoots. Other declared roots remain explicit.
    const expectedRoots = configuredRoots
      .filter((path) => !(cwdIsDeclaredWritable && path === cwd));
    if (!sameStringSet(actualRoots, expectedRoots)) {
      throw new PermissionProfileError(
        `${method} writable roots mismatch for ${this._permissionProfileId}`,
      );
    }
    const expectedNetworkAccess = this._networkAllowDomains.length > 0;
    if (sandbox?.networkAccess !== expectedNetworkAccess) {
      throw new PermissionProfileError(
        `${method} network access mismatch: expected ${expectedNetworkAccess}`,
      );
    }
  }

  private async findLatestThreadForCwd(): Promise<string | null> {
    const response = await this.request<{ data: Array<{ id: string; cwd?: string }> }>('thread/list', {
      cwd: this._cwd,
      limit: 1,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    return response.result?.data?.[0]?.id || null;
  }

  /**
   * Mid-turn parity with the Claude PTY-injection path: while a turn is
   * executing, try `turn/steer` so the message lands in the active turn at the
   * next model step instead of waiting for turn/completed. Any steer rejection
   * (ExpectedTurnMismatch = turn just ended, ActiveTurnNotSteerable =
   * review/compact, NoActiveTurn, transport error) falls back to the queue, so
   * no message is ever lost. CODEX_STEER_DISABLED=1 reverts to pure queueing.
   */
  private queueTurn(input: unknown[]): void {
    if (this._executing && this._activeTurnId && process.env.CODEX_STEER_DISABLED !== '1') {
      this.steerActiveTurn(input).catch((err) => {
        this._outputBuffer.push(`[codex-app-server] steer path failed: ${err}\n`);
      });
      return;
    }
    this.enqueueTurn(input);
  }

  private async steerActiveTurn(input: unknown[]): Promise<void> {
    const expectedTurnId = this._activeTurnId;
    if (!this._threadId || !expectedTurnId) {
      this.enqueueTurn(input);
      return;
    }
    try {
      await this.request('turn/steer', {
        threadId: this._threadId,
        expectedTurnId,
        input,
      });
      this._outputBuffer.push(`[codex-app-server] steered active turn ${expectedTurnId}\n`);
    } catch (err) {
      // Do not retry steer here: the rejection may be a non-steerable turn
      // (review/compact). Queueing guarantees delivery right after it ends.
      this._outputBuffer.push(`[codex-app-server] steer rejected, queueing: ${err}\n`);
      this.enqueueTurn(input);
    }
  }

  private enqueueTurn(input: unknown[]): void {
    this._turnQueue.push(input);
    if (!this._executing) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && this._turnQueue.length > 0) {
      const input = this._turnQueue.shift()!;
      this._executing = true;
      try {
        await this.startTurn(input);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(input: unknown[]): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const completion = this.createTurnCompletion();
    await this.request('turn/start', {
      threadId: this._threadId,
      input,
      approvalPolicy: 'never',
      permissions: this._permissionProfileId,
    });
    await completion;
  }

  /**
   * Local-command reply: writes to the agent log AND mirrors back to Telegram.
   * Local commands (`/goal`, `$skill` errors) are handled inside the adapter
   * without an LLM turn, so the user only sees a response if we send it.
   */
  private replyLocal(text: string): void {
    this._outputBuffer.push(text + '\n');
    if (this._telegramApi && this._chatId) {
      this._telegramApi.sendMessage(this._chatId, text, undefined, { parseMode: null }).catch(() => {});
    }
  }

  private async setGoal(objective: string): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/set', {
      threadId: this._threadId,
      objective,
    });
    this.replyLocal(`[goal] ${response.result?.goal?.status || 'active'}: ${objective}`);
  }

  private async getGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/get', { threadId: this._threadId });
    const goal = response.result?.goal;
    this.replyLocal(goal?.objective
      ? `[goal] ${goal.status || 'active'}: ${goal.objective}`
      : '[goal] none set');
  }

  private async clearGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    await this.request('thread/goal/clear', { threadId: this._threadId });
    this.replyLocal('[goal] cleared');
  }

  private async handleSkillInput(content: string): Promise<void> {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    const [, skillName, trailingText] = match;
    const skills = await this.request<SkillsListResponse>('skills/list', {
      cwds: [this._cwd],
      forceReload: false,
    });
    const allSkills = (skills.result?.data || []).flatMap((entry) => entry.skills || []);
    const exact = allSkills.find((skill) => skill.enabled !== false && skill.name === skillName);
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    this.queueTurn(input);
  }

  private handleRpcMessage(message: unknown): void {
    if (!isRecord(message)) return;

    if ('method' in message && 'id' in message) {
      const method = String(message.method);
      const id = message.id as number | string;
      this._outputBuffer.push(`[codex-app-server] unsupported request: ${method}\n`);
      this.emitUnsupportedRequestEvent(method);
      this._rpc?.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      return;
    }

    if (!('method' in message)) return;
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};

    switch (method) {
      case 'thread/started':
        this._outputBuffer.push('[codex-app-server] thread started\n');
        break;
      case 'thread/status/changed':
        this._outputBuffer.push(`[codex-app-server] status ${JSON.stringify(params.status)}\n`);
        if (isRecord(params.status) && params.status.type === 'idle') {
          this.writeIdleFlag();
        } else {
          this.maybeFireTyping();
        }
        break;
      case 'turn/started':
        if (isRecord(params.turn) && typeof params.turn.id === 'string') {
          this._activeTurnId = params.turn.id;
        }
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        this._activeTurnId = null;
        this.writeIdleFlag();
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        this.resolveTurnCompletion();
        break;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
        this._outputBuffer.push(`[plan] ${JSON.stringify(params)}\n`);
        this.maybeFireTyping();
        break;
      case 'thread/goal/updated':
        if (isRecord(params.goal)) {
          this._outputBuffer.push(`[goal] ${params.goal.status || 'active'}: ${params.goal.objective || ''}\n`);
        }
        break;
      case 'thread/goal/cleared':
        this._outputBuffer.push('[goal] cleared\n');
        break;
      case 'thread/settings/updated': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : null;
        if (threadId === this._threadId) {
          const settings = isRecord(params.threadSettings) ? params.threadSettings : null;
          try {
            this.verifyEffectivePermissionState(
              settings?.activePermissionProfile,
              settings?.sandboxPolicy,
              'thread/settings/updated',
            );
          } catch (cause) {
            const error = cause instanceof Error
              ? cause
              : new PermissionProfileError('thread/settings/updated permission state is invalid');
            this._outputBuffer.push(`[codex-app-server] degraded: ${error.message}\n`);
            this.rejectTurnCompletion(error);
            this.kill();
            return;
          }
        }
        this._outputBuffer.push('[codex-app-server:event] thread/settings/updated\n');
        break;
      }
      case 'error':
        this._activeTurnId = null;
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        this.rejectTurnCompletion(new Error(JSON.stringify(params)));
        break;
      case 'thread/tokenUsage/updated':
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'mcpServer/startupStatus/updated': {
        const name = typeof params.name === 'string' ? params.name : null;
        const status = typeof params.status === 'string' ? params.status : null;
        if (!name || !this._mcpAllowlist.has(name)) {
          const error = new PermissionProfileError(
            `Unapproved MCP server ${name ?? '<missing>'} reported ${status ?? 'unknown'} startup state`,
          );
          this._outputBuffer.push(`[codex-app-server] degraded: ${error.message}\n`);
          this.rejectTurnCompletion(error);
          this.kill();
          return;
        }
        if (status !== 'starting' && status !== 'ready' && status !== 'failed' && status !== 'cancelled') {
          const error = new PermissionProfileError(
            `Approved MCP server ${name} reported an invalid startup state`,
          );
          this._outputBuffer.push(`[codex-app-server] degraded: ${error.message}\n`);
          this.rejectMcpReadiness(error);
          this.rejectTurnCompletion(error);
          this.kill();
          return;
        }
        this._mcpStartupStates.set(name, status);
        if (status === 'failed' || status === 'cancelled') {
          const error = new PermissionProfileError(`Approved MCP server ${name} did not become available`);
          this._outputBuffer.push(`[codex-app-server] degraded: ${error.message}\n`);
          this.rejectMcpReadiness(error);
          this.rejectTurnCompletion(error);
          this.kill();
          return;
        }
        this.settleMcpReadinessWaiter();
        this._outputBuffer.push(`[codex-app-server:event] ${method} ${name} ${status ?? 'unknown'}\n`);
        break;
      }
      case 'mcpServer/oauthLogin/completed': {
        const name = typeof params.name === 'string' ? params.name : null;
        if (!name || !this._mcpAllowlist.has(name)) {
          const error = new PermissionProfileError('Unapproved MCP server attempted OAuth completion');
          this._outputBuffer.push(`[codex-app-server] degraded: ${error.message}\n`);
          this.rejectTurnCompletion(error);
          this.kill();
          return;
        }
        this._outputBuffer.push(`[codex-app-server:event] ${method} ${name}\n`);
        break;
      }
      case 'warning':
      case 'account/rateLimits/updated':
      case 'skills/changed':
      case 'item/started':
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      default:
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
    }
  }

  private request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    if (!this._rpc) throw new Error('Codex app-server RPC is not connected');
    return this._rpc.request<T>(method, params);
  }

  private createTurnCompletion(timeoutMs = 30 * 60 * 1000): Promise<void> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._turnCompletion = null;
        reject(new Error('Timed out waiting for turn/completed'));
      }, timeoutMs);
      this._turnCompletion = { resolve, reject, timer };
    });
  }

  private resolveTurnCompletion(): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private emitUnsupportedRequestEvent(method: string): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'error',
        'codex_app_server_unsupported_request',
        'error',
        {
          runtime: 'codex-app-server',
          method,
          thread_id: this._threadId,
        },
      );
    } catch {
      // OutputBuffer warning above is the user-visible fallback.
    }
  }

  private setThreadId(threadId: string): void {
    this._threadId = threadId;
    const state: ThreadState = {
      threadId,
      cwd: this._cwd,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this._threadStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  /**
   * Translate a `thread/tokenUsage/updated` notification from codex-app-server
   * into the context_status.json shape consumed by the FastChecker context
   * monitor. Writes atomically; failures are non-fatal (observability only).
   *
   * Mapping (per codex schema ThreadTokenUsageUpdatedNotification):
   *   - used_percentage = last.totalTokens / cap * 100  (clamped to [0, 100])
   *   - context_window_size = modelContextWindow ?? config.codex_context_cap ?? 256000
   *   - exceeds_200k_tokens = last.totalTokens > 200000
   *   - current_usage.{input,output,cache_read} from last.{input,output,cachedInput}Tokens
   *   - session_id = current threadId
   *
   * `total` is lifetime cumulative across the app-server thread and can grow far
   * beyond the active model window. Context handoff must use the current window
   * occupancy (`last`) so long-lived threads do not report false 100%.
   */
  private writeContextStatus(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const current = isRecord(tokenUsage.last) ? tokenUsage.last : null;
    const currentTokens = current && typeof current.totalTokens === 'number' ? current.totalTokens : null;

    const modelContextWindow = typeof tokenUsage.modelContextWindow === 'number'
      ? tokenUsage.modelContextWindow
      : null;
    const cap = modelContextWindow ?? this._config.codex_context_cap ?? 256000;
    const usedPct = cap > 0 && currentTokens !== null
      ? Math.min(100, (currentTokens / cap) * 100)
      : null;

    const inputTokens = current && typeof current.inputTokens === 'number' ? current.inputTokens : 0;
    const outputTokens = current && typeof current.outputTokens === 'number' ? current.outputTokens : 0;
    const cachedInputTokens = current && typeof current.cachedInputTokens === 'number' ? current.cachedInputTokens : 0;

    const payload = JSON.stringify({
      used_percentage: usedPct,
      context_window_size: cap,
      exceeds_200k_tokens: currentTokens !== null ? currentTokens > 200000 : false,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: 0,
      },
      session_id: this._threadId,
      written_at: new Date().toISOString(),
    });

    try {
      atomicWriteSync(join(this._stateDir, 'context_status.json'), payload);
    } catch {
      // Non-fatal: FastChecker will skip stale/missing files gracefully.
    }
  }

  /**
   * Append a per-turn token usage record to <ctxRoot>/logs/<agent>/codex-tokens.jsonl
   * so the dashboard cost-parser can scan it alongside ~/.claude/projects/*.jsonl.
   * One JSONL line per `thread/tokenUsage/updated` notification; dedup by
   * (session_id, turn_id) is the parser's responsibility.
   */
  private appendCodexTokenLog(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;

    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (!turnId || !this._threadId) return;

    const entry = {
      timestamp: new Date().toISOString(),
      model: this._config.model || 'gpt-5-codex',
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
    };

    try {
      const logDir = join(this._env.ctxRoot, 'logs', this._env.agentName);
      ensureDir(logDir);
      appendFileSync(join(logDir, 'codex-tokens.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      // Non-fatal: cost reporting is observability only.
    }
  }

  private readThreadState(): ThreadState | null {
    if (!existsSync(this._threadStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._threadStatePath, 'utf-8')) as ThreadState;
      return parsed.cwd === this._cwd && parsed.threadId ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveSocketPath(): { path: string; listenArg: string; cwd: string } {
    const defaultPath = join(this._stateDir, SOCKET_BASENAME);
    if (Buffer.byteLength(defaultPath) < SOCKET_PATH_WARN_BYTES) {
      return { path: defaultPath, listenArg: `unix://./${SOCKET_BASENAME}`, cwd: this._stateDir };
    }

    const fallbackBasename = `cas-${randomBytes(4).toString('hex')}.sock`;
    const fallback = join('/tmp', fallbackBasename);
    const pointer: SocketPointer = {
      socketPath: fallback,
      fallback: true,
      reason: 'state socket path exceeded 100 bytes',
      updatedAt: new Date().toISOString(),
    };
    try {
      ensureDir(this._stateDir);
      writeFileSync(this._socketPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal; spawn will still use fallback path.
    }
    return { path: fallback, listenArg: `unix://./${fallbackBasename}`, cwd: '/tmp' };
  }

  private removeSocket(): void {
    try {
      if (existsSync(this._socketPath)) unlinkSync(this._socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  private cleanupSpawnAttempt(): void {
    const pty = this._appServerPty;
    this._appServerPty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore failed attempt cleanup errors.
      }
    }
    this.removeSocket();
  }

  private writeIdleFlag(): void {
    try {
      writeFileSync(join(this._stateDir, 'last_idle.flag'), Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch {
      // Non-fatal.
    }
  }

  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  private buildEnv(): Record<string, string> {
    const env = this.buildBaseEnv();

    // Codex workspaceWrite deliberately excludes the ambient TMPDIR and /tmp.
    // Rebind all conventional temp variables to one explicit, private write
    // root so ordinary tools retain scratch space without opening the agent's
    // broader state/control directory.
    env['TMPDIR'] = this._modelTempDir;
    env['TMP'] = this._modelTempDir;
    env['TEMP'] = this._modelTempDir;

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private preparePrivateModelTempDir(): void {
    ensureDir(this._stateDir);
    const stateStat = lstatSync(this._stateDir);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      throw new PermissionProfileError('Codex agent state directory must be a real directory');
    }
    chmodSync(this._stateDir, 0o700);

    if (existsSync(this._modelTempDir)) {
      const tempStat = lstatSync(this._modelTempDir);
      if (tempStat.isSymbolicLink() || !tempStat.isDirectory()) {
        throw new PermissionProfileError('Codex model temporary path must be a real directory');
      }
      // A prior unclean exit may leave model-created scratch data behind.
      // The seat is single-process; clear it before granting the new process.
      rmSync(this._modelTempDir, { recursive: true, force: false });
    }
    mkdirSync(this._modelTempDir, { recursive: false, mode: 0o700 });
    chmodSync(this._modelTempDir, 0o700);
  }

  private cleanupPrivateModelTempDir(): void {
    try {
      if (!existsSync(this._modelTempDir)) return;
      const stat = lstatSync(this._modelTempDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      rmSync(this._modelTempDir, { recursive: true, force: true });
    } catch {
      // Best-effort on process shutdown. The next spawn rejects unsafe path
      // types and clears a valid stale directory before reuse.
    }
  }

  private buildBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of BASE_ENV_VARS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const name = trimmed.slice(0, eqIdx).trim();
          if (this._envAllowlist.has(name)) {
            env[name] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    } catch {
      // Ignore env file read errors.
    }
  }

  private buildMcpConfigArgs(): string[] {
    const result = spawnSync('codex', [
      ...EXTERNAL_FEATURES_DISABLED_FOR_FLEET.flatMap((feature) => ['--disable', feature]),
      'mcp',
      'list',
      '--json',
    ], {
      env: this.buildBaseEnv(),
      cwd: this._cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      throw new PermissionProfileError('Unable to enumerate configured Codex MCP servers safely');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PermissionProfileError('Configured Codex MCP inventory was not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new PermissionProfileError('Configured Codex MCP inventory had an invalid shape');
    }

    const configured = new Map<string, boolean>();
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.enabled !== 'boolean') {
        throw new PermissionProfileError('Configured Codex MCP inventory had an invalid entry');
      }
      const name = validateMcpName(entry.name, 'configured MCP server name');
      if (configured.has(name)) {
        throw new PermissionProfileError('Configured Codex MCP inventory contained a duplicate name');
      }
      configured.set(name, entry.enabled);
    }

    for (const name of this._mcpAllowlist) {
      if (configured.get(name) !== true) {
        throw new PermissionProfileError(`Approved MCP server ${name} is not configured and enabled`);
      }
    }
    const disabled = [...configured.keys()].filter((name) => !this._mcpAllowlist.has(name)).sort();
    if (disabled.length === 0) return [];
    const inlineServers = disabled
      .map((name) => `${tomlString(name)}={enabled=false}`)
      .join(',');
    return ['-c', `mcp_servers={${inlineServers}}`];
  }

  private getPackageVersion(): string {
    try {
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function validateCredentialDenyPaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('codex_credential_deny_paths must contain at least one normalized absolute path');
  }

  const normalized = paths.map((path, index) => validateAbsolutePolicyPath(
    path,
    `codex_credential_deny_paths[${index}]`,
  ));
  return [...new Set(normalized)];
}

export function compileCodexCapabilityPolicy(
  config: AgentConfig,
  modelTempDir: string,
  socketPath: string,
): {
  credentialDenyPaths: string[];
  writablePaths: string[];
  readonlyPaths: string[];
  networkAllowDomains: string[];
  envAllowlist: string[];
  mcpAllowlist: string[];
  profile: { id: string; configArgs: string[] };
} {
  const credentialDenyPaths = validateCredentialDenyPaths(config.codex_credential_deny_paths);
  assertSensitivePathsHaveNoAliases(credentialDenyPaths, 'codex_credential_deny_paths');
  const writablePaths = [...new Set([
    ...validateWritablePaths(config.codex_writable_paths),
    validateAbsolutePolicyPath(modelTempDir, 'Codex model temporary directory'),
  ])].sort();
  const readonlyPaths = validateReadonlyPaths(config.codex_readonly_paths);
  assertSensitivePathsHaveNoAliases(readonlyPaths, 'codex_readonly_paths');
  const networkAllowDomains = validateNetworkAllowDomains(config.codex_network_allow_domains);
  const envAllowlist = validateEnvAllowlist(config.codex_env_allowlist);
  const mcpAllowlist = validateMcpAllowlist(config.codex_mcp_allowlist);
  const profile = buildPermissionProfile(
    credentialDenyPaths,
    writablePaths,
    readonlyPaths,
    networkAllowDomains,
    socketPath,
  );
  return {
    credentialDenyPaths,
    writablePaths,
    readonlyPaths,
    networkAllowDomains,
    envAllowlist,
    mcpAllowlist,
    profile,
  };
}

function assertSensitivePathsHaveNoAliases(
  paths: string[],
  policyField: 'codex_credential_deny_paths' | 'codex_readonly_paths',
): void {
  const maximumEntries = 10_000;
  let entries = 0;
  const inspect = (path: string): void => {
    if (!existsSync(path)) return;
    entries += 1;
    if (entries > maximumEntries) {
      throw new Error(`${policyField} exceeded the bounded inode audit`);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`${policyField} must not contain symbolic links`);
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) {
        throw new Error(
          `${policyField} contains a hard-linked file; every protected inode must have exactly one name before launch`,
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) inspect(join(path, name));
      return;
    }
    throw new Error(`${policyField} must contain only regular files or directories`);
  };
  for (const path of paths) inspect(path);
}

function validateWritablePaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths)) {
    throw new Error('codex_writable_paths must be an explicit array of normalized absolute paths');
  }
  return [...new Set(paths.map((path, index) => validateAbsolutePolicyPath(
    path,
    `codex_writable_paths[${index}]`,
  )))].sort();
}

function validateReadonlyPaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths)) {
    throw new Error('codex_readonly_paths must be an explicit array of normalized absolute paths');
  }
  return [...new Set(paths.map((path, index) => validateAbsolutePolicyPath(
    path,
    `codex_readonly_paths[${index}]`,
  )))].sort();
}

function validateNetworkAllowDomains(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) {
    throw new Error('codex_network_allow_domains must be an explicit array');
  }
  if (domains.length > 0) {
    throw new Error(
      'codex_network_allow_domains must remain empty: Codex 0.144.2 exposes only a networkAccess boolean and does not provide enforcement-grade exact-domain read-back',
    );
  }
  return [];
}

function validateEnvAllowlist(names: string[] | undefined): string[] {
  if (!Array.isArray(names)) {
    throw new Error('codex_env_allowlist must be an explicit array');
  }
  const validated = names.map((name, index) => {
    if (
      typeof name !== 'string'
      || !/^[A-Z_][A-Z0-9_]*$/.test(name)
      || name.startsWith('CTX_')
      || name.startsWith('DYLD_')
      || name.startsWith('LD_')
      || RESERVED_ENV_VARS.has(name)
    ) {
      throw new Error(`codex_env_allowlist[${index}] is not an allowed environment-variable name`);
    }
    return name;
  });
  return [...new Set(validated)].sort();
}

function validateMcpAllowlist(names: string[] | undefined): string[] {
  if (!Array.isArray(names)) {
    throw new Error('codex_mcp_allowlist must be an explicit array');
  }
  return [...new Set(names.map((name, index) => validateMcpName(
    name,
    `codex_mcp_allowlist[${index}]`,
  )))].sort();
}

function validateMcpName(name: unknown, label: string): string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > 128
    || name.trim() !== name
    || /[\0-\x1f\x7f]/.test(name)
  ) {
    throw new Error(`${label} must be a non-empty normalized MCP server name`);
  }
  return name;
}

function validateAbsolutePolicyPath(path: unknown, label: string): string {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.trim() !== path
    || path.includes('\0')
    || !isAbsolute(path)
    || normalize(path) !== path
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return path;
}

function buildPermissionProfile(
  credentialDenyPaths: string[],
  writablePaths: string[],
  readonlyPaths: string[],
  networkAllowDomains: string[],
  socketPath: string,
): { id: string; configArgs: string[] } {
  const exactSocketPath = validateAbsolutePolicyPath(socketPath, 'Codex app-server control socket');
  const denyPaths = [...new Set([...credentialDenyPaths, exactSocketPath])].sort();
  assertFilesystemPrivilegeLattice(denyPaths, readonlyPaths, writablePaths);
  assertSensitivePathsCannotBeRelocated(denyPaths, readonlyPaths, writablePaths);
  const id = `${PERMISSION_PROFILE_PREFIX}-${randomBytes(8).toString('hex')}`;
  const prefix = `permissions.${id}`;
  const filesystemPolicy = [
    ...writablePaths.map((path) => [path, 'write'] as const),
    ...readonlyPaths.map((path) => [path, 'read'] as const),
    ...denyPaths.map((path) => [path, 'deny'] as const),
  ].sort(([left], [right]) => left.localeCompare(right));
  const domainPolicy = networkAllowDomains.map((domain) => [domain, 'allow'] as const);
  const overrides = [
    `${prefix}.description=${tomlString('cortextOS fleet role workspace with isolated control plane')}`,
    `${prefix}.extends=${tomlString(':read-only')}`,
    `${prefix}.filesystem=${tomlStringMap(filesystemPolicy)}`,
    `${prefix}.network.enabled=${networkAllowDomains.length > 0}`,
    ...(domainPolicy.length > 0 ? [`${prefix}.network.domains=${tomlStringMap(domainPolicy)}`] : []),
    `${prefix}.network.unix_sockets=${tomlStringMap([[exactSocketPath, 'deny']])}`,
  ];
  return {
    id,
    configArgs: overrides.flatMap((override) => ['-c', override]),
  };
}

function canonicalizePolicyPath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return normalize(join(realpathSync(cursor), ...suffix.reverse()));
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return path;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const rel = relative(ancestor, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function privilegeReopensPath(candidate: string, stronger: string): boolean {
  return isSameOrDescendant(candidate, stronger)
    || isSameOrDescendant(canonicalizePolicyPath(candidate), canonicalizePolicyPath(stronger));
}

function assertFilesystemPrivilegeLattice(
  denyPaths: string[],
  readonlyPaths: string[],
  writablePaths: string[],
): void {
  for (const path of [...readonlyPaths, ...writablePaths]) {
    if (denyPaths.some((denied) => privilegeReopensPath(path, denied))) {
      throw new Error(
        'Codex readable or writable capability paths must not equal or descend from a credential or control-socket deny path',
      );
    }
  }
  for (const writable of writablePaths) {
    if (readonlyPaths.some((readonly) => privilegeReopensPath(writable, readonly))) {
      throw new Error(
        'codex_writable_paths must not equal or descend from codex_readonly_paths',
      );
    }
  }
}

function assertSensitivePathsCannotBeRelocated(
  denyPaths: string[],
  readonlyPaths: string[],
  writablePaths: string[],
): void {
  for (const sensitive of [...denyPaths, ...readonlyPaths]) {
    for (const writable of writablePaths) {
      for (const [candidate, root] of [
        [sensitive, writable],
        [canonicalizePolicyPath(sensitive), canonicalizePolicyPath(writable)],
      ] as const) {
        if (!isSameOrDescendant(candidate, root) || candidate === root) continue;
        const segments = relative(root, candidate).split(sep).filter(Boolean);
        if (segments.length > 1) {
          throw new Error(
            'Codex deny/read-only paths may be direct children of a writable root but must not sit below a renameable writable intermediate directory',
          );
        }
      }
    }
  }
}

function tomlStringMap(entries: ReadonlyArray<readonly [string, string]>): string {
  return `{${entries.map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(',')}}`;
}

function canonicalizeExistingPath(path: string): string {
  try {
    return require('fs').realpathSync(path) as string;
  } catch {
    return path;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
