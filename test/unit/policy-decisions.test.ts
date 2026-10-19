import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { osCapabilities } from '../../src/abi/os-capabilities.ts';
import { ChildAuthority, isMoonxExecutable } from '../../src/domains/policy/child-authority.ts';
import { PolicyComponent } from '../../src/domains/policy/component.ts';
import { POLICY_URL } from '../../src/domains/policy/policy-url.ts';
import { nodeComponentModule } from '../../src/hosts/node/components.ts';
import { nodeHost } from '../../src/hosts/node/index.ts';
import type { HostFile } from '../../src/kernel/file.ts';
import type { FilesystemPayload } from '../../src/kernel/job.ts';
import type { Resource } from '../../src/kernel/resource.ts';

// The decisions of moonrun's policy/** and filesystem/mod.rs (the moonrun-policy
// component) as the kernel and the legacy imports consult them. Exact load-error texts
// are checked against the reference moonrun in policy-diff.test.ts.

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'policy-decisions-')));
mkdirSync(path.join(root, 'read'));
mkdirSync(path.join(root, 'write'));
mkdirSync(path.join(root, 'other'));
writeFileSync(path.join(root, 'read/a.txt'), 'a');
symlinkSync(path.join(root, 'other'), path.join(root, 'read/escape'));
symlinkSync(path.join(root, 'read'), path.join(root, 'other/into-read'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Loaded {
  readonly policy: PolicyComponent;
  readonly stderr: () => string;
}

function load(text: string, file = 'policy.toml', env: NodeJS.ProcessEnv = {}): Loaded {
  writeFileSync(path.join(root, file), text);
  const module = nodeComponentModule(POLICY_URL);
  if (!module.ok) {
    throw new Error('component');
  }
  let stderr = '';
  const ambient = nodeHost({ cwd: root });
  const host = {
    ...ambient,
    env: {
      get: (k: string) => env[k],
      entries: () =>
        Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const])),
      set: () => {},
      unset: () => {},
    },
  };
  const policy = new PolicyComponent(
    module.value,
    osCapabilities(host, (b) => {
      stderr += Buffer.from(b).toString();
    }),
  );
  const r = policy.loadFile(path.join(root, file));
  if (!r.ok) {
    throw new Error(r.error.chain.join('\n'));
  }
  return {
    policy,
    stderr: () => {
      const out = stderr;
      stderr = '';
      return out;
    },
  };
}

const at = (p: string): string => path.join(root, p);
const fileResource = (canonicalPath: string | undefined): Resource => ({
  kind: 'file',
  file: { canonicalPath } as HostFile,
});
const open = (p: string, access: number, create = 0): FilesystemPayload =>
  ({
    kind: 'open',
    path: p,
    access,
    create,
    append: false,
    sync: 0,
    mode: 0o666,
    request: { mask: 0x0d },
    result: undefined,
  }) as unknown as FilesystemPayload;

describe('filesystem decisions', () => {
  const { policy, stderr } = load('[fs]\nread = ["read"]\nwrite = ["write"]\n');

  it('allows reads under read roots, including missing files, and quotes the path as given', () => {
    expect(policy.checkJob(open(at('read/a.txt'), 0))).toBeUndefined();
    expect(policy.checkJob(open(at('read/missing'), 0))).toBeUndefined();
    expect(policy.checkJob(open(at('other/x'), 0))).toEqual({ kind: 'permission-denied' });
    expect(stderr()).toBe(`Sandbox policy blocked file read: "${at('other/x')}"\n`);
  });

  it('keeps read and write roots separate; open intents follow the flags', () => {
    expect(policy.checkJob(open(at('read/a.txt'), 1))).toEqual({ kind: 'permission-denied' });
    expect(policy.checkJob(open(at('write/new'), 1, 1))).toBeUndefined();
    expect(policy.checkJob(open(at('write/new'), 0))).toEqual({ kind: 'permission-denied' });
    expect(stderr()).toBe(
      `Sandbox policy blocked file write: "${at('read/a.txt')}"\nSandbox policy blocked file read: "${at('write/new')}"\n`,
    );
  });

  it('follows symlinks for paths; entries (remove, rename) are not followed', () => {
    expect(policy.checkJob(open(at('read/escape/x'), 0))).toEqual({ kind: 'permission-denied' });
    expect(policy.checkJob(open(at('other/into-read/a.txt'), 0))).toBeUndefined();
    expect(policy.checkJob({ kind: 'remove', path: at('write/x') })).toBeUndefined();
    expect(
      policy.checkJob({ kind: 'rename', from: at('write/a'), to: at('read/b'), replace: true }),
    ).toEqual({ kind: 'permission-denied' });
    stderr();
  });

  it('fd-based Jobs use the canonical path recorded at open; no file is EBADF', () => {
    const payload = (resource: Resource): FilesystemPayload =>
      ({
        kind: 'fstatx',
        resource,
        request: { mask: 1 },
        result: undefined,
      }) as unknown as FilesystemPayload;
    expect(policy.checkJob(payload(fileResource(at('read/a.txt'))))).toBeUndefined();
    expect(policy.checkJob(payload(fileResource(undefined)))).toEqual({
      kind: 'permission-denied',
    });
    expect(stderr()).toBe('Sandbox policy blocked file read: "<untracked resource>"\n');
    expect(policy.checkJob(payload({ kind: 'invalid' }))).toEqual({ kind: 'badf' });
  });

  it('locks: shared needs nothing, exclusive needs write', () => {
    const flock = (exclusive: boolean): FilesystemPayload => ({
      kind: 'flock',
      resource: fileResource(at('read/a.txt')),
      exclusive,
    });
    expect(policy.checkJob(flock(false))).toBeUndefined();
    expect(policy.checkJob(flock(true))).toEqual({ kind: 'permission-denied' });
    stderr();
  });

  it('read/write/fsync Jobs are not checked', () => {
    expect(
      policy.checkJob({ kind: 'fsync', resource: fileResource(undefined), dataOnly: false }),
    ).toBeUndefined();
  });

  it('the Host Filesystem reports denials as `Permission denied: <path>`', () => {
    expect(policy.readFileToString('other/x')).toEqual({
      ok: false,
      error: 'Permission denied: other/x',
    });
    expect(policy.readFileToString('read/a.txt')).toEqual({ ok: true, value: 'a' });
    expect(policy.writeBytesToFile('read/b', undefined)).toEqual({
      ok: false,
      error: 'Permission denied: read/b',
    });
    expect(policy.writeBytesToFile('write/b', undefined)).toBe('not-bytes');
    expect(stderr()).toBe(
      'Sandbox policy blocked file read: "other/x"\nSandbox policy blocked file write: "read/b"\n',
    );
  });
});

describe('network decisions', () => {
  const { policy, stderr } = load(
    '[net]\ndns = ["*.example.com"]\nconnect = ["api.test:443", "[::1]:*"]\nbind = ["127.0.0.1:0"]\n',
  );
  const v4 = (ip: number[], port: number) => ({
    family: 4 as const,
    ip: Uint8Array.from(ip),
    port,
    flowInfo: 0,
    scopeId: 0,
  });

  it('dns wildcard matches only subdomains; hostname connect rules allow lookup', () => {
    expect(policy.checkNetwork({ kind: 'dns', host: 'a.example.com' })).toBeUndefined();
    expect(policy.checkNetwork({ kind: 'dns', host: 'example.com' })).toEqual({
      kind: 'permission-denied',
    });
    expect(policy.checkNetwork({ kind: 'dns', host: 'API.test.' })).toBeUndefined();
    expect(stderr()).toBe('Sandbox policy blocked DNS lookup: "example.com"\n');
  });

  it('connects to the resolved addresses of a hostname rule, on its port', () => {
    const addr = v4([10, 0, 0, 1], 443);
    expect(policy.checkNetwork({ kind: 'connect', address: addr })).toEqual({
      kind: 'permission-denied',
    });
    const sockaddr = new Uint8Array(16);
    new DataView(sockaddr.buffer).setUint16(0, 2, true);
    sockaddr.set([10, 0, 0, 1], 4);
    policy.recordResolved('api.test', [sockaddr]);
    expect(policy.checkNetwork({ kind: 'connect', address: addr })).toBeUndefined();
    expect(policy.checkNetwork({ kind: 'connect', address: v4([10, 0, 0, 1], 80) })).toEqual({
      kind: 'permission-denied',
    });
    expect(stderr()).toBe(
      'Sandbox policy blocked network connect: "10.0.0.1:443"\nSandbox policy blocked network connect: "10.0.0.1:80"\n',
    );
  });

  it('formats IPv6 targets the way Rust does; bind rules are separate', () => {
    const v6 = (last: number, port: number) => {
      const ip = new Uint8Array(16);
      ip[15] = last;
      return { family: 6 as const, ip, port, flowInfo: 0, scopeId: 0 };
    };
    expect(policy.checkNetwork({ kind: 'connect', address: v6(1, 9) })).toBeUndefined();
    expect(policy.checkNetwork({ kind: 'connect', address: v6(2, 9) })).toEqual({
      kind: 'permission-denied',
    });
    expect(policy.checkNetwork({ kind: 'bind', address: v4([127, 0, 0, 1], 0) })).toBeUndefined();
    expect(policy.checkNetwork({ kind: 'bind', address: v4([127, 0, 0, 1], 80) })).toEqual({
      kind: 'permission-denied',
    });
    expect(stderr()).toBe(
      'Sandbox policy blocked network connect: "[::2]:9"\nSandbox policy blocked network bind: "127.0.0.1:80"\n',
    );
  });
});

describe('process decisions', () => {
  it('matches program and complete argument tokens', () => {
    const { policy, stderr } = load(
      '[[process.allow]]\nprogram = "git"\nargs_prefix = ["status"]\n',
    );
    expect(policy.checkSpawn('git', ['git', 'status', '-s'])).toBeUndefined();
    expect(policy.checkSpawn('git', ['git', 'statusx'])).toEqual({ kind: 'permission-denied' });
    expect(policy.checkSpawn('git', ['other', 'status'])).toEqual({ kind: 'permission-denied' });
    expect(stderr()).toBe('Sandbox policy blocked process spawn\n'.repeat(2));
  });

  it('recognizes moonx', () => {
    expect(isMoonxExecutable('/opt/bin/moonx')).toBe(true);
    expect(isMoonxExecutable('moonx.exe')).toBe(true);
    expect(isMoonxExecutable('moonxx')).toBe(false);
  });

  it('tracks child ownership like moonrun', () => {
    const c = new ChildAuthority();
    expect(c.checkOwned(10).ok).toBe(false);
    c.trackSpawned(10);
    expect(c.checkOwned(10).ok).toBe(true);
    c.trackHandle(1n, 10);
    expect(c.checkWait(true, 10, 10).ok).toBe(true);
    expect(c.checkWait(true, 10, 11).ok).toBe(false);
    expect(c.checkWait(false, undefined, 10).ok).toBe(true);
    expect(c.checkWait(false, 10, 10).ok).toBe(false);
    c.untrackHandle(1n);
    expect(c.checkOwned(10).ok).toBe(false);
  });
});

describe('environment provisioning and inheritance', () => {
  it('starts empty, copies named host variables, sets override, sorted by name', () => {
    const { policy } = load(
      '[env]\nfrom_host = ["PATH", "MISSING"]\n[env.set]\nB = "2"\nA = "1"\n',
      'env.toml',
      { PATH: '/bin', HOME: '/home/u' },
    );
    expect(policy.env().entries()).toEqual([
      ['A', '1'],
      ['B', '2'],
      ['PATH', '/bin'],
    ]);
    policy.env().set('C', '3');
    expect(policy.env().get('C')).toBe('3');
    policy.env().unset('A');
    expect(policy.env().get('A')).toBeUndefined();
  });

  it('serializes the inherited payload: canonical roots, env copies everything, no secrets', () => {
    const { policy } = load(
      '[env.set]\nSECRET = "s3cret"\n[fs]\nread = ["read"]\n',
      'inherit.toml',
    );
    const payload = Buffer.from(policy.inheritance() ?? new Uint8Array()).toString();
    expect(payload).not.toContain('s3cret');
    const json = JSON.parse(payload) as { fs: { read: string[] }; env: { from_host: string[] } };
    expect(json.fs.read).toEqual([at('read')]);
    expect(json.env.from_host).toEqual(['*']);
  });

  it('reads .mbtx front matter (full YAML)', () => {
    const { policy, stderr } = load(
      '// policy:\n//   fs: &roots\n//     read: [read]\n//   process: { spawn: true }\nfn main {}\n',
      'script.mbtx',
    );
    expect(policy.checkJob(open(at('read/a.txt'), 0))).toBeUndefined();
    expect(policy.checkSpawn('anything', ['anything'])).toBeUndefined();
    expect(stderr()).toBe('');
  });
});
