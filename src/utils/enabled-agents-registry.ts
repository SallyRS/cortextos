import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from './atomic.js';
import { withFileLockSync } from './lock.js';

export type EnabledAgentsRegistry = Record<string, Record<string, unknown>>;

export function enabledAgentsRegistryPath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'enabled-agents.json');
}

export function readEnabledAgentsRegistry(ctxRoot: string): EnabledAgentsRegistry {
  const path = enabledAgentsRegistryPath(ctxRoot);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as EnabledAgentsRegistry;
}

/**
 * Serialize every registry read-modify-write across CLI and dashboard writers,
 * then replace the file atomically. Existing malformed state is never treated
 * as an empty registry and overwritten.
 */
export function mutateEnabledAgentsRegistry<T>(
  ctxRoot: string,
  mutate: (registry: EnabledAgentsRegistry) => T,
): T {
  const configDir = join(ctxRoot, 'config');
  const lockRoot = join(configDir, 'enabled-agents-registry-lock');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
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
