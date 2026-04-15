import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listFiles, scanSkillDirectory } from '../src/skill-utils.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill-utils symlink handling', () => {
  it('includes skill directories exposed via symlink', () => {
    const rootDir = makeTempDir('happyclaw-skills-root-');
    const realSkillDir = makeTempDir('happyclaw-skills-real-');
    fs.writeFileSync(
      path.join(realSkillDir, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: linked\n---\n',
    );
    fs.symlinkSync(realSkillDir, path.join(rootDir, 'linked-skill'));

    const skills = scanSkillDirectory(rootDir, 'user');

    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe('linked-skill');
    expect(skills[0]?.description).toBe('linked');
  });

  it('classifies symlinked directories as directories in file listings', () => {
    const rootDir = makeTempDir('happyclaw-skill-list-root-');
    const nestedDir = makeTempDir('happyclaw-skill-list-dir-');
    fs.writeFileSync(path.join(rootDir, 'plain.txt'), 'plain\n');
    fs.symlinkSync(nestedDir, path.join(rootDir, 'linked-dir'));

    const files = listFiles(rootDir);

    expect(files).toContainEqual({
      name: 'linked-dir',
      type: 'directory',
      size: 0,
    });
    expect(files).toContainEqual({
      name: 'plain.txt',
      type: 'file',
      size: 'plain\n'.length,
    });
  });
});
