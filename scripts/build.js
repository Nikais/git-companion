import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Bundle runtime dependencies so a marketplace install only needs Node and Git.
const result = await build({
  entryPoints: ['src/server.js'],
  outfile: 'plugins/git-companion/dist/server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'linked',
  metafile: true,
});

const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) continue;
  packageDirs.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/'));
}
const notices = [];
for (const directory of [...packageDirs].sort()) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name)).sort();
  const texts = await Promise.all(licenses.map(name => readFile(path.join(directory, name), 'utf8')));
  notices.push(`${metadata.name}@${metadata.version} (${metadata.license ?? 'see license below'})\n${texts.join('\n')}`);
}
await writeFile('plugins/git-companion/dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n----------------------------------------\n\n'));
