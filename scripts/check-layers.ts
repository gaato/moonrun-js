// Enforces the one-way layering of src/: engine -> abi -> domains -> kernel -> ports <- hosts.
// diagnostics, generated and types are leaves usable from anywhere in the core.
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'src');
const RANK: Record<string, number> = {
  ports: 0,
  kernel: 1,
  domains: 2,
  abi: 3,
  engine: 4,
  hosts: 5,
};
const LEAVES = new Set(['diagnostics', 'generated', 'types']);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(path.join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [path.join(dir, e.name)]
        : [],
  );
}

/** The first directory under src/, or '' for files directly in src/ (the public entry). */
function layerOf(file: string): string {
  const parts = path.relative(root, file).split(path.sep);
  return parts.length > 1 ? (parts[0] ?? '') : '';
}

const problems: string[] = [];
for (const file of files(root)) {
  const from = layerOf(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1] ?? '';
    const to = layerOf(path.resolve(path.dirname(file), spec));
    if (to === from || LEAVES.has(to)) {
      continue;
    }
    if (LEAVES.has(from) && to !== '') {
      problems.push(`${path.relative(root, file)}: leaf layer '${from}' imports '${to}'`);
      continue;
    }
    const a = RANK[from];
    const b = RANK[to];
    const allowed =
      from === 'hosts' ? to !== '' : a !== undefined && b !== undefined && b < a && to !== 'hosts';
    if (from === '' && to === 'hosts') {
      problems.push(`${path.relative(root, file)}: the core entry must not import hosts`);
    } else if (!allowed && from !== '' && to !== '') {
      problems.push(`${path.relative(root, file)}: '${from}' must not import '${to}' (${spec})`);
    }
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
