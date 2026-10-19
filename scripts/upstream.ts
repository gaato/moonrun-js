// The one place that knows where upstream sources come from. The upstreams are shallow
// git submodules at upstream/<name>; the pin is the gitlink recorded in the
// superproject's HEAD (`git ls-tree HEAD upstream/<name>`), and files are read at the
// pin with `git -C upstream/<name> show`. Every script goes through this module.
//
// After cloning moonrun-js: `git submodule update --init --depth 1` (not recursive).
// To move a pin: `node scripts/bump-upstream.ts <name> <commit>`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export type UpstreamName = 'moon' | 'async';

const repoRoot = path.resolve(import.meta.dirname, '..');

const git = (args: readonly string[], cwd = repoRoot): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

/** The submodule's directory. */
export function upstreamDir(name: UpstreamName): string {
  return path.join(repoRoot, 'upstream', name);
}

const pins = new Map<UpstreamName, string>();

/**
 * The pinned commit: the gitlink in the superproject's HEAD. Fails when the submodule
 * is not checked out at it (an uncommitted bump, or `git submodule update` missing).
 */
export function upstreamPin(name: UpstreamName): string {
  const known = pins.get(name);
  if (known !== undefined) {
    return known;
  }
  const entry = git(['ls-tree', 'HEAD', `upstream/${name}`]).trim();
  const pin = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1];
  if (pin === undefined) {
    throw new Error(`upstream/${name} is not a submodule in HEAD (got: ${entry || 'nothing'})`);
  }
  const dir = upstreamDir(name);
  if (!existsSync(path.join(dir, '.git'))) {
    throw new Error(
      `upstream/${name} is not checked out; run \`git submodule update --init --depth 1\``,
    );
  }
  const head = git(['rev-parse', 'HEAD'], dir).trim();
  if (head !== pin) {
    throw new Error(
      `upstream/${name} is at ${head}, but HEAD pins ${pin}; run \`git submodule update --depth 1\` or commit the bump`,
    );
  }
  pins.set(name, pin);
  return pin;
}

/** A file of the upstream at its pinned commit. */
export function readUpstream(name: UpstreamName, file: string): string {
  return git(['-C', upstreamDir(name), 'show', `${upstreamPin(name)}:${file}`]);
}

/**
 * A separate working tree of the upstream at its pin in `dir` (shared object store), for
 * tools that write into the tree (`moon test` builds into `_build/`).
 */
export function checkoutUpstream(name: UpstreamName, dir: string): string {
  const pin = upstreamPin(name);
  if (!existsSync(dir)) {
    git(['clone', '--quiet', '--shared', '--no-checkout', upstreamDir(name), dir]);
  }
  try {
    git(['-C', dir, 'cat-file', '-e', `${pin}^{commit}`]);
  } catch {
    git(['-C', dir, 'fetch', '--quiet', upstreamDir(name), pin]);
  }
  git(['-C', dir, 'checkout', '--quiet', '--detach', pin]);
  return dir;
}
