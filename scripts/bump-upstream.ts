// Moves an upstream pin (a shallow submodule at upstream/<name>) to another commit.
//
//   node scripts/bump-upstream.ts <moon|async> <commit>
//
// Fetches the commit with --depth 1, checks it out in the submodule and stages the new
// gitlink. jj ignores gitlink changes, so the bump is committed with git.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { type UpstreamName, upstreamDir } from './upstream.ts';

const [name, commit] = process.argv.slice(2);
if ((name !== 'moon' && name !== 'async') || commit === undefined) {
  console.error('usage: node scripts/bump-upstream.ts <moon|async> <commit>');
  process.exit(2);
}
const repoRoot = path.resolve(import.meta.dirname, '..');
const dir = upstreamDir(name as UpstreamName);
const run = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

run(['fetch', '--quiet', '--depth', '1', 'origin', commit], dir);
run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
const full = run(['rev-parse', 'HEAD'], dir).trim();
run(['add', `upstream/${name}`], repoRoot);
console.log(`upstream/${name} is now at ${full} (staged).
Next:
  node scripts/sync-upstream.ts       # re-extract the reused files; review rewrite-count changes
  node scripts/gen-imports.ts         # regenerate the import tables
  node scripts/build-wasm.ts          # rebuild the components
  then run the suites, and commit the gitlink with git (jj ignores gitlinks):
  git commit -m "Bump ${name} to ${full.slice(0, 12)}" -- upstream/${name}`);
