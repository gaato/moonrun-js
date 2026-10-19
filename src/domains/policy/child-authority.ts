import { type AsyncError, PERMISSION_DENIED } from '../../kernel/errors.ts';
import type { ChildAuthorityPort } from '../../kernel/process.ts';
import { err, ok, type Result } from '../../ports/result.ts';

export { isMoonxExecutable } from '../../kernel/process.ts';

// Child-process provenance under a policy. Upstream keeps it in process/mod.rs, which is
// OS-bound and not reused (docs/reuse.md), so this stays a TypeScript port. The spawn
// rule itself (`ProcessPolicy::allows_unix`) is the policy component's (`checkSpawn`).

const denied = (): Result<never, AsyncError> => err(PERMISSION_DENIED);

/**
 * Child-process provenance (moonrun's `ChildAuthorityState`). It exists only under a policy:
 * once a policy is active the guest may only wait on, signal or open handles for children it
 * spawned itself. Every failure is a silent EACCES.
 */
export class ChildAuthority implements ChildAuthorityPort {
  readonly #ownedPids = new Set<number>();
  readonly #handlePids = new Map<bigint, number>();

  /** A spawn job finished successfully with `pid`. */
  trackSpawned(pid: number): void {
    this.#ownedPids.add(pid);
  }

  /** `with_owned_child_pid`: kill/open-pid-handle style operations. */
  checkOwned(pid: number): Result<void, AsyncError> {
    return this.#ownedPids.has(pid) ? ok(undefined) : denied();
  }

  trackHandle(handle: bigint, pid: number): void {
    this.#handlePids.set(handle, pid);
  }

  /** `process_handle_pid`: the pid a process handle was created for, or denial if unknown. */
  handlePid(handle: bigint): Result<number, AsyncError> {
    const pid = this.#handlePids.get(handle);
    return pid === undefined ? denied() : ok(pid);
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
  ): Result<void, AsyncError> {
    const owned = this.checkOwned(pid);
    if (!owned.ok) {
      return owned;
    }
    if (!hasHandle && trackedPid === undefined) {
      return ok(undefined);
    }
    return hasHandle && trackedPid === pid ? ok(undefined) : denied();
  }

  /** After a successful wait: the child is reaped, so its pid is no longer owned. */
  finishWait(pid: number): void {
    this.#ownedPids.delete(pid);
  }

  /** `finish_owned_child` (explicit reap): authorize first, run the operation, then call `finishWait`. */
  checkFinish(pid: number, handle: bigint | undefined): Result<void, AsyncError> {
    if (
      !this.#ownedPids.has(pid) ||
      (handle !== undefined && this.#handlePids.get(handle) !== pid)
    ) {
      return denied();
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
