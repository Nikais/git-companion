import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitService, runGit } from '../src/git.js';
import { fixture, git } from './helpers.js';

test('unborn repository, staging and unstaging preserve the working file', async t => {
  const { repo, call } = await fixture(t, { initial: false });
  const before = await call('git_status');
  assert.equal(before.head, null);
  assert.equal(before.branch, 'main');
  await writeFile(path.join(repo, 'new.txt'), 'new\n');
  await call('git_add', { paths: ['new.txt'] });
  assert.equal((await call('git_status')).files[0].status, 'A ');
  await call('git_unstage', { paths: ['new.txt'] });
  assert.equal((await call('git_status')).files[0].status, '??');
  assert.equal(await readFile(path.join(repo, 'new.txt'), 'utf8'), 'new\n');
});

test('status handles spaces, Unicode, newline and renamed files', async t => {
  const { repo, call } = await fixture(t);
  const name = 'новый файл\nline.txt';
  await writeFile(path.join(repo, name), 'content\n');
  git(repo, 'mv', 'hello.txt', 'renamed hello.txt');
  const status = await call('git_status');
  assert.ok(status.files.some(file => file.path === name && file.status === '??'));
  assert.ok(status.files.some(file => file.path === 'renamed hello.txt' && file.original_path === 'hello.txt'));
});

test('paths are literal, including leading dashes and Git pathspec syntax', async t => {
  const { repo, call } = await fixture(t);
  for (const name of ['*.txt', '-danger.txt', ':(glob)*', 'other.txt']) await writeFile(path.join(repo, name), name);
  await call('git_add', { paths: ['*.txt', '-danger.txt', ':(glob)*'] });
  const files = (await call('git_status')).files;
  assert.equal(files.find(file => file.path === 'other.txt').status, '??');
  for (const name of ['*.txt', '-danger.txt', ':(glob)*']) assert.equal(files.find(file => file.path === name).status, 'A ');
});

test('staged and working diffs are distinct; fingerprint guards commits', async t => {
  const { repo, call } = await fixture(t);
  await writeFile(path.join(repo, 'hello.txt'), 'staged\n');
  await call('git_add', { paths: ['hello.txt'] });
  const staged = await call('git_diff', { mode: 'staged' });
  await writeFile(path.join(repo, 'hello.txt'), 'unstaged\n');
  assert.match(staged.diff, /\+staged/);
  assert.match((await call('git_diff')).diff, /\+unstaged/);
  const commit = await call('git_commit', { message: 'fix: update hello\n\nKeep the working edit.', expected_index_fingerprint: staged.index_fingerprint });
  assert.equal(git(repo, 'show', 'HEAD:hello.txt'), 'staged\n');
  assert.equal(commit.commit, git(repo, 'rev-parse', 'HEAD').trim());
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'unstaged\n');
  assert.equal((await call('git_status')).files[0].status, ' M');
});

test('changed index is refused without creating a commit', async t => {
  const { repo, call } = await fixture(t);
  await writeFile(path.join(repo, 'hello.txt'), 'one');
  await call('git_add', { paths: ['hello.txt'] });
  const reviewed = await call('git_diff', { mode: 'staged' });
  await writeFile(path.join(repo, 'hello.txt'), 'two');
  await call('git_add', { paths: ['hello.txt'] });
  await assert.rejects(call('git_commit', { message: 'fix: stale snapshot', expected_index_fingerprint: reviewed.index_fingerprint }), { code: 'INDEX_CHANGED' });
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('empty commits are refused and the first real commit works', async t => {
  const { repo, call } = await fixture(t, { initial: false });
  let snapshot = await call('git_diff', { mode: 'staged' });
  await assert.rejects(call('git_commit', { message: 'empty', expected_index_fingerprint: snapshot.index_fingerprint }), { code: 'EMPTY_COMMIT' });
  await writeFile(path.join(repo, 'first'), 'first');
  await call('git_add', { paths: ['first'] });
  snapshot = await call('git_diff', { mode: 'staged' });
  await call('git_commit', { message: 'feat: first', expected_index_fingerprint: snapshot.index_fingerprint });
  assert.equal((await call('git_log')).commits[0].subject, 'feat: first');
});

test('history, show and branch range diffs refer to real commits', async t => {
  const { repo, call } = await fixture(t);
  await call('git_create_branch', { name: 'feature' });
  assert.equal((await call('git_status')).branch, 'main');
  await call('git_switch_branch', { name: 'feature' });
  await writeFile(path.join(repo, 'hello.txt'), 'feature\n');
  git(repo, 'add', 'hello.txt');
  git(repo, 'commit', '-m', 'feat: example', '-m', 'Detailed body\nsecond line');
  const history = await call('git_log', { limit: 2 });
  assert.deepEqual(history.commits.map(commit => commit.subject), ['feat: example', 'initial']);
  assert.equal(history.commits[0].body, 'Detailed body\nsecond line');
  assert.match((await call('git_show')).output, /\+feature/);
  assert.match((await call('git_diff', { mode: 'range', base: 'main' })).diff, /\+feature/);
  assert.equal((await call('git_branches')).branches.find(branch => branch.current).name, 'feature');
});

test('merge-base diff excludes changes unique to the base branch', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'branch', 'feature');
  await writeFile(path.join(repo, 'base-only'), 'base\n');
  git(repo, 'add', 'base-only');
  git(repo, 'commit', '-m', 'base advances');
  git(repo, 'switch', 'feature');
  await writeFile(path.join(repo, 'feature-only'), 'feature\n');
  git(repo, 'add', 'feature-only');
  git(repo, 'commit', '-m', 'feature advances');
  const branch = await call('git_diff', { mode: 'range', base: 'main' });
  assert.match(branch.diff, /feature-only/);
  assert.doesNotMatch(branch.diff, /base-only/);
  assert.match((await call('git_diff', { mode: 'range', base: 'main', merge_base: false })).diff, /base-only/);
});

test('switch refuses dirty worktrees and never overwrites existing branches', async t => {
  const { repo, call } = await fixture(t);
  await call('git_create_branch', { name: 'feature' });
  await assert.rejects(call('git_create_branch', { name: 'feature' }), { code: 'GIT_ERROR' });
  await writeFile(path.join(repo, 'untracked'), 'keep');
  await assert.rejects(call('git_switch_branch', { name: 'feature' }), { code: 'DIRTY_WORKTREE' });
  assert.equal((await call('git_status')).branch, 'main');
});

test('detached HEAD is represented without a branch name', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'switch', '--detach', 'HEAD');
  const status = await call('git_status');
  assert.equal(status.branch, null);
  assert.match(status.head, /^[a-f0-9]{40,64}$/);
});

test('read-only mode refuses every mutation and permits inspection', async t => {
  const { call } = await fixture(t, { readOnly: true });
  for (const name of ['git_add', 'git_unstage', 'git_commit', 'git_create_branch', 'git_switch_branch']) {
    await assert.rejects(call(name), { code: 'READ_ONLY' });
  }
  assert.equal((await call('git_status')).clean, true);
});

test('rejects path escapes, metadata and option-like revisions', async t => {
  const { repo, call } = await fixture(t);
  for (const file of ['../outside', repo, '.', '.git/config', 'a\0b']) {
    await assert.rejects(call('git_add', { paths: [file] }), { code: 'INVALID_INPUT' });
  }
  for (const ref of ['--help', '--output=/tmp/git-companion-unsafe', 'HEAD\0oops']) {
    await assert.rejects(call('git_show', { ref }), { code: 'INVALID_INPUT' });
  }
  for (const name of ['--help', '@{-1}', 'bad\0branch']) {
    await assert.rejects(call('git_create_branch', { name }), { code: 'INVALID_INPUT' });
  }
});

test('root restrictions resolve symlinks and reject parent repository escapes', async t => {
  const { repo, service } = await fixture(t);
  const restricted = new GitService({ roots: [path.join(repo, 'allowed')] });
  t.after(() => restricted.close());
  await mkdir(path.join(repo, 'allowed'));
  await assert.rejects(restricted.execute('git_status', { repo_path: repo }), { code: 'OUTSIDE_ROOTS' });
  await assert.rejects(restricted.execute('git_status', { repo_path: path.join(repo, 'allowed') }), { code: 'OUTSIDE_ROOTS' });
  await symlink(repo, path.join(repo, 'allowed', 'escape'), 'dir');
  await assert.rejects(restricted.execute('git_status', { repo_path: path.join(repo, 'allowed', 'escape') }), { code: 'OUTSIDE_ROOTS' });
  service.roots = [repo];
  assert.equal((await service.execute('git_status', { repo_path: repo })).branch, 'main');
});

test('inherited Git environment cannot redirect operations', async t => {
  const { repo, call } = await fixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(repo, 'missing-git-dir');
  try { assert.equal((await call('git_status')).clean, true); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

test('commit hooks and external diff commands are not executed', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'config', 'core.hooksPath', path.join(repo, 'missing-hooks'));
  git(repo, 'config', 'diff.external', 'git-companion-command-that-does-not-exist');
  await writeFile(path.join(repo, 'hello.txt'), 'changed');
  assert.match((await call('git_diff')).diff, /changed/);
  await call('git_add', { paths: ['hello.txt'] });
  // A real failing hook must be bypassed by the isolated empty hooks directory.
  const hooks = path.join(repo, '.git', 'hooks');
  await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(hooks, 'pre-commit'), 0o755);
  git(repo, 'config', '--unset', 'core.hooksPath');
  const snapshot = await call('git_diff', { mode: 'staged' });
  await call('git_commit', { message: 'fix: checked separately', expected_index_fingerprint: snapshot.index_fingerprint });
  assert.equal((await call('git_status')).clean, true);
});

test('linked worktrees and subdirectory requests resolve the correct root', async t => {
  const { repo, call } = await fixture(t);
  await mkdir(path.join(repo, 'subdir'));
  assert.equal((await call('git_status', { repo_path: path.join(repo, 'subdir') })).repository, await import('node:fs/promises').then(fs => fs.realpath(repo)));
  const worktree = path.join(repo, 'linked');
  git(repo, 'worktree', 'add', '-b', 'linked-branch', worktree);
  const status = await call('git_status', { repo_path: worktree });
  assert.equal(status.branch, 'linked-branch');
});

test('output limit returns a useful error instead of an incomplete diff', async t => {
  const { repo } = await fixture(t);
  await assert.rejects(runGit(repo, ['show', 'HEAD'], { maxBytes: 16 }), { code: 'OUTPUT_LIMIT' });
});

test('a stalled Git subprocess is terminated at the timeout', { skip: process.platform === 'win32' }, async t => {
  const { repo } = await fixture(t);
  const bin = path.join(repo, 'fake-bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(path.join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try { await assert.rejects(runGit(repo, ['status'], { timeoutMs: 100 }), { code: 'TIMEOUT' }); }
  finally { process.env.PATH = previousPath; }
});

test('missing, relative and non-repository directories return explicit errors', async t => {
  const { call, repo } = await fixture(t);
  await assert.rejects(call('git_status', { repo_path: 'relative' }), { code: 'INVALID_INPUT' });
  await assert.rejects(call('git_status', { repo_path: path.join(repo, 'missing') }), { code: 'NOT_REPOSITORY' });
  await assert.rejects(call('git_status', { repo_path: '/private/tmp' }), { code: 'NOT_REPOSITORY' });
});
