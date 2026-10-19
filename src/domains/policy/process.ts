import { err, ok, type Result } from '../../ports/result.ts';
import { type PolicyDenied, sandboxDenied, silentDenied } from './denial.ts';

export interface ProcessRule {
  readonly program: string;
  readonly argsPrefix: readonly string[];
}

export type ProcessPolicy =
  | { readonly kind: 'allow-all' }
  | { readonly kind: 'scoped'; readonly rules: readonly ProcessRule[] };

export interface ProcessConfig {
  readonly spawn: boolean;
  readonly allow: readonly { readonly program: string; readonly argsPrefix: readonly string[] }[];
}

/** `ProcessPolicy::from_config`; the error is moonrun's context chain, outermost first. */
export function buildProcessPolicy(
  config: ProcessConfig,
): Result<ProcessPolicy, readonly string[]> {
  if (config.spawn && config.allow.length > 0) {
    return err(['process.spawn and process.allow cannot be used together']);
  }
  if (config.spawn) {
    return ok({ kind: 'allow-all' });
  }
  const rules: ProcessRule[] = [];
  for (const [index, rule] of config.allow.entries()) {
    let problem: string | undefined;
    if (rule.program === '') {
      problem = 'program must not be empty';
    } else if (rule.program.includes('\0')) {
      problem = 'program must not contain NUL';
    } else if (rule.argsPrefix.some((a) => a.includes('\0'))) {
      problem = 'args_prefix must not contain NUL';
    }
    if (problem !== undefined) {
      return err([`invalid process.allow[${index}]`, problem]);
    }
    rules.push({ program: rule.program, argsPrefix: rule.argsPrefix });
  }
  return ok({ kind: 'scoped', rules });
}

/**
 * `ProcessPolicy::allows_unix`. `program` is the path/name the guest asked to execute and
 * `argv` the full argument vector (argv[0] included). A rule matches when the program is the
 * exact string, argv[0] equals it, and the remaining arguments start with the rule's tokens.
 * The decision concerns the logical request, not the executable PATH lookup later selects.
 */
export function authorizeSpawn(
  policy: ProcessPolicy | undefined,
  program: string,
  argv: readonly string[],
): Result<void, PolicyDenied> {
  if (policy === undefined || policy.kind === 'allow-all') {
    return ok(undefined);
  }
  const matched = policy.rules.some(
    (rule) =>
      rule.program === program &&
      argv[0] === program &&
      argv.length - 1 >= rule.argsPrefix.length &&
      rule.argsPrefix.every((expected, i) => argv[i + 1] === expected),
  );
  return matched ? ok(undefined) : sandboxDenied('process spawn');
}

/** `moonutil::constants::is_moonx_executable` on Unix: the final component is `moonx` or `moonx.exe`. */
export function isMoonxExecutable(program: string): boolean {
  const name = program
    .split('/')
    .filter((p) => p !== '')
    .at(-1);
  return name === 'moonx' || name === 'moonx.exe';
}

/**
 * Child-process provenance (moonrun's `ChildAuthorityState`). It exists only under a policy:
 * once a policy is active the guest may only wait on, signal or open handles for children it
 * spawned itself. Every failure is a silent EACCES.
 */
export class ChildAuthority {
  readonly #ownedPids = new Set<number>();
  readonly #handlePids = new Map<bigint, number>();

  /** A spawn job finished successfully with `pid`. */
  trackSpawned(pid: number): void {
    this.#ownedPids.add(pid);
  }

  /** `with_owned_child_pid`: kill/open-pid-handle style operations. */
  checkOwned(pid: number): Result<void, PolicyDenied> {
    return this.#ownedPids.has(pid) ? ok(undefined) : silentDenied();
  }

  trackHandle(handle: bigint, pid: number): void {
    this.#handlePids.set(handle, pid);
  }

  /** `process_handle_pid`: the pid a process handle was created for, or denial if unknown. */
  handlePid(handle: bigint): Result<number, PolicyDenied> {
    const pid = this.#handlePids.get(handle);
    return pid === undefined ? silentDenied() : ok(pid);
  }

  /** Dropping a handle also revokes the pid when no other handle refers to it. */
  untrackHandle(handle: bigint): void {
    const pid = this.#handlePids.get(handle);
    if (pid === undefined) {
      return;
    }
    this.#handlePids.delete(handle);
    if (![...this.#handlePids.values()].includes(pid)) {
      this.#ownedPids.delete(pid);
    }
  }

  /**
   * `check_wait`, evaluated when the wait job runs. `handle` says whether a process handle was
   * supplied; `trackedPid` is what `handlePid` returned for it when the job was created.
   */
  checkWait(
    hasHandle: boolean,
    trackedPid: number | undefined,
    pid: number,
  ): Result<void, PolicyDenied> {
    const owned = this.checkOwned(pid);
    if (!owned.ok) {
      return owned;
    }
    if (!hasHandle && trackedPid === undefined) {
      return ok(undefined);
    }
    return hasHandle && trackedPid === pid ? ok(undefined) : silentDenied();
  }

  /** After a successful wait: the child is reaped, so its pid is no longer owned. */
  finishWait(pid: number): void {
    this.#ownedPids.delete(pid);
  }

  /** `finish_owned_child` (explicit reap): authorize first, run the operation, then call `finishWait`. */
  checkFinish(pid: number, handle: bigint | undefined): Result<void, PolicyDenied> {
    if (
      !this.#ownedPids.has(pid) ||
      (handle !== undefined && this.#handlePids.get(handle) !== pid)
    ) {
      return silentDenied();
    }
    return ok(undefined);
  }

  /** A spawn result the guest never claimed as a handle: drop the pid unless a handle uses it. */
  revokeUnclaimed(pid: number): void {
    if (![...this.#handlePids.values()].includes(pid)) {
      this.#ownedPids.delete(pid);
    }
  }
}
