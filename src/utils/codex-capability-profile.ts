import { homedir } from 'os';
import { join, resolve } from 'path';

export const CODEX_CAPABILITY_KEYS = [
  'codex_credential_deny_paths',
  'codex_writable_paths',
  'codex_readonly_paths',
  'codex_network_allow_domains',
  'codex_env_allowlist',
  'codex_mcp_allowlist',
] as const;

export type CodexCapabilityKey = typeof CODEX_CAPABILITY_KEYS[number];
export type CodexCapabilityProfile = Record<CodexCapabilityKey, string[]> & {
  codex_web_search_enabled: boolean;
};

const IMMUTABLE_AGENT_FILES = [
  '.gitignore',
  'AGENTS.md',
  'GOALS.md',
  'GUARDRAILS.md',
  'IDENTITY.md',
  'SOUL.md',
  'SYSTEM.md',
  'TOOLS.md',
  'USER.md',
  'config.json',
  'goals.json',
] as const;

export function buildDefaultCodexCapabilityProfile(
  agentDir: string,
  projectRoot: string,
  org: string,
): CodexCapabilityProfile {
  const absoluteAgentDir = resolve(agentDir);
  const absoluteProjectRoot = resolve(projectRoot);
  return {
    codex_credential_deny_paths: [
      join(absoluteAgentDir, '.env'),
      join(absoluteProjectRoot, 'orgs', org, 'secrets.env'),
      join(homedir(), '.codex', 'auth.json'),
      join(homedir(), '.codex', 'config.toml'),
    ],
    codex_writable_paths: [absoluteAgentDir],
    codex_readonly_paths: IMMUTABLE_AGENT_FILES.map((name) => join(absoluteAgentDir, name)),
    codex_network_allow_domains: [],
    codex_env_allowlist: [],
    codex_mcp_allowlist: [],
    codex_web_search_enabled: false,
  };
}

export function mergeCodexCapabilityProfile(
  config: Record<string, unknown>,
  defaults: CodexCapabilityProfile,
): CodexCapabilityProfile {
  const merged = {} as CodexCapabilityProfile;
  for (const key of CODEX_CAPABILITY_KEYS) {
    const current = config[key];
    if (current === undefined) {
      merged[key] = [...defaults[key]];
      continue;
    }
    if (!Array.isArray(current) || !current.every((value) => typeof value === 'string')) {
      throw new Error(`${key} is present but malformed; refusing to infer a replacement`);
    }
    merged[key] = (key === 'codex_credential_deny_paths' || key === 'codex_readonly_paths')
      ? [...new Set([...defaults[key], ...current])]
      : [...new Set(current)];
  }
  const webSearch = config.codex_web_search_enabled;
  if (webSearch !== undefined && typeof webSearch !== 'boolean') {
    throw new Error('codex_web_search_enabled is present but malformed; refusing to infer a replacement');
  }
  merged.codex_web_search_enabled = webSearch ?? defaults.codex_web_search_enabled;
  return merged;
}

export function applyCodexCapabilityProfile(
  config: Record<string, unknown>,
  profile: CodexCapabilityProfile,
): Record<string, unknown> {
  return { ...config, ...profile };
}
