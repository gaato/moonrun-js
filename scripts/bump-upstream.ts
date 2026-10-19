// Moves an upstream pin (a shallow submodule at upstream/<name>) to another commit.
//
//   node scripts/bump-upstream.ts moon <commit> <moonrun-version>
//   node scripts/bump-upstream.ts async <commit>
//
// Fetches the commit with --depth 1, checks it out in the submodule and stages the new
// gitlink. jj ignores gitlink changes, so the bump is committed with git.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { type UpstreamName, upstreamDir } from './upstream.ts';

// moonrun's version contains its build date, so it cannot be inferred from the git pin.
const [name, commit, compatVersion] = process.argv.slice(2);
if (
  (name !== 'moon' && name !== 'async') ||
  commit === undefined ||
  (name === 'moon' && !/^\d+\.\d+\.\d+$/.test(compatVersion ?? ''))
) {
  console.error(
    'usage: node scripts/bump-upstream.ts moon <commit> <moonrun-version>\n       node scripts/bump-upstream.ts async <commit>',
  );
  process.exit(2);
}
const repoRoot = path.resolve(import.meta.dirname, '..');
const dir = upstreamDir(name as UpstreamName);
const run = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

run(['fetch', '--quiet', '--depth', '1', 'origin', commit], dir);
run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
const full = run(['rev-parse', 'HEAD'], dir).trim();
if (name === 'moon') {
  const short = full.slice(0, 7);
  const replacements: [string, [RegExp, string][]][] = [
    [
      'src/hosts/node/cli.ts',
      [[/compat moonrun \d+\.\d+\.\d+ [0-9a-f]+/g, `compat moonrun ${compatVersion} ${short}`]],
    ],
    [
      'README.md',
      [
        [/compat: moonrun \d+\.\d+\.\d+/g, `compat: moonrun ${compatVersion}`],
        [/compat-moonrun%20\d+\.\d+\.\d+/g, `compat-moonrun%20${compatVersion}`],
        [
          /real `moonrun` \d+\.\d+\.\d+ \(moon `[0-9a-f]+`\)/g,
          `real \`moonrun\` ${compatVersion} (moon \`${short}\`)`,
        ],
      ],
    ],
    [
      'AGENTS.md',
      [
        [
          /moonrun \(`\d+\.\d+\.\d+`, moon commit `[0-9a-f]+`\)/g,
          `moonrun (\`${compatVersion}\`, moon commit \`${short}\`)`,
        ],
      ],
    ],
  ];
  const updates = replacements.map(([file, rules]) => {
    const target = path.join(repoRoot, file);
    let text = readFileSync(target, 'utf8');
    for (const [pattern, replacement] of rules) {
      if (!pattern.test(text))
        throw new Error(`Missing compatibility marker in ${file}: ${pattern}`);
      text = text.replaceAll(pattern, replacement);
    }
    return { target, text };
  });
  for (const { target, text } of updates) writeFileSync(target, text);
  console.log(`Updated CLI and documentation compatibility to moonrun ${compatVersion} ${short}.`);
}
run(['add', `upstream/${name}`], repoRoot);
console.log(`upstream/${name} is now at ${full} (staged).
Next:
  node scripts/sync-upstream.ts       # re-extract the reused files; review rewrite-count changes
  node scripts/gen-imports.ts         # regenerate the import tables
  node scripts/build-wasm.ts          # rebuild the components
  then run the suites, and commit the gitlink with git (jj ignores gitlinks):
  git commit -m "Bump ${name} to ${full.slice(0, 12)}" -- upstream/${name}${name === 'moon' ? ' src/hosts/node/cli.ts README.md AGENTS.md' : ''}`);
