import { z } from 'zod';

const repo_path = z.string().min(1).describe('Absolute path inside the target Git working tree. All file paths are relative to its root.');
const paths = z.array(z.string().min(1).max(4096)).max(100).optional().describe('Literal repository-relative file/directory paths; no globs. Omit to read all tracked changes.');
const ref = z.string().min(1).max(1024);
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const tools = [
  { name: 'git_status', description: 'Read branch, HEAD, literal changed paths and index fingerprint. Handles unborn and detached HEAD.', schema: { repo_path }, annotations: read },
  { name: 'git_diff', description: 'Read working, staged or branch range diff. Untracked file contents are not included. Staged results include the fingerprint required by git_commit.', schema: { repo_path, paths, mode: z.enum(['working', 'staged', 'range']).default('working'), base: ref.optional(), head: ref.optional(), merge_base: z.boolean().default(true), context: z.number().int().min(0).max(20).default(3) }, annotations: read },
  { name: 'git_log', description: 'Read bounded commit history. An unborn repository has no history and returns a Git error.', schema: { repo_path, paths, ref: ref.optional(), limit: z.number().int().min(1).max(100).default(20) }, annotations: read },
  { name: 'git_show', description: 'Read metadata, statistics and patch for one commit.', schema: { repo_path, paths, ref: ref.optional() }, annotations: read },
  { name: 'git_branches', description: 'List local branches and optionally already-known remote tracking branches; does not contact remotes.', schema: { repo_path, include_remote: z.boolean().default(false) }, annotations: read },
  { name: 'git_add', description: 'Stage explicitly selected literal paths, including deletions. Changes the index, not working files. Configured Git clean filters may execute programs. Only use within the user-authorized task.', schema: { repo_path, paths: paths.unwrap().min(1) }, annotations: { ...write, idempotentHint: true, openWorldHint: true } },
  { name: 'git_unstage', description: 'Unstage selected literal paths while preserving working files, including before the first commit.', schema: { repo_path, paths: paths.unwrap().min(1) }, annotations: { ...write, idempotentHint: true } },
  { name: 'git_commit', description: 'Create a local unsigned commit of the reviewed index. Requires its current fingerprint from git_diff (staged). Hooks are disabled; run required project checks separately. Does not push or amend.', schema: { repo_path, message: z.string().min(1).max(10000), expected_index_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }, annotations: write },
  { name: 'git_create_branch', description: 'Create a new local branch at an existing commit without switching to it or overwriting another branch.', schema: { repo_path, name: ref, start_point: ref.optional() }, annotations: write },
  { name: 'git_switch_branch', description: 'Switch to an existing local branch only with a clean index and working tree. Configured checkout filters may execute programs or access the network. Does not force, create or guess remote branches.', schema: { repo_path, name: ref }, annotations: { ...write, openWorldHint: true } },
];
