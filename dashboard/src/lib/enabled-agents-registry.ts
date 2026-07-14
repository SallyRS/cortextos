import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';

export type EnabledAgentsRegistry = Record<string, Record<string, unknown>>;

const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

function atomicWriteSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, `${data}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function acquireLock(lockRoot: string): boolean {
  const lockDir = join(lockRoot, '.lock.d');
  const pidFile = join(lockDir, 'pid');
  try {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let rawPid: string;
  try {
    rawPid = readFileSync(pidFile, 'utf-8').trim();
  } catch {
    return false;
  }
  const pid = Number.parseInt(rawPid, 10);
  if (!rawPid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    try {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return true;
    } catch {
      return false;
    }
  }
}

function withFileLockSync<T>(lockRoot: string, fn: () => T): T {
  const lockDir = join(lockRoot, '.lock.d');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const start = process.hrtime();
  let backoffMs = 5;
  while (!acquireLock(lockRoot)) {
    const [seconds, nanos] = process.hrtime(start);
    if ((seconds * 1000) + (nanos / 1_000_000) > 5_000) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${lockRoot}" within 5000ms`,
      );
    }
    Atomics.wait(sleepView, 0, 0, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 100);
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function enabledAgentsRegistryPath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'enabled-agents.json');
}

export function readEnabledAgentsRegistry(ctxRoot: string): EnabledAgentsRegistry {
  const path = enabledAgentsRegistryPath(ctxRoot);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as EnabledAgentsRegistry;
}

/**
 * Dashboard-local implementation of the shared registry contract. Keeping the
 * implementation inside the dashboard package avoids asking Next/Turbopack to
 * compile the root CommonJS package as ESM. The lock and file paths deliberately
 * match src/utils/enabled-agents-registry.ts so CLI and dashboard writers still
 * serialize against the same on-disk mutex.
 */
export function mutateEnabledAgentsRegistry<T>(
  ctxRoot: string,
  mutate: (registry: EnabledAgentsRegistry) => T,
): T {
  const configDir = join(ctxRoot, 'config');
  const lockRoot = join(configDir, 'enabled-agents-registry-lock');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(lockRoot, () => {
    const registry = readEnabledAgentsRegistry(ctxRoot);
    const result = mutate(registry);
    atomicWriteSync(
      enabledAgentsRegistryPath(ctxRoot),
      JSON.stringify(registry, null, 2),
    );
    return result;
  });
}
