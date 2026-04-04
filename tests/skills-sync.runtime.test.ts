import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import {
  getUserSkillsDir,
  syncHostSkillsForUser,
} from '../src/routes/skills.js';

const tempDirs: string[] = [];
const envSnapshots = new Map<string, string | undefined>();

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setEnv(name: string, value: string | undefined): void {
  if (!envSnapshots.has(name)) {
    envSnapshots.set(name, process.env[name]);
  }
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeSkill(root: string, id: string, description: string): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n`,
  );
}

afterEach(() => {
  for (const [name, value] of envSnapshots) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envSnapshots.clear();

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('host skill sync', () => {
  it('syncs from both ~/.claude/skills and ~/.codex/skills with ~/.claude precedence', async () => {
    const fakeHome = makeTempDir('happyclaw-home-');
    setEnv('HOME', fakeHome);

    const claudeSkillsDir = path.join(fakeHome, '.claude', 'skills');
    const codexSkillsDir = path.join(fakeHome, '.codex', 'skills');
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
    fs.mkdirSync(codexSkillsDir, { recursive: true });

    writeSkill(claudeSkillsDir, 'shared-skill', 'from claude');
    writeSkill(claudeSkillsDir, 'claude-only', 'claude only');
    writeSkill(codexSkillsDir, 'shared-skill', 'from codex');
    writeSkill(codexSkillsDir, 'codex-only', 'codex only');

    const userId = `sync-user-${Date.now()}`;
    const result = await syncHostSkillsForUser(userId);
    const userDir = getUserSkillsDir(userId);

    expect(result.total).toBe(3);
    expect(result.stats.added).toBe(3);
    expect(fs.existsSync(path.join(userDir, 'claude-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'codex-only', 'SKILL.md'))).toBe(true);

    const sharedContent = fs.readFileSync(
      path.join(userDir, 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(sharedContent).toContain('from claude');
    expect(sharedContent).not.toContain('from codex');

    fs.rmSync(path.join(DATA_DIR, 'skills', userId), {
      recursive: true,
      force: true,
    });
  });
});
