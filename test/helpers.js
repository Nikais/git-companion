import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService } from '../src/git.js';

export function git(repo, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function fixture(t, { initial = true, ...options } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-mcp-test-'));
  const service = new GitService(options);
  t.after(async () => { await service.close(); await rm(repo, { recursive: true, force: true }); });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Git MCP Test');
  git(repo, 'config', 'user.email', 'git-mcp@example.invalid');
  if (initial) {
    await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
    git(repo, 'add', '--', 'hello.txt');
    git(repo, 'commit', '-m', 'initial');
  }
  const call = (name, args = {}) => service.execute(name, { repo_path: repo, ...args });
  return { repo, service, call };
}
