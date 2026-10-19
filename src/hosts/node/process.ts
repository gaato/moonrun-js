import {
  type ChildProcess as NodeChildProcess,
  spawn as nodeSpawn,
  type StdioOptions,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, statSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type {
  ChildExit,
  ChildInput,
  ChildOutput,
  ChildProcess,
  ChildStdio,
  ProcessPort,
  SpawnRequest,
} from '../../ports/process.ts';
import { err, type HostError, type HostErrorCode, ok, type Result } from '../../ports/result.ts';
import { openPolicyTransfer } from './policy-loader.ts';
import { LINUX_SIGNALS, signalName } from './signals.ts';

function codeOf(e: unknown): HostErrorCode {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    return e.code as HostErrorCode;
  }
  return 'EIO';
}

/** glibc's `_CS_PATH`, used by `posix_spawnp` when `PATH` is unset. */
const DEFAULT_PATH = '/bin:/usr/bin';

/**
 * `posix_spawnp`'s executable search: the parent's `PATH` (not the child environment),
 * empty entries meaning the current directory, `EACCES` if a candidate existed but could not
 * be executed, else `ENOENT`. Relative candidates resolve against the child's directory, as
 * the search runs after the chdir file action.
 */
function lookup(program: string, cwd: string | undefined): Result<string, HostError> {
  if (program.includes('/')) {
    return ok(program);
  }
  if (program === '') {
    return err({ code: 'ENOENT' });
  }
  let eacces = false;
  for (const dir of (process.env['PATH'] ?? DEFAULT_PATH).split(':')) {
    const candidate = dir === '' ? `./${program}` : `${dir}/${program}`;
    const resolved = path.resolve(cwd ?? '.', candidate);
    try {
      if (!statSync(resolved).isFile()) {
        // execve on a directory or device is EACCES.
        eacces = true;
        continue;
      }
      accessSync(resolved, constants.X_OK);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'EACCES') {
        eacces = true;
      } else if (!['ENOENT', 'ENOTDIR', 'ESTALE', 'ENODEV', 'ETIMEDOUT'].includes(code)) {
        return err({ code });
      }
      continue;
    }
    return ok(candidate);
  }
  return err({ code: eacces ? 'EACCES' : 'ENOENT' });
}

function stdioOption(
  stdio: ChildStdio,
  shared: Socket | undefined,
): 'inherit' | 'pipe' | number | Socket {
  switch (stdio.kind) {
    case 'inherit':
      return 'inherit';
    case 'fd':
      return stdio.fd;
    case 'pipe':
      return shared ?? 'pipe';
    case 'stdout':
      return shared ?? 'pipe';
  }
}

/**
 * A connected stream socket pair (what libuv's `pipe` stdio is, too), for a host pipe that
 * two child streams share: the child gets the client side on both, the parent reads the other.
 */
async function socketPair(): Promise<Result<{ child: Socket; parent: Socket }, HostError>> {
  const address =
    process.platform === 'linux'
      ? `\0moonrun-js-${process.pid}-${randomBytes(8).toString('hex')}`
      : path.join(tmpdir(), `moonrun-js-${process.pid}-${randomBytes(8).toString('hex')}.sock`);
  const server = createServer();
  let child: Socket | undefined;
  let parent: Socket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: address }, resolve);
    });
    const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
    const connecting = connect({ path: address });
    child = connecting;
    await new Promise<void>((resolve, reject) => {
      connecting.once('error', reject);
      connecting.once('connect', resolve);
    });
    parent = await accepted;
    return ok({ child, parent });
  } catch (e) {
    child?.destroy();
    parent?.destroy();
    return err({ code: codeOf(e) });
  } finally {
    server.close();
  }
}

/** `getenv` semantics for repeated keys: the first entry wins. */
function environment(entries: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const key = eq < 0 ? entry : entry.slice(0, eq);
    const value = eq < 0 ? '' : entry.slice(eq + 1);
    if (!Object.hasOwn(env, key)) {
      env[key] = value;
    }
  }
  return env;
}

function input(stream: Writable): ChildInput {
  // A child that exits or closes its stdin turns our writes into EPIPE: reported as close.
  stream.on('error', () => {});
  return {
    write: (bytes) => stream.write(bytes),
    onDrain: (listener) => {
      stream.on('drain', listener);
    },
    end: () => {
      stream.end();
    },
    onClose: (listener) => {
      stream.once('close', listener);
    },
    destroy: () => {
      stream.destroy();
    },
  };
}

function output(stream: Readable): ChildOutput {
  stream.on('error', () => {});
  return {
    onData: (listener) => {
      stream.on('data', (chunk: Buffer) => {
        listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
    },
    pause: () => {
      stream.pause();
    },
    resume: () => {
      stream.resume();
    },
    onEnd: (listener) => {
      let ended = false;
      const once = (): void => {
        if (!ended) {
          ended = true;
          listener();
        }
      };
      stream.once('end', once);
      stream.once('close', once);
    },
    destroy: () => {
      stream.destroy();
    },
  };
}

function unrefStream(stream: Readable | Writable | null): void {
  const socket = stream as unknown as { unref?: () => void } | null;
  socket?.unref?.();
}

function wrap(child: NodeChildProcess, pid: number, merged: Socket | undefined): ChildProcess {
  const exits: ((exit: ChildExit) => void)[] = [];
  let exit: ChildExit | undefined;
  child.on('exit', (code, signal) => {
    exit =
      signal === null
        ? { kind: 'exited', code: code ?? 0 }
        : { kind: 'signaled', signal: LINUX_SIGNALS[signal] ?? 0 };
    for (const listener of exits.splice(0)) {
      listener(exit);
    }
  });
  // Errors after the spawn (a failed kill) are not reported through the child.
  child.on('error', () => {});
  return {
    pid,
    stdin: child.stdin === null ? undefined : input(child.stdin),
    stdout:
      merged !== undefined
        ? output(merged)
        : child.stdout === null
          ? undefined
          : output(child.stdout),
    stderr: child.stderr === null ? undefined : output(child.stderr),
    onExit: (listener) => {
      if (exit === undefined) {
        exits.push(listener);
      } else {
        listener(exit);
      }
    },
    unref: () => {
      child.unref();
      unrefStream(child.stdin);
      unrefStream(child.stdout);
      unrefStream(child.stderr);
      merged?.unref();
    },
  };
}

/** Child processes through `child_process.spawn`. */
export function nodeProcess(): ProcessPort {
  return {
    spawn: async (request: SpawnRequest) => {
      const file = lookup(request.program, request.cwd);
      if (!file.ok) {
        return file;
      }
      let pair: { child: Socket; parent: Socket } | undefined;
      if (request.stdio[2].kind === 'stdout') {
        const made = await socketPair();
        if (!made.ok) {
          return made;
        }
        pair = made.value;
      }
      const shared = pair?.child;
      const stdio: StdioOptions = [
        stdioOption(request.stdio[0], undefined),
        stdioOption(request.stdio[1], shared),
        stdioOption(request.stdio[2], shared),
        ...request.extraFds,
      ];
      let child: NodeChildProcess;
      try {
        child = nodeSpawn(file.value, request.argv.slice(1), {
          argv0: request.argv[0] ?? '',
          env: environment(request.env),
          stdio,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        });
      } catch (e) {
        pair?.child.destroy();
        pair?.parent.destroy();
        return err({ code: codeOf(e) });
      }
      // The child holds its own copy of the shared socket now.
      pair?.child.destroy();
      return new Promise((resolve) => {
        const onError = (e: unknown): void => {
          child.off('spawn', onSpawn);
          pair?.parent.destroy();
          resolve(err({ code: codeOf(e) }));
        };
        const onSpawn = (): void => {
          child.off('error', onError);
          resolve(ok(wrap(child, child.pid ?? 0, pair?.parent)));
        };
        child.once('error', onError);
        child.once('spawn', onSpawn);
      });
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal === 0 ? 0 : (signalName(signal) ?? signal));
        return ok(undefined);
      } catch (e) {
        return err({ code: codeOf(e) });
      }
    },
    openPolicyTransfer: (payload) => {
      try {
        return ok(openPolicyTransfer(payload));
      } catch (e) {
        return err({ code: codeOf(e) });
      }
    },
    closeFd: (fd) => {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };
}
