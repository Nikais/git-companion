import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './errors.js';

const fail = message => { throw new GitError('INVALID_INPUT', message); };
const required = (args, key) => args[key] ?? fail(`${key} is required for this action.`);
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const output = response => ({ output: response.stdout, stderr: response.stderr });

// Resolve the nearest existing ancestor, including symlinks, before creating anything.
async function canonicalTarget(target) {
  if (!path.isAbsolute(target) || target.includes('\0')) fail('An absolute filesystem path is required.');
  if (target.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) fail('Git metadata paths are not accepted.');
  let ancestor = path.normalize(target);
  const suffix = [];
  for (;;) {
    try {
      const resolved = path.join(await realpath(ancestor), ...suffix);
      if (resolved.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) fail('Git metadata destinations are not accepted.');
      return resolved;
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink must not become a future destination escape.
      try { if ((await lstat(ancestor)).isSymbolicLink()) fail('Dangling symlink destinations are not accepted.'); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function destination(service, target) {
  const canonical = await canonicalTarget(target);
  if (service.roots.length) {
    const roots = await Promise.all(service.roots.map(root => realpath(root)));
    if (!roots.some(root => inside(root, canonical))) throw new GitError('OUTSIDE_ROOTS', 'Destination is outside GIT_MCP_ROOTS.');
  }
  return canonical;
}

function url(value) {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) fail('An explicit repository URL or absolute local path is required.');
  if (path.isAbsolute(value)) return value;
  if (/^(https?|ssh|git|file):\/\//i.test(value) || /^[\w.-]+@[^:\s]+:.+/.test(value)) return value;
  fail('Supported transports: HTTPS, SSH, git, file, or an absolute local path.');
}

async function branch(git, name) {
  if (!name || name.startsWith('-') || name.includes('@{') || name.includes('\0')) fail('A literal branch name is required.');
  await git(['check-ref-format', '--branch', name]);
  return name;
}

async function tag(git, name) {
  if (!name || name.startsWith('-') || name.includes('\0')) fail('A literal tag name is required.');
  await git(['check-ref-format', `refs/tags/${name}`]);
  return name;
}

function remoteName(name) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) fail('A literal remote name is required.');
  return name;
}

async function remote(git, name) {
  remoteName(name);
  if (!(await git(['remote'])).stdout.split('\n').includes(name)) fail(`Unknown configured remote: ${name}`);
  return name;
}

async function clean(git) {
  if ((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout) {
    throw new GitError('DIRTY_WORKTREE', 'This action requires a clean index and working tree. Preserve changes first.');
  }
}

async function expectedHead(service, git, expected, ref = 'HEAD') {
  if (!expected) fail('expected_head is required for this action.');
  if (await service.revision(git, ref) !== expected) throw new GitError('HEAD_CHANGED', 'The commit differs from the reviewed HEAD. Inspect the repository again.');
}

function discard(args) { if (!args.discard_changes) fail('This action requires discard_changes=true.'); }

async function stopped(git, command) {
  const response = await git(command, { allowed: [0, 1] });
  const conflicts = (await git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);
  return { ...output(response), state: response.code === 0 ? 'completed' : 'stopped', conflicts };
}

export async function setupRepository(service, name, args) {
  const target = await destination(service, args.repo_path);
  try { if ((await readdir(target)).length) fail('The destination must be new or empty.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const git = (command, options) => service.gitAt(path.dirname(target), command, options);
  // Validate before making directories, including Git's branch naming rules.
  if (name === 'git_clone') url(args.url);
  const ref = name === 'git_init' ? args.initial_branch : args.branch;
  if (ref) {
    if (ref.startsWith('-') || ref.includes('@{')) fail('A literal initial branch is required.');
    await service.gitAt(await realpath(process.cwd()), ['check-ref-format', '--branch', ref]);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const command = name === 'git_init' ? ['init', `--initial-branch=${args.initial_branch}`, '--', target] : ['clone', '--no-local', ...(args.branch ? ['--branch', args.branch] : []), ...(args.depth ? ['--depth', String(args.depth)] : []), '--', args.url, target];
  return { repository: target, ...output(await git(command, { timeoutMs: 120000 })) };
}

export async function executeExtended(service, name, args, { root, git, paths, result }) {
  const revision = ref => service.revision(git, ref);
  const selected = () => { if (!paths.length) fail('At least one explicit path is required.'); return paths; };
  const run = async (command, options) => ({ ...result, ...output(await git(command, options)) });
  switch (name) {
    case 'git_remote': {
      if (args.action === 'list') return run(['remote', '-v']);
      const name = remoteName(required(args, 'name'));
      if (args.action === 'add') return run(['remote', 'add', '--', name, url(required(args, 'url'))]);
      await remote(git, name);
      if (args.action === 'remove') return run(['remote', 'remove', name]);
      if (args.action === 'rename') return run(['remote', 'rename', name, remoteName(required(args, 'new_name'))]);
      return run(['remote', 'set-url', '--', name, url(required(args, 'url'))]);
    }
    case 'git_fetch': {
      await remote(git, args.remote);
      if (args.branch) await branch(git, args.branch);
      return run(['fetch', '--no-recurse-submodules', args.tags ? '--tags' : '--no-tags', args.prune ? '--prune' : '--no-prune', '--no-prune-tags', '--', args.remote, ...(args.branch ? [args.branch] : [])], { timeoutMs: 120000 });
    }
    case 'git_pull': {
      await clean(git);
      await remote(git, args.remote);
      await branch(git, args.branch);
      const fetched = await git(['fetch', '--no-recurse-submodules', '--no-tags', '--', args.remote, args.branch], { timeoutMs: 120000 });
      const head = await revision('FETCH_HEAD');
      const command = args.strategy === 'rebase' ? ['rebase', '--no-autostash', head] : ['merge', '--no-edit', '--no-gpg-sign', args.strategy === 'merge' ? '--ff' : '--ff-only', head];
      return { ...result, fetch: output(fetched), ...await stopped(git, command) };
    }
    case 'git_push': {
      await remote(git, args.remote);
      const target = args.target_type === 'tag' ? `refs/tags/${await tag(git, args.branch)}` : `refs/heads/${await branch(git, args.branch)}`;
      if ((args.force_with_lease || args.delete) && !args.expected_remote_oid) fail('expected_remote_oid is required for replacement or deletion.');
      if (args.expected_remote_oid && !args.force_with_lease && !args.delete) fail('Select force_with_lease explicitly when supplying expected_remote_oid.');
      if (args.delete && args.set_upstream) fail('Deletion cannot set an upstream.');
      if (args.target_type === 'tag' && args.set_upstream) fail('Tags cannot set an upstream.');
      let source = args.delete ? '' : await revision(args.source);
      if (!args.delete && args.target_type === 'tag') source = (await git(['rev-parse', '--verify', '--end-of-options', args.source])).stdout.trim();
      // Use the branch name for --set-upstream; a raw hash cannot establish tracking.
      let local = source;
      if (args.set_upstream) {
        const current = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
        if (await revision(current) !== source) fail('set_upstream requires the current local branch as source.');
        local = current;
      }
      const lease = args.expected_remote_oid ? [`--force-with-lease=${target}:${args.expected_remote_oid}`] : [];
      return run(['-c', 'push.followTags=false', 'push', '--porcelain', '--recurse-submodules=no', ...(args.dry_run ? ['--dry-run'] : []), ...(args.set_upstream ? ['--set-upstream'] : []), ...lease, '--', args.remote, `${local}:${target}`], { timeoutMs: 120000 });
    }
    case 'git_ls_remote': {
      await remote(git, args.remote);
      const response = await git(['ls-remote', '--refs', ...(args.kind === 'all' ? [] : [`--${args.kind}`]), '--', args.remote], { timeoutMs: 120000 });
      return { ...result, refs: response.stdout.trimEnd().split('\n').filter(Boolean).map(line => { const [oid, ref] = line.split('\t'); return { oid, ref }; }) };
    }
    case 'git_merge': {
      if (args.action !== 'start') return { ...result, ...await stopped(git, ['merge', `--${args.action}`]) };
      const ref = await revision(required(args, 'ref'));
      await clean(git);
      const flags = { ff_only: ['--ff-only'], merge: ['--ff'], no_ff: ['--no-ff'], squash: ['--squash'] };
      return { ...result, ...await stopped(git, ['merge', '--no-edit', '--no-gpg-sign', ...flags[args.strategy], ref]) };
    }
    case 'git_rebase': {
      if (args.action !== 'start') return { ...result, ...await stopped(git, ['rebase', `--${args.action}`]) };
      await expectedHead(service, git, args.expected_head);
      await clean(git);
      const upstream = await revision(required(args, 'upstream'));
      const onto = args.onto ? ['--onto', await revision(args.onto)] : [];
      return { ...result, ...await stopped(git, ['rebase', '--no-autostash', ...onto, upstream]) };
    }
    case 'git_cherry_pick':
    case 'git_revert': {
      const command = name === 'git_revert' ? 'revert' : 'cherry-pick';
      if (args.action !== 'start') return { ...result, ...await stopped(git, [command, `--${args.action}`]) };
      await clean(git);
      const commits = [];
      for (const commit of required(args, 'commits')) commits.push(await revision(commit));
      return { ...result, ...await stopped(git, [command, '--no-edit', '--no-gpg-sign', ...(args.mainline ? ['--mainline', String(args.mainline)] : []), ...commits]) };
    }
    case 'git_stash': {
      if (args.action === 'list') return run(['stash', 'list', '--max-count=100']);
      // Git 2.50's stash cleanup leaves untracked files behind with global
      // --literal-pathspecs. Encode each selected path literally instead.
      if (args.action === 'push') return run(['stash', 'push', ...(args.include_untracked ? ['--include-untracked'] : []), ...(args.message ? ['--message', args.message] : []), ...(paths.length ? ['--', ...paths.map(file => `:(literal)${file}`)] : [])], { literalPaths: false });
      if (args.action === 'clear') { discard(args); return run(['stash', 'clear']); }
      const hash = await revision(args.ref);
      if (args.action === 'show') return { ...await run(['stash', 'show', '--patch', '--no-ext-diff', '--no-textconv', args.ref]), stash: hash };
      if (['pop', 'drop'].includes(args.action) && args.expected_stash !== hash) throw new GitError('STASH_CHANGED', 'Read the selected stash and supply its hash as expected_stash before pop/drop.');
      return { ...result, stash: hash, ...await stopped(git, ['stash', args.action, ...(['apply', 'pop'].includes(args.action) && args.restore_index ? ['--index'] : []), args.ref]) };
    }
    case 'git_tag': {
      if (args.action === 'list') return run(['tag', '--list', '--format=%(refname:short)%09%(objectname)%09%(subject)']);
      const name = await tag(git, required(args, 'name'));
      if (args.action === 'delete') return run(['tag', '--delete', '--', name]);
      return run(['tag', '--no-sign', ...(args.message ? ['--annotate', '--message', args.message] : []), '--', name, await revision(args.ref)]);
    }
    case 'git_blame': {
      const file = service.paths(root, [args.path])[0];
      if (args.end_line && !args.start_line) fail('start_line is required with end_line.');
      if (args.end_line && args.end_line < args.start_line) fail('end_line must not precede start_line.');
      return run(['blame', '--line-porcelain', ...(args.start_line ? ['-L', `${args.start_line},${args.end_line ?? '$'}`] : []), await revision(args.ref), '--', file]);
    }
    case 'git_worktree': {
      if (args.action === 'list') return run(['worktree', 'list', '--porcelain']);
      if (args.action === 'prune') return run(['worktree', 'prune', '--verbose', ...(args.dry_run ? ['--dry-run'] : [])]);
      const target = await destination(service, required(args, 'path'));
      if (args.action === 'add') {
        if (args.branch && args.new_branch) fail('Choose branch or new_branch, not both.');
        const ref = args.branch ? await branch(git, args.branch) : await revision(args.ref);
        if (args.new_branch) await branch(git, args.new_branch);
        return run(['worktree', 'add', ...(args.new_branch ? ['-b', args.new_branch] : args.branch ? [] : ['--detach']), '--', target, ref]);
      }
      // Validate the selected worktree itself; this also enforces root restrictions.
      await service.repository(target);
      if (args.action === 'move') return run(['worktree', 'move', '--', target, await destination(service, required(args, 'destination'))]);
      return run(['worktree', args.action, ...(args.action === 'lock' && args.reason ? ['--reason', args.reason] : []), '--', target]);
    }
    case 'git_submodule': {
      const command = ['-c', 'submodule.recurse=false', ...(args.allow_file ? ['-c', 'protocol.file.allow=always'] : []), 'submodule', args.action];
      if (args.action === 'add') {
        const target = service.paths(root, [required(args, 'path')])[0];
        const resolved = await canonicalTarget(path.join(root, target));
        if (!inside(root, resolved)) fail('Submodule destination escapes the repository.');
        command.push('--', url(required(args, 'url')), target);
      } else {
        if (args.action !== 'status') selected();
        for (const file of paths) {
          if (!inside(root, await canonicalTarget(path.join(root, file)))) fail('Submodule path escapes the repository.');
        }
        if (args.action === 'update') command.push('--init', '--checkout');
        if (args.recursive && ['status', 'update', 'sync'].includes(args.action)) command.push('--recursive');
        command.push('--', ...paths);
      }
      return run(command, { timeoutMs: 120000 });
    }
    case 'git_reset': {
      await expectedHead(service, git, args.expected_head);
      if (args.mode === 'hard') discard(args);
      return run(['reset', `--${args.mode}`, await revision(args.ref), '--']);
    }
    case 'git_clean': {
      const flags = [...(args.directories ? ['-d'] : []), ...(args.include_ignored ? ['-x'] : [])];
      const preview = (await git(['clean', '--dry-run', ...flags, '--', ...selected()])).stdout;
      const fingerprint = createHash('sha256').update(JSON.stringify([root, paths, flags, preview])).digest('hex');
      if (args.dry_run) return { ...result, preview, preview_fingerprint: fingerprint };
      discard(args);
      if (args.expected_preview !== fingerprint) throw new GitError('PREVIEW_CHANGED', 'Run git_clean in dry-run mode and review its current preview first.');
      return run(['clean', '--force', ...flags, '--', ...paths]);
    }
    case 'git_amend': {
      await expectedHead(service, git, args.expected_head);
      if (await service.fingerprint(git) !== args.expected_index_fingerprint) throw new GitError('INDEX_CHANGED', 'Read and review the complete staged diff before amending.');
      const response = await git(['commit', '--amend', '--no-gpg-sign', ...(args.message ? ['--cleanup=verbatim', '--message', args.message] : ['--no-edit'])]);
      return { ...result, commit: await revision('HEAD'), ...output(response) };
    }
    case 'git_delete_branch': {
      const name = await branch(git, args.name);
      if (args.force) await expectedHead(service, git, args.expected_head, `refs/heads/${name}`);
      return run(['branch', args.force ? '-D' : '-d', '--', name]);
    }
    case 'git_rename_branch':
      return run(['branch', '-m', '--', await branch(git, args.name), await branch(git, args.new_name)]);
    case 'git_restore': {
      if (!args.staged && !args.worktree) fail('Select staged, worktree or both.');
      if (args.worktree) discard(args);
      return run(['restore', ...(args.source ? ['--source', await revision(args.source)] : []), ...(args.staged ? ['--staged'] : []), ...(args.worktree ? ['--worktree'] : []), '--', ...selected()]);
    }
    case 'git_rm':
      return run(['rm', ...(args.cached ? ['--cached'] : []), ...(args.recursive ? ['-r'] : []), '--', ...selected()]);
    case 'git_mv': {
      const [source, target] = service.paths(root, [args.source, args.destination]);
      for (const file of [source, target]) if (!inside(root, await canonicalTarget(path.join(root, file)))) fail('Move path escapes the repository.');
      return run(['mv', '--', source, target]);
    }
    case 'git_checkout': {
      const ref = args.detach ? await revision(args.ref) : await branch(git, args.ref);
      if (args.force) { discard(args); await expectedHead(service, git, args.expected_head); }
      else await clean(git);
      return run(['switch', ...(args.detach ? ['--detach'] : ['--no-guess']), ...(args.force ? ['--discard-changes'] : []), ref]);
    }
    case 'git_reflog': {
      if (args.ref.startsWith('-')) fail('Invalid reflog ref.');
      await revision(args.ref);
      return run(['reflog', 'show', `--max-count=${args.limit}`, '--format=%H %gd %gs', args.ref, '--']);
    }
    case 'git_ls_files': {
      const response = await git(['ls-files', '--cached', ...(args.untracked ? ['--others', '--exclude-standard'] : []), '-z', '--', ...paths]);
      return { ...result, files: response.stdout.split('\0').filter(Boolean) };
    }
    case 'git_grep':
      return run(['grep', '-n', ...(args.regex ? ['-E'] : ['-F']), ...(args.ignore_case ? ['-i'] : []), '-e', args.pattern, ...(args.ref ? [await revision(args.ref)] : []), '--', ...paths], { allowed: [0, 1] });
    case 'git_describe':
      return run(['describe', '--always', ...(args.tags ? ['--tags'] : []), await revision(args.ref)]);
    case 'git_merge_base':
      return run(['merge-base', '--all', await revision(args.base), await revision(args.head)], { allowed: [0, 1] });
    case 'git_config': {
      if (args.action === 'list') return run(['config', '--local', '--no-includes', '--list']);
      const key = required(args, 'key');
      if (!/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9_-]+)+$/.test(key)) fail('A literal config key is required.');
      if (args.action === 'get') return run(['config', '--local', '--no-includes', '--get-all', '--', key], { allowed: [0, 1] });
      if (!/^(user\.(name|email)|core\.(autocrlf|eol|ignorecase|filemode|logallrefupdates)|pull\.(ff|rebase)|push\.default|fetch\.prune|merge\.ff)$/i.test(key)) fail('This config key cannot be written by this tool. Use dedicated remote/branch tools or the host workflow.');
      return run(['config', '--local', '--no-includes', args.action === 'set' ? '--replace-all' : '--unset-all', '--', key, ...(args.action === 'set' ? [required(args, 'value')] : [])]);
    }
    case 'git_apply':
      return run(['apply', ...(args.check ? ['--check'] : []), ...(args.cached ? ['--cached'] : []), ...(args.reverse ? ['--reverse'] : []), '-'], { input: args.patch });
    case 'git_bisect': {
      if (args.action === 'log') return run(['bisect', 'log']);
      await clean(git);
      if (args.action === 'start') return run(['bisect', 'start', await revision(required(args, 'bad')), await revision(required(args, 'good')), '--']);
      return run(['bisect', args.action, ...(args.ref ? [await revision(args.ref)] : [])]);
    }
    case 'git_notes': {
      if (args.action === 'list') return run(['notes', 'list']);
      return run(['notes', args.action, ...(args.action === 'add' ? ['--message', required(args, 'message')] : []), await revision(args.ref)]);
    }
    default: throw new GitError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  }
}
