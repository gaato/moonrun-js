import type { ChildStdio, ProcessPort } from '../ports/process.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { type AsyncError, BADF, INVAL, IO, native } from './errors.ts';
import type { Job, ProcessPayload } from './job.ts';
import type { Execution } from './job-runner.ts';
import {
  type Child,
  type ChildAuthorityPort,
  type Children,
  drainChild,
  feedChild,
  isMoonxExecutable,
  overwriteEnv,
} from './process.ts';
import type { Resource } from './resource.ts';

/** What process Jobs use (moonrun `HostProcess`). */
export interface ProcessEnvironment {
  readonly port: ProcessPort;
  readonly children: Children;
  /** `ProcessPolicy::allows_unix` (prints its denial); absent without a process policy. */
  readonly authorizeSpawn:
    | ((program: string, argv: readonly string[]) => AsyncError | undefined)
    | undefined;
  /** The policy a `moonx` child inherits; absent without a policy. */
  readonly inheritance: (() => Uint8Array | undefined) | undefined;
  /** Child provenance; present exactly under a process policy. */
  readonly authority: ChildAuthorityPort | undefined;
}

/** `moonutil::constants::MOONRUN_INHERITED_POLICY`. */
const INHERITED_POLICY = 'MOONRUN_INHERITED_POLICY';
/** The policy transfer is the child's first descriptor after stdio. */
const TRANSFER_FD = 3;

const FINISHED: Execution = { interrupt: () => false };
const EINTR = native('EINTR');

type SpawnPayload = Extract<ProcessPayload, { kind: 'spawn' }>;
type WaitPayload = Extract<ProcessPayload, { kind: 'wait-for-process' }>;

/** How one guest resource becomes a child stream; `pipe` streams are bridged after the spawn. */
function childStdio(resource: Resource | undefined): Result<ChildStdio, AsyncError> {
  if (resource === undefined) {
    return ok({ kind: 'inherit' });
  }
  switch (resource.kind) {
    case 'stdio':
      return ok({ kind: 'fd', fd: resource.stream });
    case 'file':
      return ok({ kind: 'fd', fd: resource.file.fd });
    case 'pipe':
      return ok({ kind: 'pipe' });
    case 'invalid':
      return err(BADF);
    // No host descriptor to hand over (divergence D30).
    case 'socket':
    case 'process':
    case 'inotify':
    case 'completion-source':
      return err(INVAL);
  }
}

/** Runs a process Job (moonrun `run_policy_checked_job` + `process::Job::run`). */
export function startProcessJob(
  job: Job,
  payload: ProcessPayload,
  env: ProcessEnvironment,
  done: () => void,
): Execution {
  switch (payload.kind) {
    case 'spawn':
      return spawn(job, payload, env, done);
    case 'wait-for-process':
      return waitForProcess(job, payload, env, done);
    case 'sigwait': {
      const sink = payload.sink;
      if (sink.cancelled) {
        done();
        return FINISHED;
      }
      sink.run();
      return {
        interrupt: () => {
          if (sink.cancelled) {
            return false;
          }
          sink.cancel();
          job.succeed(0);
          done();
          return true;
        },
      };
    }
  }
}

/** `spawn_job_worker`: `posix_spawnp` with the guest's streams, env and cwd. */
function spawn(job: Job, payload: SpawnPayload, env: ProcessEnvironment, done: () => void) {
  const finish = (error: AsyncError | undefined, ret = 0): Execution => {
    if (error === undefined) {
      job.succeed(ret);
    } else {
      job.fail(error);
    }
    done();
    return FINISHED;
  };
  const denied = env.authorizeSpawn?.(payload.program, payload.argv);
  if (denied !== undefined) {
    return finish(denied);
  }
  // Only a direct moonx child inherits the policy, through an anonymous file.
  const inheritance = isMoonxExecutable(payload.program) ? env.inheritance?.() : undefined;
  let transfer: number | undefined;
  let childEnv = payload.env;
  if (inheritance !== undefined) {
    const opened = env.port.openPolicyTransfer(inheritance);
    if (!opened.ok) {
      return finish(native(opened.error.code));
    }
    transfer = opened.value;
    childEnv = overwriteEnv(childEnv, INHERITED_POLICY, String(TRANSFER_FD));
  }
  const closeTransfer = (): void => {
    if (transfer !== undefined) {
      env.port.closeFd(transfer);
      transfer = undefined;
    }
  };
  // `CString::new` of every string handed to the OS.
  const strings = [payload.program, ...payload.argv, ...childEnv, payload.cwd ?? ''];
  if (strings.some((s) => s.includes('\0'))) {
    closeTransfer();
    return finish(INVAL);
  }
  const stdio: ChildStdio[] = [];
  for (const resource of payload.stdio) {
    const mapped = childStdio(resource);
    if (!mapped.ok) {
      closeTransfer();
      return finish(mapped.error);
    }
    stdio.push(mapped.value);
  }
  const [stdin, stdout, stderr] = payload.stdio;
  // One pipe end on both output streams is one pipe in the child, so the order of writes holds.
  const merged = stdout?.kind === 'pipe' && stderr?.kind === 'pipe' && stdout.end === stderr.end;
  if (merged) {
    stdio[2] = { kind: 'stdout' };
  }
  env.port
    .spawn({
      program: payload.program,
      argv: payload.argv,
      env: childEnv,
      cwd: payload.cwd,
      stdio: [
        stdio[0] ?? { kind: 'inherit' },
        stdio[1] ?? { kind: 'inherit' },
        stdio[2] ?? { kind: 'inherit' },
      ],
      extraFds: transfer === undefined ? [] : [transfer],
    })
    .then(
      (r) => {
        closeTransfer();
        if (!r.ok) {
          finish(native(r.error.code));
          return;
        }
        const process = r.value;
        const child = env.children.add(process.pid, process);
        // The child now holds its own copies of the pipe ends (bridged by the kernel).
        if (stdin?.kind === 'pipe' && process.stdin !== undefined) {
          feedChild(env.children, stdin.end, process.stdin);
        }
        if (stdout?.kind === 'pipe' && process.stdout !== undefined) {
          drainChild(env.children, stdout.end, process.stdout);
        }
        if (!merged && stderr?.kind === 'pipe' && process.stderr !== undefined) {
          drainChild(env.children, stderr.end, process.stderr);
        }
        payload.result = { state: 'unpublished', child };
        env.authority?.trackSpawned(process.pid);
        finish(undefined, process.pid);
      },
      () => {
        closeTransfer();
        finish(IO);
      },
    );
  // posix_spawn runs outside a cancellable region.
  return FINISHED;
}

/**
 * `wait_for_process_job_worker`: a blocking `waitid` on the pidfd or `waitpid` on the pid,
 * cancellable. A successful wait reaps the child (under a policy after the authority check).
 */
function waitForProcess(
  job: Job,
  payload: WaitPayload,
  env: ProcessEnvironment,
  done: () => void,
): Execution {
  const fail = (error: AsyncError): Execution => {
    job.fail(error);
    done();
    return FINISHED;
  };
  const authority = env.authority;
  if (authority !== undefined) {
    const allowed = authority.checkWait(
      payload.resource !== undefined,
      payload.trackedPid,
      payload.pid,
    );
    if (!allowed.ok) {
      return fail(allowed.error);
    }
  }
  let child: Child | undefined;
  if (payload.resource === undefined) {
    child = env.children.get(payload.pid);
  } else if (payload.resource.kind === 'process') {
    child = payload.resource.child;
  } else {
    // waitid(P_PIDFD) on a descriptor that is not a pidfd.
    return fail(INVAL);
  }
  if (child === undefined || child.reaped) {
    return fail(native('ECHILD'));
  }
  const waited = child;
  const complete = (): void => {
    const code = waited.tryReap();
    if (code.ok) {
      authority?.finishWait(payload.pid);
      job.succeed(code.value);
    } else {
      job.fail(code.error);
    }
    done();
  };
  if (!waited.running) {
    complete();
    return FINISHED;
  }
  let unwatch: (() => void) | undefined = waited.watch(() => {
    if (unwatch !== undefined && !waited.running) {
      unwatch();
      unwatch = undefined;
      complete();
    }
  });
  return {
    interrupt: () => {
      if (unwatch === undefined) {
        return false;
      }
      unwatch();
      unwatch = undefined;
      job.fail(EINTR);
      done();
      return true;
    },
  };
}
