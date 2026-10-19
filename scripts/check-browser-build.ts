// Follow emitted browser entries, including Worker and component URL dependencies.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../dist');
const seen = new Set<string>();
function check(file: string): void {
  if (seen.has(file)) return;
  seen.add(file);
  if (file.startsWith(path.join(root, 'hosts/node/')))
    throw new Error(`Node host in browser build: ${file}`);
  const source = readFileSync(file, 'utf8');
  const imports = [
    ...source.matchAll(/^(?:import|export)(?:[^\n"']*?from\s*)?\s*["']([^"']+)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']/g),
  ];
  for (const match of imports) {
    if (!match[1]?.startsWith('.'))
      throw new Error(`browser build has external import: ${match[1]}`);
  }
  const specs = [...imports, ...source.matchAll(/new URL\(["'](\.[^"']+\.(?:js|wasm))["']/g)];
  for (const match of specs) {
    const target = path.resolve(path.dirname(file), match[1] ?? '');
    if (!existsSync(target)) throw new Error(`missing browser dependency: ${target}`);
    if (target.endsWith('.js')) check(target);
  }
}
check(path.join(root, 'browser/index.js'));
check(path.join(root, 'browser/worker.js'));
console.log(
  `browser build: ${seen.size} JS modules, no node: or hosts/node imports; wasm URLs exist`,
);
