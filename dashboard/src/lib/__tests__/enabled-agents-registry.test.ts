import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enabledAgentsRegistryPath,
  mutateEnabledAgentsRegistry,
  readEnabledAgentsRegistry,
} from '../enabled-agents-registry';

describe('dashboard enabled-agents registry', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function freshRoot(): string {
    root = mkdtempSync(join(tmpdir(), 'dashboard-enabled-agents-'));
    return root;
  }

  it('reads a missing registry as empty', () => {
    expect(readEnabledAgentsRegistry(freshRoot())).toEqual({});
  });

  it('serializes a mutation through the shared registry and lock paths', () => {
    const ctxRoot = freshRoot();
    const result = mutateEnabledAgentsRegistry(ctxRoot, (registry) => {
      registry.worker = { enabled: true };
      return 'written';
    });

    const path = enabledAgentsRegistryPath(ctxRoot);
    expect(result).toBe('written');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      worker: { enabled: true },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(
      ctxRoot,
      'config',
      'enabled-agents-registry-lock',
      '.lock.d',
    ))).toThrow();
  });

  it('fails closed on malformed registry state without overwriting it', () => {
    const ctxRoot = freshRoot();
    const configDir = join(ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    const path = enabledAgentsRegistryPath(ctxRoot);
    writeFileSync(path, '[]\n');

    expect(() => mutateEnabledAgentsRegistry(ctxRoot, () => undefined))
      .toThrow('must contain a JSON object');
    expect(readFileSync(path, 'utf-8')).toBe('[]\n');
  });
});
