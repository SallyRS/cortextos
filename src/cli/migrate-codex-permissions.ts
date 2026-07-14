import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import {
  codexPermissionBarrierRoot,
  codexPermissionMigrationHoldPath,
  codexPermissionStartClaimPath,
  recoverDeadCodexPermissionStartClaimWhileBarrierHeld,
} from '../utils/codex-permission-migration.js';
import {
  applyCodexCapabilityProfile,
  buildDefaultCodexCapabilityProfile,
  mergeCodexCapabilityProfile,
  type CodexCapabilityProfile,
} from '../utils/codex-capability-profile.js';
import { validateAgentName, validateInstanceId, validateOrgName } from '../utils/validate.js';
import { compileCodexCapabilityPolicy } from '../pty/codex-app-server-pty.js';
import type { AgentConfig } from '../types/index.js';

const MIGRATION_HOLD_SCHEMA = 'cortextos-codex-permission-migration-hold/v1';
const SHA256 = /^[a-f0-9]{64}$/;

interface MigrationHold {
  schemaVersion: typeof MIGRATION_HOLD_SCHEMA;
  agent: string;
  sourceConfigSha256: string;
  targetConfigSha256: string;
  profileSha256: string;
  nonce: string;
}

interface MigrationHoldLease {
  path: string;
  barrierRoot: string;
  raw: string;
  value: MigrationHold;
  created: boolean;
}

export function codexCapabilityProfileHash(profile: CodexCapabilityProfile): string {
  return createHash('sha256').update(JSON.stringify(profile, null, 2) + '\n').digest('hex');
}

export function codexConfigHash(rawConfig: string): string {
  return createHash('sha256').update(rawConfig).digest('hex');
}

export const migrateCodexPermissionsCommand = new Command('migrate-codex-permissions')
  .argument('<agent>', 'Existing codex-app-server agent name')
  .option('--org <org>', 'Organization name when it cannot be resolved uniquely')
  .option('--instance <id>', 'Instance ID (defaults to CTX_INSTANCE_ID, then default)')
  .option('--apply', 'Atomically write the reviewed profile (default is dry-run)')
  .option('--expect <sha256>', 'Exact profile hash printed by the dry-run')
  .option('--expect-config <sha256>', 'Exact full config hash printed by the dry-run')
  .description('Prepare or apply an explicit fail-closed Codex capability profile')
  .action(async (
    agent: string,
    options: {
      org?: string;
      instance?: string;
      apply?: boolean;
      expect?: string;
      expectConfig?: string;
    },
  ) => {
    try {
      validateAgentName(agent);
      if (options.instance && process.env.CTX_INSTANCE_ID
          && options.instance !== process.env.CTX_INSTANCE_ID) {
        throw new Error(
          `--instance ${options.instance} conflicts with CTX_INSTANCE_ID=${process.env.CTX_INSTANCE_ID}`,
        );
      }
      const instance = options.instance || process.env.CTX_INSTANCE_ID || 'default';
      validateInstanceId(instance);
      const projectRoot = process.env.CTX_FRAMEWORK_ROOT
        || process.env.CTX_PROJECT_ROOT
        || process.cwd();
      const org = resolveAgentOrg(projectRoot, agent, options.org);
      const agentDir = join(projectRoot, 'orgs', org, 'agents', agent);
      const configPath = join(agentDir, 'config.json');
      if (!existsSync(configPath)) throw new Error(`No config.json found for ${agent}`);

      const originalConfig = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(originalConfig) as Record<string, unknown>;
      if (config.runtime !== 'codex-app-server') {
        throw new Error(`${agent} is not configured for runtime=codex-app-server`);
      }
      const defaults = buildDefaultCodexCapabilityProfile(agentDir, projectRoot, org);
      const profile = mergeCodexCapabilityProfile(config, defaults);
      const updated = applyCodexCapabilityProfile(config, profile);
      const ctxRoot = resolveMigrationCtxRoot(instance);
      const stateDir = join(ctxRoot, 'state', agent);
      compileCodexCapabilityPolicy(
        updated as AgentConfig,
        join(stateDir, 'model-tmp'),
        join(stateDir, 'codex.sock'),
      );
      const profileSha256 = codexCapabilityProfileHash(profile);
      const configSha256 = codexConfigHash(originalConfig);
      const review = {
        agent, org, instance, configPath, configSha256, profileSha256, profile,
      };

      if (!options.apply) {
        console.log(JSON.stringify(review, null, 2));
        console.log(
          `\nStop the seat if it is running, review the profile, then apply with --apply --expect ${profileSha256} --expect-config ${configSha256}`,
        );
        return;
      }
      if (!options.expect || options.expect !== profileSha256) {
        throw new Error('Refusing to apply without the exact current dry-run profile hash');
      }
      if (!options.expectConfig || !SHA256.test(options.expectConfig)) {
        throw new Error('Refusing to apply without the exact current full-config hash');
      }
      const targetConfigBody = JSON.stringify(updated, null, 2);
      const targetConfig = `${targetConfigBody}\n`;
      const targetConfigSha256 = codexConfigHash(targetConfig);
      const migrationLockRoot = join(stateDir, 'permission-migration-lock');
      mkdirSync(migrationLockRoot, { recursive: true });
      const lease = acquireMigrationHold({
        ctxRoot,
        agent,
        sourceConfigSha256: options.expectConfig,
        targetConfigSha256,
        profileSha256,
      });
      let committed = false;
      try {
        // The dedicated hold is visible to AgentManager before the status
        // request. It blocks new starts without repurposing the autostart bit
        // used by approval-gated Command Center workers.
        await assertSeatAbsent(agent, instance);
        const currentConfig = readFileSync(configPath, 'utf-8');
        const currentConfigSha256 = codexConfigHash(currentConfig);
        if (!lease.created && currentConfigSha256 === lease.value.targetConfigSha256) {
          clearMigrationHold(lease);
          console.log(`Recovered completed Codex capability migration ${profileSha256} at ${configPath}`);
          console.log(`Seat ${agent} was not started or enabled by migration.`);
          return;
        }
        if (currentConfigSha256 !== lease.value.sourceConfigSha256
            || currentConfig !== originalConfig) {
          throw new Error('Refusing to apply because config.json changed after review');
        }
        withFileLockSync(migrationLockRoot, () => {
          const lockedConfig = readFileSync(configPath, 'utf-8');
          if (codexConfigHash(lockedConfig) !== lease.value.sourceConfigSha256
              || lockedConfig !== originalConfig) {
            throw new Error('Refusing to apply because config.json changed after review');
          }
          atomicWriteSync(configPath, targetConfigBody);
        });
        committed = true;
        if (readFileSync(configPath, 'utf-8') !== targetConfig) {
          throw new Error('Codex capability migration write could not be verified');
        }
        clearMigrationHold(lease);
      } catch (err) {
        // A post-write failure deliberately leaves the hold in place so no
        // seat can start from an uncertain revision. A newly created pre-write
        // hold can be removed exactly; a recovered hold remains for retry.
        if (!committed && lease.created) clearMigrationHold(lease);
        throw err;
      }
      console.log(`Applied Codex capability profile ${profileSha256} to ${configPath}`);
      console.log(`Seat ${agent} was not started or enabled by migration.`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

function resolveAgentOrg(projectRoot: string, agent: string, requested?: string): string {
  if (requested) {
    validateOrgName(requested);
    const requestedDir = join(projectRoot, 'orgs', requested, 'agents', agent);
    if (!existsSync(requestedDir)) throw new Error(`Agent ${agent} was not found in org ${requested}`);
    return requested;
  }
  const orgsRoot = join(projectRoot, 'orgs');
  if (!existsSync(orgsRoot)) throw new Error('No orgs directory was found');
  const matches = readdirSync(orgsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((org) => existsSync(join(orgsRoot, org, 'agents', agent)));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Agent ${agent} was not found`
        : `Agent ${agent} exists in multiple orgs; pass --org explicitly`,
    );
  }
  validateOrgName(matches[0]);
  return matches[0];
}

async function assertSeatAbsent(agent: string, instance: string): Promise<void> {
  const ipc = new IPCClient(instance);
  let response;
  try {
    response = await ipc.send({
      type: 'status',
      source: 'cortextos migrate-codex-permissions',
    });
  } catch (err) {
    throw new Error(
      `Could not prove the target seat is absent from daemon status: ${(err as Error).message}`,
    );
  }
  if (!response.success) {
    throw new Error(
      `Could not prove the target seat is absent from daemon status: ${response.error || 'unknown IPC failure'}`,
    );
  }
  if (!Array.isArray(response.data)) {
    throw new Error('Could not prove the target seat is absent from daemon status');
  }
  const target = (response.data as Array<{ name?: string; status?: string }>)
    .find((status) => status.name === agent);
  if (target) {
    throw new Error(
      `Seat ${agent} must be absent from daemon status before migration (current: ${target.status})`,
    );
  }
}

function resolveMigrationCtxRoot(instance: string): string {
  validateInstanceId(instance);
  const canonical = resolve(join(homedir(), '.cortextos', instance));
  if (process.env.CTX_ROOT && resolve(process.env.CTX_ROOT) !== canonical) {
    throw new Error(
      `CTX_ROOT does not match --instance ${instance}; refusing to prove state against different instances`,
    );
  }
  return canonical;
}

function acquireMigrationHold(input: {
  ctxRoot: string;
  agent: string;
  sourceConfigSha256: string;
  targetConfigSha256: string;
  profileSha256: string;
}): MigrationHoldLease {
  const barrierRoot = codexPermissionBarrierRoot(input.ctxRoot, input.agent);
  mkdirSync(barrierRoot, { recursive: true, mode: 0o700 });
  return withFileLockSync(barrierRoot, () => {
    if (existsSync(codexPermissionStartClaimPath(input.ctxRoot, input.agent))) {
      if (!recoverDeadCodexPermissionStartClaimWhileBarrierHeld(input.ctxRoot, input.agent)) {
        throw new Error(`Seat ${input.agent} has a start preparation in progress`);
      }
    }
    return acquireMigrationHoldUnlocked(input, barrierRoot);
  });
}

function acquireMigrationHoldUnlocked(input: {
  ctxRoot: string;
  agent: string;
  sourceConfigSha256: string;
  targetConfigSha256: string;
  profileSha256: string;
}, barrierRoot: string): MigrationHoldLease {
  const path = codexPermissionMigrationHoldPath(input.ctxRoot, input.agent);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value: MigrationHold = {
    schemaVersion: MIGRATION_HOLD_SCHEMA,
    agent: input.agent,
    sourceConfigSha256: input.sourceConfigSha256,
    targetConfigSha256: input.targetConfigSha256,
    profileSha256: input.profileSha256,
    nonce: randomBytes(16).toString('hex'),
  };
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    chmodSync(path, 0o600);
    writeFileSync(fd, raw, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    fsyncDirectory(dirname(path));
    return { path, barrierRoot, raw, value, created: true };
  } catch (err) {
    if (fd !== null) closeSync(fd);
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = readMigrationHold(path);
    for (const key of ['agent', 'sourceConfigSha256', 'targetConfigSha256', 'profileSha256'] as const) {
      if (existing.value[key] !== value[key]) {
        throw new Error(`A different Codex permission migration hold already exists for ${input.agent}`);
      }
    }
    return { ...existing, barrierRoot, created: false };
  }
}

function readMigrationHold(
  path: string,
): Omit<MigrationHoldLease, 'created' | 'barrierRoot'> {
  const stat = lstatSync(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error('Codex permission migration hold has unsafe inode or mode');
  }
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error('Codex permission migration hold has unsafe ownership');
  }
  const raw = readFileSync(path, 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Codex permission migration hold is malformed');
  }
  const expectedKeys = [
    'agent', 'nonce', 'profileSha256', 'schemaVersion',
    'sourceConfigSha256', 'targetConfigSha256',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\n') !== expectedKeys.sort().join('\n')) {
    throw new Error('Codex permission migration hold is malformed');
  }
  const hold = value as MigrationHold;
  if (hold.schemaVersion !== MIGRATION_HOLD_SCHEMA
      || typeof hold.agent !== 'string' || !hold.agent
      || !SHA256.test(hold.sourceConfigSha256)
      || !SHA256.test(hold.targetConfigSha256)
      || !SHA256.test(hold.profileSha256)
      || !/^[a-f0-9]{32}$/.test(hold.nonce)) {
    throw new Error('Codex permission migration hold is malformed');
  }
  return { path, raw, value: hold };
}

function clearMigrationHold(lease: MigrationHoldLease): void {
  withFileLockSync(lease.barrierRoot, () => {
    const current = readMigrationHold(lease.path);
    if (current.raw !== lease.raw) {
      throw new Error('Codex permission migration hold changed before release');
    }
    unlinkSync(lease.path);
    fsyncDirectory(dirname(lease.path));
  });
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
