import { randomBytes } from 'crypto';
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
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { withFileLockSync } from './lock.js';

export const CODEX_PERMISSION_MIGRATION_HOLD = 'codex-permission-migration.hold.json';
export const CODEX_PERMISSION_START_CLAIM = 'codex-permission-start.claim.json';
export const CODEX_PERMISSION_BARRIER = 'codex-permission-barrier';

export interface CodexPermissionStartClaim {
  path: string;
  raw: string;
}

interface CodexPermissionStartClaimValue {
  schemaVersion: 'cortextos-codex-permission-start-claim/v1';
  agent: string;
  pid: number;
  nonce: string;
}

export function codexPermissionMigrationHoldPath(
  ctxRoot: string,
  agent: string,
): string {
  return join(ctxRoot, 'state', agent, CODEX_PERMISSION_MIGRATION_HOLD);
}

export function codexPermissionStartClaimPath(
  ctxRoot: string,
  agent: string,
): string {
  return join(ctxRoot, 'state', agent, CODEX_PERMISSION_START_CLAIM);
}

export function codexPermissionBarrierRoot(
  ctxRoot: string,
  agent: string,
): string {
  return join(ctxRoot, 'state', agent, CODEX_PERMISSION_BARRIER);
}

/**
 * A malformed or attacker-created hold still blocks startup. The migration
 * command performs the stricter shape, inode, and ownership checks before it
 * may consume or clear one.
 */
export function hasCodexPermissionMigrationHold(
  ctxRoot: string,
  agent: string,
): boolean {
  return existsSync(codexPermissionMigrationHoldPath(ctxRoot, agent));
}

/**
 * Claim the synchronous start-preparation window shared with permission
 * migration. The daemon publishes the agent in its in-memory status registry
 * before releasing this claim. Migration therefore sees exactly one of:
 * an active claim, a durable hold, or the registered seat.
 */
export function acquireCodexPermissionStartClaim(
  ctxRoot: string,
  agent: string,
): CodexPermissionStartClaim | null {
  const stateDir = join(ctxRoot, 'state', agent);
  const barrierRoot = codexPermissionBarrierRoot(ctxRoot, agent);
  const path = codexPermissionStartClaimPath(ctxRoot, agent);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(barrierRoot, { recursive: true, mode: 0o700 });

  return withFileLockSync(barrierRoot, () => {
    if (hasCodexPermissionMigrationHold(ctxRoot, agent)) return null;
    if (existsSync(path)) {
      if (!recoverDeadCodexPermissionStartClaimWhileBarrierHeld(ctxRoot, agent)) {
        throw new Error(`A live Codex permission start claim already exists for ${agent}`);
      }
    }
    const value: CodexPermissionStartClaimValue = {
      schemaVersion: 'cortextos-codex-permission-start-claim/v1',
      agent,
      pid: process.pid,
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
      fsyncDirectory(stateDir);
      return { path, raw };
    } catch (err) {
      if (fd !== null) closeSync(fd);
      throw err;
    }
  });
}

/**
 * Recover a strict same-agent claim only when its recorded owner is dead.
 * The caller must already hold codexPermissionBarrierRoot(ctxRoot, agent), so
 * start and migration can both use the same parser without a nested lock.
 * Returns false when the owner is still live; malformed/unsafe claims throw.
 */
export function recoverDeadCodexPermissionStartClaimWhileBarrierHeld(
  ctxRoot: string,
  agent: string,
): boolean {
  const path = codexPermissionStartClaimPath(ctxRoot, agent);
  if (!existsSync(path)) return true;
  const existing = readStartClaim(path, agent);
  if (isProcessAlive(existing.value.pid)) return false;
  unlinkSync(path);
  fsyncDirectory(dirname(path));
  return true;
}

function readStartClaim(
  path: string,
  expectedAgent: string,
): { raw: string; value: CodexPermissionStartClaimValue } {
  const stat = lstatSync(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0
      || (currentUid !== null && stat.uid !== currentUid)) {
    throw new Error(`Codex permission start claim is unsafe for ${expectedAgent}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Codex permission start claim is malformed for ${expectedAgent}`);
  }
  const keys = ['agent', 'nonce', 'pid', 'schemaVersion'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\n') !== keys.join('\n')) {
    throw new Error(`Codex permission start claim is malformed for ${expectedAgent}`);
  }
  const claim = value as CodexPermissionStartClaimValue;
  if (claim.schemaVersion !== 'cortextos-codex-permission-start-claim/v1'
      || claim.agent !== expectedAgent
      || !Number.isSafeInteger(claim.pid) || claim.pid <= 0
      || !/^[a-f0-9]{32}$/.test(claim.nonce)) {
    throw new Error(`Codex permission start claim is malformed for ${expectedAgent}`);
  }
  return { raw, value: claim };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Release only the exact claim created by this start attempt. A replaced or
 * malformed claim stays in place and keeps migration fail-closed.
 */
export function releaseCodexPermissionStartClaim(
  ctxRoot: string,
  agent: string,
  claim: CodexPermissionStartClaim,
): void {
  const barrierRoot = codexPermissionBarrierRoot(ctxRoot, agent);
  withFileLockSync(barrierRoot, () => {
    if (claim.path !== codexPermissionStartClaimPath(ctxRoot, agent)
        || readFileSync(claim.path, 'utf-8') !== claim.raw) {
      throw new Error(`Codex permission start claim changed before release for ${agent}`);
    }
    unlinkSync(claim.path);
    fsyncDirectory(dirname(claim.path));
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
