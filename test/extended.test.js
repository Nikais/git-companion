import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService } from '../src/git.js';
import { tools } from '../src/tools.js';
import { fixture, git } from './helpers.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'git-companion-extended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function commit(repo, name, content, message = name) {
  await writeFile(path.join(repo, name), content);
  git(repo, 'add', '--', name);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

test('init and clone create usable repositories, refuse nonempty targets and enforce roots before writing', async t => {
  const { repo: source, service } = await fixture(t);
  const root = await temporary(t);
  service.roots = [root];
  const target = path.join(root, 'new', 'repo');
  await service.execute('git_init', { repo_path: target, initial_branch: 'trunk' });
  assert.equal((await service.execute('git_status', { repo_path: target })).branch, 'trunk');
  await assert.rejects(service.execute('git_init', { repo_path: target }), { code: 'INVALID_INPUT' });
  const clone = path.join(root, 'clone');
  await service.execute('git_clone', { repo_path: clone, url: source });
  assert.equal(await readFile(path.join(clone, 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal((await service.execute('git_log', { repo_path: clone })).commits.length, 1);
  await assert.rejects(service.execute('git_clone', { repo_path: path.join(source, 'forbidden'), url: source }), { code: 'OUTSIDE_ROOTS' });
  await symlink(source, path.join(root, 'escape'), 'dir');
  await assert.rejects(service.execute('git_init', { repo_path: path.join(root, 'escape', 'new') }), { code: 'OUTSIDE_ROOTS' });
  await assert.rejects(service.execute('git_clone', { repo_path: path.join(root, 'bad'), url: 'ext::touch /tmp/never' }), { code: 'INVALID_INPUT' });
  assert.ok(!(await readdir(root)).includes('bad'));
});

test('remote lifecycle, explicit push/fetch/pull and lease-protected replacement/deletion use local transports', async t => {
  const { repo, call } = await fixture(t);
  const root = await temporary(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--bare', bare);
  await call('git_remote', { action: 'add', name: 'origin', url: bare });
  assert.match((await call('git_remote')).output, /origin/);
  await call('git_remote', { action: 'rename', name: 'origin', new_name: 'upstream' });
  await call('git_remote', { action: 'set_url', name: 'upstream', url: bare });
  const initial = (await call('git_status')).head;
  await call('git_push', { remote: 'upstream', branch: 'main', set_upstream: true });
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'upstream/main');
  const clone = path.join(root, 'clone');
  const service = new GitService();
  t.after(() => service.close());
  await service.execute('git_clone', { repo_path: clone, url: bare, branch: 'main' });
  const invoke = (name, args = {}) => service.execute(name, { repo_path: clone, ...args });
  const advanced = await commit(repo, 'next.txt', 'next');
  await call('git_push', { remote: 'upstream', branch: 'main' });
  await invoke('git_fetch', { remote: 'origin', branch: 'main' });
  assert.equal((await invoke('git_status')).head, initial);
  await invoke('git_pull', { remote: 'origin', branch: 'main' });
  assert.equal((await invoke('git_status')).head, advanced);
  await assert.rejects(call('git_push', { remote: 'upstream', branch: 'main', source: initial }), { code: 'GIT_ERROR' });
  await assert.rejects(call('git_push', { remote: 'upstream', branch: 'main', source: initial, force_with_lease: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(call('git_push', { remote: 'upstream', branch: 'main', source: initial, force_with_lease: true, expected_remote_oid: initial }), { code: 'GIT_ERROR' });
  await call('git_push', { remote: 'upstream', branch: 'main', source: initial, force_with_lease: true, expected_remote_oid: advanced });
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main').trim(), initial);
  await call('git_push', { remote: 'upstream', branch: 'disposable' });
  await call('git_push', { remote: 'upstream', branch: 'disposable', delete: true, expected_remote_oid: advanced });
  assert.doesNotMatch(git(bare, 'branch', '--list'), /disposable/);
  await call('git_tag', { action: 'create', name: 'v1', message: 'annotated release' });
  await call('git_push', { remote: 'upstream', branch: 'v1', target_type: 'tag', source: 'refs/tags/v1' });
  const remoteTag = (await call('git_ls_remote', { remote: 'upstream', kind: 'tags' })).refs.find(ref => ref.ref === 'refs/tags/v1');
  assert.equal(remoteTag.oid, git(repo, 'rev-parse', 'refs/tags/v1').trim());
  assert.equal(git(bare, 'cat-file', '-t', remoteTag.oid).trim(), 'tag');
  await call('git_push', { remote: 'upstream', branch: 'v1', target_type: 'tag', delete: true, expected_remote_oid: remoteTag.oid });
  await call('git_remote', { action: 'remove', name: 'upstream' });
  assert.equal((await call('git_remote')).output, '');
});

test('merge reports conflicts, can abort, and continues after explicit conflict resolution', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'switch', '-c', 'feature');
  await commit(repo, 'hello.txt', 'feature\n');
  git(repo, 'switch', 'main');
  const main = await commit(repo, 'hello.txt', 'main\n');
  await assert.rejects(call('git_merge', { ref: 'feature' }), { code: 'GIT_ERROR' });
  let merge = await call('git_merge', { ref: 'feature', strategy: 'merge' });
  assert.equal(merge.state, 'stopped');
  assert.deepEqual(merge.conflicts, ['hello.txt']);
  await call('git_merge', { action: 'abort' });
  assert.equal((await call('git_status')).head, main);
  merge = await call('git_merge', { ref: 'feature', strategy: 'merge' });
  assert.equal(merge.state, 'stopped');
  await writeFile(path.join(repo, 'hello.txt'), 'resolved\n');
  await call('git_add', { paths: ['hello.txt'] });
  assert.equal((await call('git_merge', { action: 'continue' })).state, 'completed');
  assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
});

test('rebase requires the reviewed HEAD, reports conflicts and supports abort/continue', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'branch', 'feature');
  await commit(repo, 'hello.txt', 'main\n');
  git(repo, 'switch', 'feature');
  const head = await commit(repo, 'hello.txt', 'feature\n');
  await assert.rejects(call('git_rebase', { upstream: 'main', expected_head: '0'.repeat(40) }), { code: 'HEAD_CHANGED' });
  assert.equal((await call('git_rebase', { upstream: 'main', expected_head: head })).state, 'stopped');
  await call('git_rebase', { action: 'abort' });
  assert.equal((await call('git_status')).head, head);
  await call('git_rebase', { upstream: 'main', expected_head: head });
  await writeFile(path.join(repo, 'hello.txt'), 'resolved\n');
  await call('git_add', { paths: ['hello.txt'] });
  assert.equal((await call('git_rebase', { action: 'continue' })).state, 'completed');
  assert.equal((await call('git_status')).branch, 'feature');
});

test('cherry-pick and revert apply/invert selected commits and refuse dirty starts', async t => {
  const { repo, call } = await fixture(t);
  git(repo, 'switch', '-c', 'feature');
  const selected = await commit(repo, 'selected.txt', 'selected');
  git(repo, 'switch', 'main');
  assert.equal((await call('git_cherry_pick', { commits: [selected] })).state, 'completed');
  assert.equal(await readFile(path.join(repo, 'selected.txt'), 'utf8'), 'selected');
  assert.equal((await call('git_revert', { commits: ['HEAD'] })).state, 'completed');
  await assert.rejects(readFile(path.join(repo, 'selected.txt')), { code: 'ENOENT' });
  await writeFile(path.join(repo, 'dirty'), 'preserve');
  await assert.rejects(call('git_cherry_pick', { commits: [selected] }), { code: 'DIRTY_WORKTREE' });
});

test('stash shows the reviewed hash and protects pop/drop against changed entries', async t => {
  const { repo, call } = await fixture(t);
  await writeFile(path.join(repo, 'hello.txt'), 'saved\n');
  await writeFile(path.join(repo, 'untracked'), 'untracked');
  await call('git_stash', { action: 'push', message: 'save task', include_untracked: true });
  assert.equal((await call('git_status')).clean, true);
  assert.match((await call('git_stash')).output, /save task/);
  const saved = await call('git_stash', { action: 'show' });
  assert.match(saved.output, /saved/);
  await assert.rejects(call('git_stash', { action: 'pop', expected_stash: '0'.repeat(40) }), { code: 'STASH_CHANGED' });
  await call('git_stash', { action: 'apply' });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'saved\n');
  await call('git_stash', { action: 'drop', expected_stash: saved.stash });
  assert.equal((await call('git_stash')).output, '');
  await assert.rejects(call('git_stash', { action: 'clear' }), { code: 'INVALID_INPUT' });
});

test('selected stash paths remain literal even during untracked cleanup', async t => {
  const { repo, call } = await fixture(t);
  await writeFile(path.join(repo, '*.txt'), 'literal');
  await writeFile(path.join(repo, 'other.txt'), 'keep');
  await call('git_stash', { action: 'push', include_untracked: true, paths: ['*.txt'] });
  await assert.rejects(readFile(path.join(repo, '*.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(repo, 'other.txt'), 'utf8'), 'keep');
  const saved = await call('git_stash', { action: 'show' });
  await call('git_stash', { action: 'pop', expected_stash: saved.stash });
  assert.equal(await readFile(path.join(repo, '*.txt'), 'utf8'), 'literal');
  assert.equal((await call('git_stash')).output, '');
});

test('tags, notes, blame, grep, files, describe, reflog and merge-base return real repository data', async t => {
  const { call } = await fixture(t);
  const head = (await call('git_status')).head;
  await call('git_tag', { action: 'create', name: 'v1', message: 'first release' });
  await call('git_tag', { action: 'create', name: 'lightweight' });
  await assert.rejects(call('git_tag', { action: 'create', name: 'v1' }), { code: 'GIT_ERROR' });
  assert.match((await call('git_tag')).output, /v1/);
  assert.match((await call('git_describe')).output, /v1|lightweight/);
  assert.match((await call('git_blame', { path: 'hello.txt', start_line: 1, end_line: 1 })).output, /author Git Companion Test/);
  assert.match((await call('git_grep', { pattern: 'hello' })).output, /hello.txt:1:hello/);
  assert.equal((await call('git_grep', { pattern: 'absent' })).output, '');
  assert.deepEqual((await call('git_ls_files')).files, ['hello.txt']);
  assert.match((await call('git_reflog')).output, /initial/);
  assert.equal((await call('git_merge_base', { base: 'HEAD' })).output.trim(), head);
  await call('git_notes', { action: 'add', message: 'reviewed' });
  assert.match((await call('git_notes', { action: 'show' })).output, /reviewed/);
  assert.match((await call('git_notes')).output, new RegExp(head));
  await call('git_notes', { action: 'remove' });
  await call('git_tag', { action: 'delete', name: 'v1' });
  assert.doesNotMatch((await call('git_tag')).output, /v1/);
});

test('worktree lifecycle respects destination roots and refuses dirty removal', async t => {
  const { repo, call, service } = await fixture(t);
  const root = await temporary(t);
  service.roots = [repo, root];
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await call('git_worktree', { action: 'add', path: first, new_branch: 'linked' });
  assert.equal((await call('git_status', { repo_path: first })).branch, 'linked');
  await call('git_worktree', { action: 'lock', path: first, reason: 'review' });
  assert.match((await call('git_worktree')).output, /locked review/);
  await call('git_worktree', { action: 'unlock', path: first });
  await call('git_worktree', { action: 'move', path: first, destination: second });
  await writeFile(path.join(second, 'dirty'), 'preserve');
  await assert.rejects(call('git_worktree', { action: 'remove', path: second }), { code: 'GIT_ERROR' });
  await rm(path.join(second, 'dirty'));
  await call('git_worktree', { action: 'remove', path: second });
  await call('git_worktree', { action: 'prune' });
  assert.doesNotMatch((await call('git_worktree')).output, /linked/);
  await assert.rejects(call('git_worktree', { action: 'add', path: '/private/outside-git-companion-test' }), { code: 'OUTSIDE_ROOTS' });
});

test('submodules add/update/deinit/init/sync use explicit paths and local transport opt-in', async t => {
  const { repo: source } = await fixture(t);
  const { repo, call } = await fixture(t);
  await assert.rejects(call('git_submodule', { action: 'add', url: source, path: 'deps/lib' }), { code: 'GIT_ERROR' });
  await call('git_submodule', { action: 'add', url: source, path: 'deps/lib', allow_file: true });
  assert.match((await call('git_submodule')).output, /deps\/lib/);
  git(repo, 'commit', '-m', 'add submodule');
  await call('git_submodule', { action: 'sync', paths: ['deps/lib'] });
  await call('git_submodule', { action: 'deinit', paths: ['deps/lib'] });
  await call('git_submodule', { action: 'init', paths: ['deps/lib'] });
  await call('git_submodule', { action: 'update', paths: ['deps/lib'], allow_file: true });
  assert.equal(await readFile(path.join(repo, 'deps/lib/hello.txt'), 'utf8'), 'hello\n');
  await assert.rejects(call('git_submodule', { action: 'update' }), { code: 'INVALID_INPUT' });
});

test('amend and reset verify HEAD/index and hard reset requires explicit discard', async t => {
  const { repo, call } = await fixture(t);
  const original = (await call('git_status')).head;
  await writeFile(path.join(repo, 'hello.txt'), 'amended\n');
  await call('git_add', { paths: ['hello.txt'] });
  const snapshot = await call('git_diff', { mode: 'staged' });
  await assert.rejects(call('git_amend', { expected_head: original, expected_index_fingerprint: '0'.repeat(64) }), { code: 'INDEX_CHANGED' });
  const amended = await call('git_amend', { expected_head: original, expected_index_fingerprint: snapshot.index_fingerprint, message: 'feat: amended' });
  assert.notEqual(amended.commit, original);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');
  const advanced = await commit(repo, 'next', 'next');
  await assert.rejects(call('git_reset', { ref: amended.commit, mode: 'hard', expected_head: advanced }), { code: 'INVALID_INPUT' });
  await call('git_reset', { ref: amended.commit, mode: 'soft', expected_head: advanced });
  assert.equal((await call('git_status')).files[0].status, 'A ');
  await call('git_reset', { mode: 'mixed', expected_head: amended.commit });
  assert.equal((await call('git_status')).files[0].status, '??');
  await writeFile(path.join(repo, 'hello.txt'), 'discard');
  await call('git_reset', { mode: 'hard', expected_head: amended.commit, discard_changes: true });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'amended\n');
});

test('clean requires a current preview and only deletes selected untracked paths', async t => {
  const { repo, call } = await fixture(t);
  await writeFile(path.join(repo, 'delete'), 'delete');
  await writeFile(path.join(repo, 'keep'), 'keep');
  let preview = await call('git_clean', { paths: ['delete'] });
  assert.match(preview.preview, /delete/);
  assert.equal(await readFile(path.join(repo, 'delete'), 'utf8'), 'delete');
  await assert.rejects(call('git_clean', { paths: ['delete'], dry_run: false, discard_changes: true, expected_preview: 'stale' }), { code: 'PREVIEW_CHANGED' });
  await call('git_clean', { paths: ['delete'], dry_run: false, discard_changes: true, expected_preview: preview.preview_fingerprint });
  await assert.rejects(readFile(path.join(repo, 'delete')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(repo, 'keep'), 'utf8'), 'keep');
  await mkdir(path.join(repo, 'folder'));
  await writeFile(path.join(repo, 'folder/a'), 'a');
  preview = await call('git_clean', { paths: ['folder'], directories: true });
  await writeFile(path.join(repo, 'folder/b'), 'b');
  // The preview names a whole directory; discard_changes explicitly authorizes its contents.
  await call('git_clean', { paths: ['folder'], directories: true, dry_run: false, discard_changes: true, expected_preview: preview.preview_fingerprint });
});

test('rename/delete branches, detach/force checkout, restore, mv and rm preserve unrelated data', async t => {
  const { repo, call } = await fixture(t);
  const head = (await call('git_status')).head;
  await call('git_create_branch', { name: 'old' });
  await call('git_rename_branch', { name: 'old', new_name: 'renamed' });
  await call('git_checkout', { ref: 'renamed' });
  await call('git_checkout', { ref: head, detach: true });
  assert.equal((await call('git_status')).branch, null);
  await writeFile(path.join(repo, 'hello.txt'), 'dirty');
  await assert.rejects(call('git_checkout', { ref: 'main' }), { code: 'DIRTY_WORKTREE' });
  await call('git_checkout', { ref: 'main', force: true, discard_changes: true, expected_head: head });
  await call('git_delete_branch', { name: 'renamed' });
  await writeFile(path.join(repo, 'hello.txt'), 'restore');
  await assert.rejects(call('git_restore', { paths: ['hello.txt'] }), { code: 'INVALID_INPUT' });
  await call('git_restore', { paths: ['hello.txt'], discard_changes: true });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'hello\n');
  await call('git_mv', { source: 'hello.txt', destination: 'renamed.txt' });
  await call('git_rm', { paths: ['renamed.txt'], cached: true });
  assert.equal(await readFile(path.join(repo, 'renamed.txt'), 'utf8'), 'hello\n');
});

test('config writes are local and limited to data keys; patch checking never applies the patch', async t => {
  const { repo, call } = await fixture(t);
  assert.match((await call('git_config')).output, /user.name=/);
  await call('git_config', { action: 'set', key: 'user.name', value: 'Updated Author' });
  assert.equal((await call('git_config', { action: 'get', key: 'user.name' })).output.trim(), 'Updated Author');
  await call('git_config', { action: 'set', key: 'fetch.prune', value: 'true' });
  await call('git_config', { action: 'unset', key: 'fetch.prune' });
  for (const key of ['core.sshCommand', 'core.hooksPath', 'alias.run', 'include.path', 'filter.evil.clean']) {
    await assert.rejects(call('git_config', { action: 'set', key, value: 'unsafe' }), { code: 'INVALID_INPUT' });
  }
  const patch = 'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+patched\n';
  await call('git_apply', { patch });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'hello\n');
  await call('git_apply', { patch, check: false });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'patched\n');
  await call('git_apply', { patch, check: false, reverse: true });
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'hello\n');
  await assert.rejects(call('git_apply', { patch: patch.replaceAll('hello.txt', '../escape'), check: false }), { code: 'GIT_ERROR' });
});

test('manual bisect locates a bad commit and restores the starting branch', async t => {
  const { repo, call } = await fixture(t);
  const good = (await call('git_status')).head;
  const middle = await commit(repo, 'hello.txt', 'middle\n');
  const bad = await commit(repo, 'hello.txt', 'bad\n');
  await call('git_bisect', { action: 'start', good, bad });
  assert.equal((await call('git_status')).head, middle);
  assert.match((await call('git_bisect', { action: 'log' })).output, /git bisect start/);
  assert.match((await call('git_bisect', { action: 'good' })).output, /first bad commit/);
  await call('git_bisect', { action: 'reset' });
  assert.equal((await call('git_status')).branch, 'main');
});

test('read-only mode covers every new mutation including setup and multi-action defaults', async t => {
  const { call } = await fixture(t, { readOnly: true });
  const actions = { git_remote: 'add', git_stash: 'push', git_tag: 'create', git_worktree: 'add', git_submodule: 'update', git_config: 'set', git_bisect: 'start', git_notes: 'add' };
  for (const tool of tools.filter(tool => !tool.annotations.readOnlyHint)) {
    const args = { ...(actions[tool.name] ? { action: actions[tool.name] } : {}), ...(tool.name === 'git_clean' ? { dry_run: false } : {}), ...(tool.name === 'git_apply' ? { check: false } : {}) };
    await assert.rejects(call(tool.name, args), { code: 'READ_ONLY' }, tool.name);
  }
  for (const tool of ['git_remote', 'git_stash', 'git_tag', 'git_worktree', 'git_submodule', 'git_config', 'git_notes']) await call(tool);
  await call('git_clean', { paths: ['missing'] });
});

test('new commands reject option injection, unknown parameters, metadata aliases and symlink move escapes', async t => {
  const { repo, call } = await fixture(t);
  const outside = await temporary(t);
  await symlink(outside, path.join(repo, 'escape'), 'dir');
  await assert.rejects(call('git_mv', { source: 'hello.txt', destination: 'escape/outside' }), { code: 'INVALID_INPUT' });
  await symlink(path.join(repo, '.git'), path.join(repo, 'metadata'), 'dir');
  await assert.rejects(call('git_mv', { source: 'hello.txt', destination: 'metadata/config' }), { code: 'INVALID_INPUT' });
  for (const [tool, args] of [
    ['git_merge', { ref: '--help' }], ['git_blame', { path: '../escape' }],
    ['git_remote', { action: 'add', name: '--help', url: outside }],
    ['git_tag', { action: 'create', name: '--help' }], ['git_checkout', { ref: '@{-1}' }],
    ['git_fetch', { remote: 'ext::command' }], ['git_stash', { action: 'show', ref: '--help' }],
    ['git_status', { arbitrary_option: '--work-tree=/tmp' }],
  ]) await assert.rejects(call(tool, args), { code: 'INVALID_INPUT' }, tool);
  assert.equal(await readFile(path.join(repo, 'hello.txt'), 'utf8'), 'hello\n');
  assert.deepEqual(await readdir(outside), []);
});
