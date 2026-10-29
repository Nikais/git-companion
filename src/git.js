import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class GitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Git subprocesses never use a shell. Output and execution time are bounded. */
export async function runGit(cwd, args, { hooksPath, timeoutMs = 15_000, maxBytes = 512_000, allowed = [0] } = {}) {
  const env = { ...process.env };
  // A caller's GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* must not redirect this request.
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  const flags = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false'];
  if (hooksPath) flags.push('-c', `core.hooksPath=${hooksPath}`);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...flags, ...args], { cwd, env, shell: false, windowsHide: true });
    child.stdin.end();
    const stdout = [], stderr = [];
    let bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new GitError('TIMEOUT', 'Git timed out; inspect repository locks and retry after resolving the cause.');
      child.kill('SIGKILL');
    }, timeoutMs);
    const capture = chunks => chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure ??= new GitError('OUTPUT_LIMIT', 'Git output exceeded 512 KB. Narrow the paths, revision range or history limit.');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', error => {
      clearTimeout(timer);
      reject(new GitError('GIT_UNAVAILABLE', `Cannot start Git: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code };
      if (!allowed.includes(code)) return reject(new GitError('GIT_ERROR', result.stderr.trim() || `Git exited with code ${code}.`));
      resolve(result);
    });
  });
}

export function parseStatus(output) {
  const records = output.split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const status = records[i].slice(0, 2);
    const file = { path: records[i].slice(3), status };
    if (/[RC]/.test(status)) file.original_path = records[++i];
    files.push(file);
  }
  return files;
}

export class GitService {
  constructor({ roots = [], readOnly = false } = {}) {
    this.roots = roots;
    this.readOnly = readOnly;
    this.queue = Promise.resolve();
    this.hooksPath = mkdtemp(path.join(tmpdir(), 'git-mcp-hooks-'));
  }

  async close() { await rm(await this.hooksPath, { recursive: true, force: true }); }

  async repository(directory) {
    if (!path.isAbsolute(directory)) throw new GitError('INVALID_INPUT', 'repo_path must be an absolute path.');
    let canonical;
    try { canonical = await realpath(directory); }
    catch { throw new GitError('NOT_REPOSITORY', 'repo_path does not exist or is inaccessible.'); }
    if (this.roots.length) {
      const roots = await Promise.all(this.roots.map(root => realpath(root)));
      if (!roots.some(root => inside(root, canonical))) throw new GitError('OUTSIDE_ROOTS', 'Repository is outside GIT_MCP_ROOTS.');
    }
    const git = async (args, options) => runGit(canonical, args, { hooksPath: await this.hooksPath, ...options });
    const check = await git(['rev-parse', '--is-inside-work-tree'], { allowed: [0, 128] });
    if (check.code !== 0 || check.stdout.trim() !== 'true') throw new GitError('NOT_REPOSITORY', 'repo_path must be inside a non-bare Git working tree.');
    const root = (await git(['rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/, '');
    // Paths are always relative to the repository root, even for a subdirectory request.
    const canonicalRoot = await realpath(root);
    if (this.roots.length) {
      const roots = await Promise.all(this.roots.map(rootPath => realpath(rootPath)));
      if (!roots.some(allowed => inside(allowed, canonicalRoot))) throw new GitError('OUTSIDE_ROOTS', 'Repository root is outside GIT_MCP_ROOTS.');
    }
    return { root: canonicalRoot, git: async (args, options) => runGit(canonicalRoot, args, { hooksPath: await this.hooksPath, ...options }) };
  }

  paths(root, paths = []) {
    return paths.map(file => {
      if (!file || file.includes('\0') || path.isAbsolute(file) || !inside(root, path.resolve(root, file)) || path.resolve(root, file) === root) {
        throw new GitError('INVALID_INPUT', 'Each path must name a file or directory inside the repository; root-wide pathspecs are not accepted.');
      }
      if (file.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new GitError('INVALID_INPUT', 'Git metadata paths are not accepted.');
      return file;
    });
  }

  async revision(git, ref) {
    if (!ref || ref.startsWith('-') || ref.includes('\0')) throw new GitError('INVALID_INPUT', 'Invalid revision.');
    return (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.trim();
  }

  async fingerprint(git) {
    return createHash('sha256').update((await git(['ls-files', '--stage', '-z'])).stdout).digest('hex');
  }

  execute(name, args) {
    // Keep this server's concurrent mutations from racing with its own reads.
    const pending = this.queue.then(() => this.perform(name, args));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async perform(name, args) {
    const writes = ['git_add', 'git_unstage', 'git_commit', 'git_create_branch', 'git_switch_branch'];
    if (this.readOnly && writes.includes(name)) throw new GitError('READ_ONLY', 'Mutations are disabled by GIT_MCP_READ_ONLY.');
    const { root, git } = await this.repository(args.repo_path);
    const paths = this.paths(root, args.paths);
    const result = { repository: root };
    switch (name) {
      case 'git_status': {
        const files = parseStatus((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
        const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowed: [0, 1] });
        const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowed: [0, 1] });
        return { ...result, branch: branch.stdout.trim() || null, head: head.stdout.trim() || null, clean: files.length === 0, files, index_fingerprint: await this.fingerprint(git) };
      }
      case 'git_diff': {
        const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `--unified=${args.context ?? 3}`];
        const mode = args.mode ?? 'working';
        if (mode === 'staged') diffArgs.push('--cached');
        if (mode === 'range') {
          if (!args.base) throw new GitError('INVALID_INPUT', 'base is required for a range diff.');
          const base = await this.revision(git, args.base), head = await this.revision(git, args.head ?? 'HEAD');
          diffArgs.push(args.merge_base === false ? base : `${base}...${head}`);
          if (args.merge_base === false) diffArgs.push(head);
        }
        const output = (await git([...diffArgs, '--', ...paths])).stdout;
        return { ...result, mode, diff: output, ...(mode === 'staged' ? { index_fingerprint: await this.fingerprint(git) } : {}) };
      }
      case 'git_log': {
        const ref = await this.revision(git, args.ref ?? 'HEAD');
        const output = (await git(['log', '-z', `--max-count=${args.limit ?? 20}`, '--format=%H%x00%an%x00%aI%x00%s%x00%b', ref, '--', ...paths])).stdout;
        const fields = output.split('\0');
        const commits = [];
        for (let i = 0; i + 4 < fields.length; i += 5) commits.push({ hash: fields[i], author: fields[i + 1], date: fields[i + 2], subject: fields[i + 3], body: fields[i + 4].trimEnd() });
        return { ...result, commits };
      }
      case 'git_show': {
        const ref = await this.revision(git, args.ref ?? 'HEAD');
        return { ...result, commit: ref, output: (await git(['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-textconv', '--no-color', ref, '--', ...paths])).stdout };
      }
      case 'git_branches': {
        const output = (await git(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', ...(args.include_remote ? ['refs/remotes'] : [])])).stdout;
        return { ...result, branches: output.trimEnd().split('\n').filter(Boolean).map(line => {
          const [name, commit, current, upstream] = line.split('\0');
          return { name, commit, current: current === '*', upstream: upstream || null };
        }) };
      }
      case 'git_add':
      case 'git_unstage': {
        if (!paths.length) throw new GitError('INVALID_INPUT', 'At least one explicit path is required.');
        if (name === 'git_add') await git(['add', '--', ...paths]);
        else {
          const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowed: [0, 1] });
          await git(head.code === 0 ? ['restore', '--staged', '--', ...paths] : ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...paths]);
        }
        return { ...result, paths, index_fingerprint: await this.fingerprint(git) };
      }
      case 'git_commit': {
        if (await this.fingerprint(git) !== args.expected_index_fingerprint) throw new GitError('INDEX_CHANGED', 'The index differs from the reviewed snapshot. Read the staged diff again before committing.');
        const staged = await git(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', '--exit-code'], { allowed: [0, 1] });
        if (staged.code === 0) throw new GitError('EMPTY_COMMIT', 'There are no staged changes to commit.');
        if (!args.message?.trim() || args.message.includes('\0')) throw new GitError('INVALID_INPUT', 'A non-empty commit message without NUL is required.');
        const output = (await git(['-c', 'commit.gpgSign=false', 'commit', '--cleanup=verbatim', '-m', args.message])).stdout;
        return { ...result, commit: await this.revision(git, 'HEAD'), output };
      }
      case 'git_create_branch':
      case 'git_switch_branch': {
        if (!args.name || args.name.startsWith('-') || args.name.includes('\0') || args.name.includes('@{')) throw new GitError('INVALID_INPUT', 'A literal local branch name is required.');
        await git(['check-ref-format', '--branch', args.name]);
        if (name === 'git_create_branch') {
          const start = await this.revision(git, args.start_point ?? 'HEAD');
          await git(['branch', '--no-track', args.name, start]);
        } else {
          const dirty = parseStatus((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
          if (dirty.length) throw new GitError('DIRTY_WORKTREE', 'Switching requires a clean working tree and index. Commit or otherwise preserve changes first.');
          await git(['switch', '--no-guess', args.name]);
        }
        return { ...result, branch: args.name };
      }
      default: throw new GitError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
  }
}
