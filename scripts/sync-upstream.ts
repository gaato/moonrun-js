// Extracts the upstream moon files the wasm components are built from (docs/reuse.md).
//
//   node scripts/sync-upstream.ts            extract, rewrite, scan, align crates/Cargo.lock
//   node scripts/sync-upstream.ts --check    verify the committed files and lockfile (CI)
//   node scripts/sync-upstream.ts --record   accept changed rewrite counts into crates/upstream.json
//
// Upstream files are read through scripts/upstream.ts (pin and source in one place).
// For each entry of crates/upstream.json the file lands at crates/<crate>/upstream/<path>
// with only the listed mechanical rewrites applied; a rewrite whose hit count differs from
// the recorded one fails (an upstream change needs a look). Stubs from crates/<crate>/stubs/
// are copied next to the files that declare them. Finally the non-test code is scanned for
// std calls that reach the OS in ways the rewrites cannot catch (they compile on
// wasm32-unknown-unknown and then silently fail).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { readUpstream, upstreamPin } from './upstream.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cratesDir = path.join(repoRoot, 'crates');
const manifestPath = path.join(cratesDir, 'upstream.json');
const check = process.argv.includes('--check');
const record = process.argv.includes('--record');

interface Rule {
  readonly from: string;
  readonly to: string;
}
interface FileEntry {
  readonly crate: string;
  readonly path: string;
  rewrites: Record<string, number>;
  /** Only this item is compiled; the rest of the file is not scanned. */
  readonly compiledItem?: string;
}
interface Manifest {
  readonly rewrites: Record<string, Rule>;
  readonly files: FileEntry[];
  readonly stubs: ReadonlyArray<{ readonly crate: string; readonly path: string }>;
  /** Registry packages allowed to differ from moon's Cargo.lock: name -> reason. */
  readonly lockExceptions: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const pin = upstreamPin('moon');
const show = (p: string): string => readUpstream('moon', p);

/** The file without its `#[cfg(test)] mod tests` block (upstream keeps it last). */
function nonTest(text: string): string {
  const m = /^#\[cfg\(test\)\]\n(?:pub(?:\([a-z]+\))? )?mod tests\b/m.exec(text);
  return m === null ? text : text.slice(0, m.index);
}

/**
 * std uses that reach the OS but that no rewrite covers. Each has to become a rewrite
 * rule (or the code must not be compiled) before the file can be reused.
 */
const OS_CALLS =
  /\.(is_file|is_dir|exists|try_exists|canonicalize|metadata|symlink_metadata|read_dir|read_link)\(\)|SystemTime::now|Instant::now|\bthread::(sleep|spawn)|std::io::(stdin|stdout|stderr)\(|std::process::|std::(fs|env|thread|process|net)\b(?!::)|env::(args|current_exe|set_var|remove_var)|OsRng|getrandom|\bprintln!|\bprint!/;

const problems: string[] = [];
const outputs = new Map<string, string>();
let recorded = false;

for (const entry of manifest.files) {
  const original = show(entry.path);
  let text = original;
  const counts: Record<string, number> = {};
  for (const [name, rule] of Object.entries(manifest.rewrites)) {
    if (entry.compiledItem !== undefined) {
      continue;
    }
    const re = new RegExp(rule.from, 'g');
    const hits = original.match(re)?.length ?? 0;
    if (hits !== 0) {
      counts[name] = hits;
    }
    text = text.replace(re, rule.to);
  }
  const expected = JSON.stringify(entry.rewrites);
  if (JSON.stringify(counts) !== expected) {
    if (record) {
      entry.rewrites = counts;
      recorded = true;
    } else {
      problems.push(
        `${entry.path}: rewrite counts ${JSON.stringify(counts)}, recorded ${expected} (inspect the upstream change, then --record)`,
      );
    }
  }
  if (entry.compiledItem === undefined) {
    nonTest(text)
      .split('\n')
      .forEach((line, i) => {
        if (!line.trimStart().startsWith('//') && OS_CALLS.test(line)) {
          problems.push(`${entry.path}:${i + 1}: OS call not covered by a rewrite: ${line.trim()}`);
        }
      });
  } else if (!original.includes(entry.compiledItem)) {
    problems.push(`${entry.path}: \`${entry.compiledItem}\` not found`);
  }
  const applied = Object.entries(counts).map(([rule, n]) => `${rule} \u00d7${n}`);
  const header = `// upstream: moonbitlang/moon@${pin} ${entry.path} (rewrites: ${applied.length === 0 ? 'none' : applied.join(', ')})\n`;
  outputs.set(path.join(cratesDir, entry.crate, 'upstream', entry.path), header + text);
}

for (const stub of manifest.stubs) {
  const source = path.join(cratesDir, stub.crate, 'stubs', stub.path);
  outputs.set(
    path.join(cratesDir, stub.crate, 'upstream', stub.path),
    readFileSync(source, 'utf8'),
  );
}

for (const [file, text] of outputs) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (current === text) {
    continue;
  }
  if (check) {
    const headerPin = /^\/\/ upstream: moonbitlang\/moon@(\S+) /.exec(current ?? '')?.[1];
    problems.push(
      headerPin !== undefined && headerPin !== pin
        ? `${path.relative(repoRoot, file)}: extracted at ${headerPin}, but the pin is ${pin} (run sync-upstream)`
        : `${path.relative(repoRoot, file)}: differs from upstream ${pin} (run sync-upstream)`,
    );
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
}

if (recorded) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('recorded new rewrite counts in crates/upstream.json');
}

// ----- Cargo.lock: the same crates.io versions as moon (error texts depend on them) -----

type Packages = Map<string, Set<string>>;

function registryPackages(text: string): Packages {
  const out: Packages = new Map();
  for (const m of text.matchAll(
    /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry/g,
  )) {
    const [, name = '', version = ''] = m;
    const set = out.get(name) ?? new Set<string>();
    set.add(version);
    out.set(name, set);
  }
  return out;
}

const moonLock = registryPackages(show('Cargo.lock'));
const lockFile = path.join(cratesDir, 'Cargo.lock');

/** Packages of ours whose version moon does not use (and that moon uses at all). */
function misaligned(): Array<[string, string, string[]]> {
  const ours = registryPackages(readFileSync(lockFile, 'utf8'));
  const out: Array<[string, string, string[]]> = [];
  for (const [name, versions] of ours) {
    const theirs = moonLock.get(name);
    if (theirs === undefined || name in manifest.lockExceptions) {
      continue;
    }
    for (const v of versions) {
      if (!theirs.has(v)) {
        out.push([name, v, [...theirs]]);
      }
    }
  }
  return out;
}

if (!check && !existsSync(lockFile)) {
  execFileSync('cargo', ['generate-lockfile', '--quiet'], { cwd: cratesDir, stdio: 'inherit' });
}
if (!check) {
  for (let round = 0; round < 6; round++) {
    const todo = misaligned();
    if (todo.length === 0) {
      break;
    }
    for (const [name, version, theirs] of todo) {
      const major = (v: string): string =>
        v
          .split('.')
          .slice(0, v.startsWith('0.') ? 2 : 1)
          .join('.');
      const want = theirs.find((t) => major(t) === major(version)) ?? theirs[0] ?? version;
      try {
        execFileSync(
          'cargo',
          ['update', '--quiet', '-p', `${name}@${version}`, '--precise', want],
          {
            cwd: cratesDir,
            stdio: 'pipe',
          },
        );
        console.log(`Cargo.lock: ${name} ${version} -> ${want}`);
      } catch (e) {
        const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim().split('\n').at(-1);
        console.log(
          `Cargo.lock: cannot align ${name} ${version} -> ${want}: ${stderr ?? String(e)}`,
        );
      }
    }
  }
}
for (const [name, version, theirs] of misaligned()) {
  problems.push(
    `crates/Cargo.lock: ${name} ${version} is not a version moon uses (${theirs.join(', ')}); align it or add a lockExceptions entry`,
  );
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`upstream files match moon ${pin}`);
