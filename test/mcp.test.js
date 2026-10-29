import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.js';

test('bundled server negotiates MCP, advertises schemas and performs a full commit workflow', async t => {
  const { repo } = await fixture(t);
  const installed = await mkdtemp(path.join(tmpdir(), 'git-mcp-install-'));
  t.after(() => rm(installed, { recursive: true, force: true }));
  for (const name of ['plugin.json', 'mcp.json', 'skills', 'dist']) {
    await cp(fileURLToPath(new URL(`../plugins/git-mcp/${name}`, import.meta.url)), path.join(installed, name), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(installed, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'git-mcp');
  assert.equal((await readdir(path.join(installed, 'skills'))).length, 3);
  const config = JSON.parse(await readFile(path.join(installed, 'mcp.json'), 'utf8')).mcpServers.git;
  const client = new Client({ name: 'git-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', installed)), cwd: installed, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 10);
  assert.equal(listed.tools.find(tool => tool.name === 'git_status').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(tool => tool.name === 'git_commit').annotations.destructiveHint, true);
  const invoke = (name, args = {}) => client.callTool({ name, arguments: { repo_path: repo, ...args } });
  assert.equal((await invoke('git_status')).structuredContent.clean, true);
  await writeFile(path.join(repo, 'hello.txt'), 'MCP change\n');
  assert.equal((await invoke('git_add', { paths: ['hello.txt'] })).isError, undefined);
  const snapshot = (await invoke('git_diff', { mode: 'staged' })).structuredContent;
  const committed = await invoke('git_commit', { message: 'feat: MCP workflow', expected_index_fingerprint: snapshot.index_fingerprint });
  assert.match(committed.structuredContent.commit, /^[a-f0-9]{40,64}$/);
  assert.equal((await invoke('git_status')).structuredContent.clean, true);
  const invalid = await invoke('git_show', { ref: '--help' });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).code, 'INVALID_INPUT');
  const badLimit = await invoke('git_log', { limit: 1000 });
  assert.equal(badLimit.isError, true);
  // Bad input must not terminate the server.
  assert.equal((await invoke('git_log', { limit: 1 })).structuredContent.commits[0].subject, 'feat: MCP workflow');
});

test('bundled server enforces read-only configuration over MCP', async t => {
  const { repo } = await fixture(t);
  const client = new Client({ name: 'read-only-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../plugins/git-mcp/dist/server.cjs', import.meta.url))], env: { GIT_MCP_READ_ONLY: 'true', GIT_MCP_ROOTS: repo }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const denied = await client.callTool({ name: 'git_create_branch', arguments: { repo_path: repo, name: 'denied' } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, 'READ_ONLY');
  assert.equal((await client.callTool({ name: 'git_status', arguments: { repo_path: repo } })).structuredContent.clean, true);
});
