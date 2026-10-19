import type { HostFd } from '../../ports/files.ts';
import type { ChildExit, ChildProcess, ProcessPort, SpawnRequest } from '../../ports/process.ts';
import { err, type HostError, ok, type Result } from '../../ports/result.ts';
import type { BrowserHost } from './host.ts';
import { BrowserControl, runBrowserGuest } from './runtime.ts';
import {
  type BrowserIo,
  BrowserOutput,
  BrowserStdin,
  type ByteReader,
  callbackWriter,
} from './streams.ts';
import type { MemoryVfs } from './vfs.ts';

export interface CommandContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export type ResolveCommand = (
  program: string,
  args: readonly string[],
  context: CommandContext,
) => Promise<Uint8Array | WebAssembly.Module | undefined>;
export interface ProcessTree {
  readonly controls: Map<number, BrowserControl>;
  closed: boolean;
}
function treeClosed(tree: ProcessTree): boolean {
  return tree.closed;
}
let nextPid = 1;
export function allocatePid(): number {
  return nextPid++;
}
export function childEnvironment(entries: readonly string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const key = eq < 0 ? entry : entry.slice(0, eq);
    if (!Object.hasOwn(result, key)) result[key] = eq < 0 ? '' : entry.slice(eq + 1);
  }
  return result;
}
export function childExit(outcome: Awaited<ReturnType<typeof runBrowserGuest>>): ChildExit {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'exited', code: 0 };
    case 'exited':
      return { kind: 'exited', code: outcome.code & 255 };
    case 'signaled':
      return { kind: 'signaled', signal: outcome.signal };
    case 'panicked':
      return { kind: 'exited', code: 101 };
    case 'guest-failure':
    case 'host-failure':
      return { kind: 'exited', code: 1 };
  }
}
export interface ProcessDeps {
  readonly resolver: ResolveCommand | undefined;
  readonly parent: BrowserHost;
  readonly io: BrowserIo;
  readonly vfs: MemoryVfs;
  readonly tree: ProcessTree;
  child(request: SpawnRequest, io: BrowserIo, control: BrowserControl, pid: number): BrowserHost;
}
export function browserProcess(deps: ProcessDeps): ProcessPort {
  return {
    spawn: async (request): Promise<Result<ChildProcess, HostError>> => {
      if (deps.resolver === undefined) return err({ code: 'ENOSYS' });
      if (treeClosed(deps.tree)) return err({ code: 'EINTR' });
      if (request.extraFds.length > 0) return err({ code: 'ENOSYS' });
      const cwd = deps.parent.files.realpath(request.cwd ?? '.');
      if (!cwd.ok) return cwd;
      const kind = deps.parent.fs.kind(cwd.value);
      if (!kind.ok) return kind;
      if (kind.value !== 'dir') return err({ code: 'ENOTDIR' });
      let wasm: Uint8Array | WebAssembly.Module | undefined;
      try {
        wasm = await deps.resolver(request.program, request.argv.slice(1), {
          cwd: cwd.value,
          env: childEnvironment(request.env),
        });
      } catch {
        return err({ code: 'EIO' });
      }
      if (treeClosed(deps.tree)) return err({ code: 'EINTR' });
      if (wasm === undefined) return err({ code: 'ENOENT' });
      const owned: HostFd[] = [];
      const readers: BrowserStdin[] = [];
      const duplicate = (raw: number): HostFd => {
        const result = deps.vfs.duplicate(raw as HostFd);
        if (!result.ok) throw result.error;
        owned.push(result.value);
        return result.value;
      };
      let input: BrowserStdin | undefined;
      let stdout: BrowserOutput | undefined;
      let stderr: BrowserOutput | undefined;
      try {
        const inputSpec = request.stdio[0];
        let stdin: ByteReader;
        if (inputSpec.kind === 'pipe') {
          input = new BrowserStdin();
          stdin = input;
          readers.push(input);
        } else if (inputSpec.kind === 'inherit' || (inputSpec.kind === 'fd' && inputSpec.fd === 0))
          stdin = deps.io.stdin;
        else if (inputSpec.kind === 'fd' && inputSpec.fd >= 3) {
          const fd = duplicate(inputSpec.fd);
          const read = (buffer: Uint8Array): number => {
            const r = deps.parent.files.read(fd, buffer);
            if (!r.ok) throw r.error;
            return r.value;
          };
          stdin = { read, readAsync: async (buffer) => read(buffer) };
        } else return err({ code: 'EBADF' });
        const output = (index: 1 | 2) => {
          const spec = request.stdio[index];
          if (spec.kind === 'pipe' || spec.kind === 'stdout') {
            const stream = new BrowserOutput();
            if (index === 1) stdout = stream;
            else stderr = stream;
            return stream;
          }
          if (spec.kind === 'inherit') return index === 1 ? deps.io.stdout : deps.io.stderr;
          if (spec.fd === 1) return deps.io.stdout;
          if (spec.fd === 2) return deps.io.stderr;
          if (spec.fd < 3) throw { code: 'EBADF' };
          const fd = duplicate(spec.fd);
          return callbackWriter((bytes) => {
            const r = deps.parent.files.write(fd, bytes);
            if (!r.ok) throw r.error;
          });
        };
        const out = output(1);
        const error = request.stdio[2].kind === 'stdout' ? out : output(2);
        const io: BrowserIo = { stdin, stdout: out, stderr: error };
        const releaseOut = out.retain();
        const releaseError = error === out ? () => {} : error.retain();
        const pid = allocatePid();
        const control = new BrowserControl();
        deps.tree.controls.set(pid, control);
        const host = deps.child({ ...request, cwd: cwd.value }, io, control, pid);
        let exit: ChildExit | undefined;
        const exits: ((exit: ChildExit) => void)[] = [];
        const process: ChildProcess = {
          pid,
          stdin: input?.input,
          stdout,
          stderr,
          onExit: (f) => {
            if (exit === undefined) exits.push(f);
            else f(exit);
          },
          unref: () => {},
        };
        // Publication and bridge attachment happen before any child guest code executes.
        setTimeout(() => {
          void (async () => {
            const outcome = await runBrowserGuest(
              wasm,
              request.argv[0] ?? request.program,
              request.argv.slice(1),
              host,
              control,
              io,
            );
            if (outcome.kind === 'host-failure') {
              try {
                host.stdio.writeStderr(
                  new TextEncoder().encode(
                    `Error: ${outcome.failure.chain.join('\nCaused by: ')}\n`,
                  ),
                );
              } catch {
                /* A closed stderr must still publish the exit. */
              }
            }
            releaseOut();
            releaseError();
            for (const reader of readers) reader.close();
            for (const fd of owned) deps.parent.files.close(fd);
            deps.tree.controls.delete(pid);
            exit = childExit(outcome);
            for (const f of exits.splice(0)) f(exit);
          })();
        }, 0);
        return ok(process);
      } catch (e) {
        for (const fd of owned) deps.parent.files.close(fd);
        return err(
          typeof e === 'object' && e !== null && 'code' in e ? (e as HostError) : { code: 'EIO' },
        );
      }
    },
    kill: (pid, signal) => {
      if (deps.resolver === undefined) return err({ code: 'ENOSYS' });
      const control = deps.tree.controls.get(pid);
      if (control === undefined) return err({ code: 'ESRCH' });
      if (signal === 0) return ok(undefined);
      if (![1, 2, 9, 15].includes(signal))
        return err({ code: signal < 1 || signal > 64 ? 'EINVAL' : 'ENOSYS' });
      control.send(signal);
      return ok(undefined);
    },
    openPolicyTransfer: () => err({ code: 'ENOSYS' }),
    closeFd: () => {},
  };
}
