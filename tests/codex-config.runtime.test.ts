import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import {
  getBalancingConfig,
  getCodexProviderConfigWithSource,
  getCodexRuntimeEnvVars,
  getEffectiveCodexHomeDir,
  getProviders,
  saveCodexProviderConfig,
} from '../src/runtime-config.js';

const envSnapshots = new Map<string, string | undefined>();
const tempDirs: string[] = [];

const CODEX_CONFIG_FILE = path.join(DATA_DIR, 'config', 'codex-provider.json');
const MANAGED_CODEX_HOME_DIR = path.join(DATA_DIR, 'config', 'codex-home');

let configBackupPath: string | null = null;
let homeBackupPath: string | null = null;

function setEnv(name: string, value: string | undefined): void {
  if (!envSnapshots.has(name)) {
    envSnapshots.set(name, process.env[name]);
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function backupPathIfExists(targetPath: string): string | null {
  if (!fs.existsSync(targetPath)) return null;
  const backupDir = makeTempDir('happyclaw-codex-config-backup-');
  const backupPath = path.join(backupDir, path.basename(targetPath));
  fs.renameSync(targetPath, backupPath);
  return backupPath;
}

function restoreBackup(backupPath: string | null, targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
  if (!backupPath || !fs.existsSync(backupPath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(backupPath, targetPath);
}

function isolateCodexConfigState(): void {
  fs.mkdirSync(path.dirname(CODEX_CONFIG_FILE), { recursive: true });
  if (configBackupPath === null) {
    configBackupPath = backupPathIfExists(CODEX_CONFIG_FILE);
  }
  if (homeBackupPath === null) {
    homeBackupPath = backupPathIfExists(MANAGED_CODEX_HOME_DIR);
  }
  fs.rmSync(CODEX_CONFIG_FILE, { force: true });
  fs.rmSync(MANAGED_CODEX_HOME_DIR, { recursive: true, force: true });
}

afterEach(() => {
  for (const [name, value] of envSnapshots) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envSnapshots.clear();

  restoreBackup(configBackupPath, CODEX_CONFIG_FILE);
  restoreBackup(homeBackupPath, MANAGED_CODEX_HOME_DIR);
  configBackupPath = null;
  homeBackupPath = null;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex runtime config', () => {
  it('persists managed Codex config with encrypted storage and materialized home files', () => {
    isolateCodexConfigState();
    setEnv('CODEX_HOME', undefined);
    setEnv('OPENAI_API_KEY', undefined);

    const providersBefore = getProviders().map((provider) => provider.id);
    const balancingBefore = getBalancingConfig();

    const saved = saveCodexProviderConfig({
      authJson: '{"token":"managed-token"}',
      configToml: 'model = "gpt-5"\n',
      openaiApiKey: 'sk-managed',
    });

    expect(saved.updatedAt).toBeTruthy();
    expect(fs.existsSync(CODEX_CONFIG_FILE)).toBe(true);
    expect(fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8')).not.toContain(
      'managed-token',
    );
    expect(
      fs.readFileSync(path.join(MANAGED_CODEX_HOME_DIR, 'auth.json'), 'utf-8'),
    ).toContain('managed-token');
    expect(
      fs.readFileSync(
        path.join(MANAGED_CODEX_HOME_DIR, 'config.toml'),
        'utf-8',
      ),
    ).toContain('model = "gpt-5"');

    const loaded = getCodexProviderConfigWithSource();
    expect(loaded.source).toBe('runtime');
    expect(loaded.homePath).toBe(MANAGED_CODEX_HOME_DIR);
    expect(loaded.config.authJson).toContain('managed-token');
    expect(getEffectiveCodexHomeDir()).toBe(MANAGED_CODEX_HOME_DIR);
    expect(getCodexRuntimeEnvVars()).toEqual({ OPENAI_API_KEY: 'sk-managed' });
    expect(getProviders().map((provider) => provider.id)).toEqual(providersBefore);
    expect(getBalancingConfig()).toEqual(balancingBefore);
  });

  it('prefers explicit CODEX_HOME and OPENAI_API_KEY env overrides when present', () => {
    isolateCodexConfigState();
    const envHome = makeTempDir('happyclaw-codex-env-home-');
    fs.writeFileSync(path.join(envHome, 'auth.json'), '{"token":"env-token"}\n');
    fs.writeFileSync(path.join(envHome, 'config.toml'), 'model = "gpt-5-mini"\n');
    setEnv('CODEX_HOME', envHome);
    setEnv('OPENAI_API_KEY', 'sk-env');

    const loaded = getCodexProviderConfigWithSource();
    expect(loaded.source).toBe('env');
    expect(loaded.homePath).toBe(envHome);
    expect(loaded.config.authJson).toContain('env-token');
    expect(loaded.config.configToml).toContain('gpt-5-mini');
    expect(getEffectiveCodexHomeDir()).toBe(envHome);
    expect(getCodexRuntimeEnvVars()).toEqual({ OPENAI_API_KEY: 'sk-env' });
  });

  it('rejects invalid auth.json payloads with a clear error', () => {
    isolateCodexConfigState();
    expect(() =>
      saveCodexProviderConfig({
        authJson: '{not-json}',
        configToml: '',
        openaiApiKey: '',
      }),
    ).toThrow('Invalid field: authJson');
  });
});
