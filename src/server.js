import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GitError, GitService } from './git.js';
import { tools } from './tools.js';

async function main() {
  const roots = process.env.GIT_MCP_ROOTS?.split(path.delimiter).filter(Boolean) ?? [];
  if (roots.some(root => !path.isAbsolute(root))) throw new Error('GIT_MCP_ROOTS entries must be absolute paths.');
  if (process.env.GIT_MCP_READ_ONLY && !['true', 'false', '1', '0'].includes(process.env.GIT_MCP_READ_ONLY)) {
    throw new Error('GIT_MCP_READ_ONLY must be true, false, 1 or 0.');
  }
  const service = new GitService({ roots, readOnly: ['true', '1'].includes(process.env.GIT_MCP_READ_ONLY) });
  const server = new McpServer({ name: 'git-companion', version: '0.2.0' });

  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations }, async args => {
      try {
        const result = await service.execute(tool.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = {
          code: error instanceof GitError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof GitError ? error.message : 'Unexpected server error. Check server stderr.',
        };
        if (!(error instanceof GitError)) console.error(error);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    });
  }

  server.server.onclose = () => { void service.close(); };
  await server.connect(new StdioServerTransport());
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    await server.close();
    await service.close();
    process.exit(0);
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
