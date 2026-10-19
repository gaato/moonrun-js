// MOONRUN_OVERRIDE target used by scripts/suite.ts. Runs the runner named by
// MOONRUN_JS_RECORD_RUNNER ("moonrun" or a path to moonrun-js) with the same argv,
// forwards its output to moon unchanged, and records {argv, stdout, stderr, exit}
// under MOONRUN_JS_RECORD_DIR keyed by the invocation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const runner = process.env['MOONRUN_JS_RECORD_RUNNER'] ?? 'moonrun';
const dir = process.env['MOONRUN_JS_RECORD_DIR'];
const root = process.env['MOONRUN_JS_RECORD_ROOT'] ?? process.cwd();
// Each runner builds into its own target dir; both are shown as <build>.
const build = process.env['MOONRUN_JS_RECORD_BUILD'];
const scrub = (s: string): string =>
  (build === undefined ? s : s.split(build).join('<build>')).split(root).join('<root>');
const argv = process.argv.slice(2);

const result = spawnSync(runner, argv, { stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const stdout = result.stdout ?? Buffer.alloc(0);
const stderr = result.stderr ?? Buffer.alloc(0);
process.stdout.write(stdout);
process.stderr.write(stderr);

if (dir !== undefined && argv[0] !== '--version') {
  // Key by argv with the project root removed, so both runs produce the same keys.
  const normalized = argv.map(scrub);
  const key = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify({
      argv: normalized,
      stdout: scrub(stdout.toString('utf8')),
      stderr: scrub(stderr.toString('utf8')),
      exit: result.status,
      signal: result.signal,
    }),
  );
}
process.exitCode = result.status ?? 1;
