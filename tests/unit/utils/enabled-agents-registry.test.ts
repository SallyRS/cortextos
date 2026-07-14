import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mutateEnabledAgentsRegistry,
  readEnabledAgentsRegistry,
} from '../../../src/utils/enabled-agents-registry.js';

describe('enabled-agents registry transaction', () => {
  let root: string;
  let registryPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enabled-agents-registry-'));
    registryPath = join(root, 'config', 'enabled-agents.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes a read-modify-write through atomic replacement', () => {
    mutateEnabledAgentsRegistry(root, (registry) => {
      registry.alice = { enabled: false, org: 'acme' };
    });
    mutateEnabledAgentsRegistry(root, (registry) => {
      registry.bob = { enabled: true, org: 'acme' };
    });

    expect(readEnabledAgentsRegistry(root)).toEqual({
      alice: { enabled: false, org: 'acme' },
      bob: { enabled: true, org: 'acme' },
    });
    expect(readFileSync(registryPath, 'utf-8').endsWith('\n')).toBe(true);
  });

  it('refuses to overwrite an existing malformed registry', () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(registryPath, 'not json');

    expect(() => mutateEnabledAgentsRegistry(root, (registry) => {
      registry.alice = { enabled: true };
    })).toThrow();
    expect(readFileSync(registryPath, 'utf-8')).toBe('not json');
  });
});
