import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeProcess } from '../../src/hosts/node/process.ts';
import { CompletionSource } from '../../src/kernel/completion.ts';
import { Job } from '../../src/kernel/job.ts';
import type { Execution } from '../../src/kernel/job-runner.ts';
import { makePipe } from '../../src/kernel/pipe.ts';
import { Children, drainChild, feedChild } from '../../src/kernel/process.ts';
import { type ProcessEnvironment, startProcessJob } from '../../src/kernel/process-jobs.ts';
import { RunSignals, SigwaitSink } from '../../src/kernel/signals.ts';
import type {
  ChildExit,
  ChildInput,
  ChildOutput,
  ChildProcess,
  ProcessPort,
  SpawnRequest,
} from '../../src/ports/process.ts';
import { err, ok } from '../../src/ports/result.ts';
import { flush } from './kernel-fakes.ts';

function child() {
  let exit: ((e: ChildExit) => void) | undefined;
  const process: ChildProcess = {
    pid: 42,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    onExit: (f) => {
      exit = f;
    },
    unref: () => {},
  };
  return { process, exit: (e: ChildExit) => exit?.(e) };
}
function env() {
  const requests: SpawnRequest[] = [];
  const closed: number[] = [];
  const c = child();
  const port: ProcessPort = {
    spawn: (r) => {
      requests.push(r);
      return Promise.resolve(ok(c.process));
    },
    kill: () => ok(undefined),
    openPolicyTransfer: () => ok(71),
    closeFd: (fd) => {
      closed.push(fd);
    },
  };
  const environment: ProcessEnvironment = {
    port,
    children: new Children(),
    authorizeSpawn: undefined,
    inheritance: undefined,
    authority: undefined,
  };
  return { environment, c, requests, closed };
}
function spawnJob(program = '/bin/echo'): Job {
  return new Job({
    kind: 'spawn',
    program,
    argv: [program, 'hello'],
    env: ['A=B', 'MOONRUN_INHERITED_POLICY=99'],
    stdio: [undefined, undefined, undefined],
    cwd: undefined,
    result: undefined,
  });
}

describe('process Jobs', () => {
  it('checks policy at execution before any host operation', async () => {
    const s = env();
    const j = spawnJob();
    let done = 0;
    startProcessJob(
      j,
      j.payload as Extract<Job['payload'], { kind: 'spawn' }>,
      { ...s.environment, authorizeSpawn: () => ({ kind: 'permission-denied' }) },
      () => {
        done++;
      },
    );
    await flush();
    expect(s.requests).toHaveLength(0);
    expect(done).toBe(1);
    expect(j.err).toEqual({ kind: 'permission-denied' });
  });
  it('passes anonymous policy fd 3 only to moonx, overwriting guest input', async () => {
    const s = env();
    const j = spawnJob('/path/moonx');
    let done = 0;
    if (j.payload.kind !== 'spawn') throw new Error('fixture');
    startProcessJob(
      j,
      j.payload,
      { ...s.environment, inheritance: () => new Uint8Array([123, 125]) },
      () => {
        done++;
      },
    );
    await flush();
    expect(done).toBe(1);
    expect(j.ret).toBe(42);
    expect(s.requests[0]?.extraFds).toEqual([71]);
    expect(s.requests[0]?.env).toContain('MOONRUN_INHERITED_POLICY=3');
    expect(s.closed).toEqual([71]);
    const ordinary = spawnJob();
    if (ordinary.payload.kind !== 'spawn') throw new Error('fixture');
    startProcessJob(
      ordinary,
      ordinary.payload,
      {
        ...s.environment,
        inheritance: () => {
          throw new Error('must not be used');
        },
      },
      () => {},
    );
    await flush();
    expect(s.requests[1]?.extraFds).toEqual([]);
  });
  it('closes policy transfer on spawn failure and preserves errno', async () => {
    const s = env();
    const j = spawnJob('moonx');
    if (j.payload.kind !== 'spawn') throw new Error('fixture');
    const failed = {
      ...s.environment.port,
      spawn: () => Promise.resolve(err({ code: 'ENOENT' as const })),
    };
    startProcessJob(
      j,
      j.payload,
      { ...s.environment, port: failed, inheritance: () => new Uint8Array() },
      () => {},
    );
    await flush();
    expect(s.closed).toEqual([71]);
    expect(j.err).toEqual({ kind: 'native', code: 'ENOENT' });
  });
  it('stops parent PATH lookup on ELOOP instead of trying a later executable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'moonrun-path-'));
    const saved = process.env['PATH'];
    try {
      mkdirSync(path.join(dir, 'loop'));
      mkdirSync(path.join(dir, 'bin'));
      symlinkSync('run', path.join(dir, 'loop/run'));
      symlinkSync('/bin/true', path.join(dir, 'bin/run'));
      process.env['PATH'] = `${dir}/loop:${dir}/bin`;
      const result = await nodeProcess().spawn({
        program: 'run',
        argv: ['run'],
        env: [],
        cwd: undefined,
        stdio: [{ kind: 'inherit' }, { kind: 'inherit' }, { kind: 'inherit' }],
        extraFds: [],
      });
      expect(result).toEqual(err({ code: 'ELOOP' }));
    } finally {
      if (saved === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a real inherited policy descriptor positioned at byte zero', async () => {
    const port = nodeProcess();
    const bytes = new TextEncoder().encode('{"policy":"test"}');
    const transfer = port.openPolicyTransfer(bytes);
    if (!transfer.ok) throw new Error(transfer.error.code);
    const spawned = await port.spawn({
      program: '/bin/cat',
      argv: ['cat', '/proc/self/fd/3'],
      env: [],
      cwd: undefined,
      stdio: [{ kind: 'inherit' }, { kind: 'pipe' }, { kind: 'inherit' }],
      extraFds: [transfer.value],
    });
    port.closeFd(transfer.value);
    if (!spawned.ok) throw new Error(spawned.error.code);
    const output = spawned.value.stdout;
    if (output === undefined) throw new Error('missing stdout');
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve) => {
      output.onData((b) => {
        chunks.push(b.slice());
      });
      output.onEnd(resolve);
    });
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('{"policy":"test"}');
  });

  it('waits, encodes signal exit, and reaps exactly once; cancellation does not reap', () => {
    const s = env();
    const c = s.environment.children.add(42, s.c.process);
    const job = () =>
      new Job({ kind: 'wait-for-process', pid: 42, resource: undefined, trackedPid: undefined });
    const start = (j: Job): Execution => {
      if (j.payload.kind !== 'wait-for-process') throw new Error('fixture');
      return startProcessJob(j, j.payload, s.environment, () => {});
    };
    const cancelled = job();
    expect(start(cancelled).interrupt()).toBe(true);
    expect(cancelled.err).toEqual({ kind: 'native', code: 'EINTR' });
    expect(c.reaped).toBe(false);
    const waited = job();
    start(waited);
    s.c.exit({ kind: 'signaled', signal: 15 });
    expect(waited.ret).toBe(-15);
    expect(c.reaped).toBe(true);
    const again = job();
    start(again);
    expect(again.err).toEqual({ kind: 'native', code: 'ECHILD' });
  });
});

describe('child pipe bridges', () => {
  it('pauses a child output until the full kernel pipe drains', () => {
    const [reader, writer] = makePipe(true, true);
    const children = new Children();
    let data: ((bytes: Uint8Array) => void) | undefined;
    let end: (() => void) | undefined;
    let pauses = 0;
    let resumes = 0;
    const output: ChildOutput = {
      onData: (f) => {
        data = f;
      },
      onEnd: (f) => {
        end = f;
      },
      pause: () => {
        pauses++;
      },
      resume: () => {
        resumes++;
      },
      destroy: () => {},
    };
    drainChild(children, writer, output);
    writer.release();
    const input = Uint8Array.from({ length: 150000 }, (_, i) => i & 255);
    data?.(input);
    expect(pauses).toBeGreaterThan(0);
    const got: number[] = [];
    const buffer = new Uint8Array(32000);
    while (got.length < input.length) {
      const r = reader.read(buffer);
      if (!r.ok) throw new Error(r.error);
      if (r.value === 0) break;
      got.push(...buffer.subarray(0, r.value));
    }
    end?.();
    expect(reader.read(buffer)).toEqual(ok(0));
    expect(Uint8Array.from(got)).toEqual(input);
    expect(resumes).toBeGreaterThan(0);
    reader.release();
    children.teardown();
  });
  it('respects child stdin backpressure and retains the read end until EOF', () => {
    const [reader, writer] = makePipe(true, true);
    const children = new Children();
    let drain: (() => void) | undefined;
    let ended = false;
    let calls = 0;
    const received: number[] = [];
    const input: ChildInput = {
      write: (b) => {
        calls++;
        received.push(...b);
        return false;
      },
      onDrain: (f) => {
        drain = f;
      },
      end: () => {
        ended = true;
      },
      onClose: () => {},
      destroy: () => {},
    };
    feedChild(children, reader, input);
    reader.release();
    expect(writer.write(new Uint8Array([1, 2])).ok).toBe(true);
    expect(writer.write(new Uint8Array([3, 4])).ok).toBe(true);
    expect(calls).toBe(1);
    writer.release();
    expect(ended).toBe(false);
    drain?.();
    expect(calls).toBe(2);
    drain?.();
    expect(ended).toBe(true);
    expect(received).toEqual([1, 2, 3, 4]);
    children.teardown();
  });
});

describe('scoped cancellation signals', () => {
  it('captures only selected broker signals, merges them, and removes listeners', () => {
    const captures = new Map<number, () => void>();
    const signals = new RunSignals({
      capture: (s, f) => {
        captures.set(s, f);
        return () => {
          captures.delete(s);
        };
      },
      raise: () => {
        throw new Error('unexpected default action');
      },
    });
    const source = new CompletionSource();
    signals.configure([1, 2, 15], [2, 15]);
    expect(captures.size).toBe(0);
    expect(signals.start(source).ok).toBe(true);
    expect([...captures.keys()]).toEqual([2, 15]);
    captures.get(15)?.();
    captures.get(2)?.();
    captures.get(2)?.();
    expect(source.fetch(10)).toEqual([0x80000002 | 0, 0x8000000f | 0]);
    signals.stop();
    expect(captures.size).toBe(0);
  });
  it('routes the legacy sigwait target until its Job is detached', () => {
    const signals = new RunSignals();
    const source = new CompletionSource();
    signals.configure([1, 2, 15], [2]);
    const sink = new SigwaitSink([2], source);
    expect(sink.attach(signals)).toBe(true);
    expect(signals.deliver(2)).toBe(true);
    sink.run();
    expect(source.fetch(10)).toEqual([0x80000002 | 0]);
    sink.cancel();
    sink.detach();
    expect(signals.deliver(2)).toBe(false);
  });
});
