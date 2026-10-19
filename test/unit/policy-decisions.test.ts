import { describe, expect, it } from 'vitest';
import { rootsFromConfig } from '../../src/domains/policy/fs.ts';
import {
  authorizeSpawn,
  ChildAuthority,
  detectPolicyFormat,
  FsAuthority,
  type FsPolicy,
  formatIp,
  intentsForOpen,
  isMoonxExecutable,
  loadInheritedPolicy,
  loadPolicyFile,
  NetAuthority,
  type NetPolicy,
  type Policy,
  parseIp,
  provisionEnv,
  type SocketAddr,
} from '../../src/domains/policy/index.ts';
import { buildNetPolicy, dnsMatches, parseSocketRule } from '../../src/domains/policy/net.ts';
import type { CanonicalPort } from '../../src/domains/policy/paths.ts';
import {
  canonicalizeEntryPath,
  canonicalizeExistingPrefix,
  normalizePath,
  startsWithPath,
} from '../../src/domains/policy/paths.ts';
import { buildProcessPolicy } from '../../src/domains/policy/process.ts';
import { rustDebugStr } from '../../src/domains/policy/rust-fmt.ts';
import { extractMbtxFrontMatter } from '../../src/domains/policy/yaml.ts';
import { err, hostError, ok } from '../../src/ports/result.ts';

/** An in-memory tree: directories and files by absolute path, plus symlinks. */
function fakeFs(entries: string[], links: Record<string, string> = {}): CanonicalPort {
  const exists = new Set<string>(['/']);
  for (const e of entries) {
    const parts = e.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      exists.add(`/${parts.slice(0, i).join('/')}`);
    }
  }
  const real = (p: string, depth = 0): string | undefined => {
    if (depth > 8) {
      return undefined;
    }
    let cur = '';
    for (const part of p.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`;
      const target = links[cur];
      if (target !== undefined) {
        const resolved = real(target, depth + 1);
        if (resolved === undefined) {
          return undefined;
        }
        cur = resolved;
      } else if (!exists.has(cur)) {
        return undefined;
      }
    }
    return cur === '' ? '/' : cur;
  };
  return {
    realpath: (p) => {
      const r = p.startsWith('/') ? real(p) : undefined;
      return r === undefined ? err(hostError('ENOENT')) : ok(r);
    },
  };
}

const fsOf = (read: string[], write: string[]): FsPolicy => ({
  read: rootsFromConfig(read),
  write: rootsFromConfig(write),
});

function authority(policy: FsPolicy | undefined, canonical: CanonicalPort): FsAuthority {
  return new FsAuthority({
    policy,
    canonical,
    resolve: (p) => (p.startsWith('/') ? p : `/work/${p}`),
  });
}

const denied = (action: string, target?: string) => ({
  ok: false,
  error: {
    code: 'EACCES',
    report:
      target === undefined
        ? `Sandbox policy blocked ${action}`
        : `Sandbox policy blocked ${action}: ${target}`,
  },
});

describe('filesystem decisions', () => {
  const tree = fakeFs(['/work/allowed/x', '/work/denied/secret.txt', '/work/readonly'], {
    '/work/alias': '/work/allowed',
    '/work/escape': '/work/denied',
  });

  it('allows a missing file under an allowed root', () => {
    const a = authority(fsOf([], ['/work/allowed']), tree);
    expect(a.authorizeOpen('allowed/new.txt', 1, 0, false).ok).toBe(true);
  });

  it('keeps read and write roots separate', () => {
    const a = authority(fsOf(['/work/allowed'], []), tree);
    expect(a.authorizeRead('allowed/new.txt').ok).toBe(true);
    expect(a.authorizeWrite('allowed/new.txt')).toEqual(denied('file write', '"allowed/new.txt"'));
    // create mode needs write even for read access
    expect(a.authorizeOpen('allowed/new.txt', 0, 1, false)).toEqual(
      denied('file write', '"allowed/new.txt"'),
    );
    const w = authority(fsOf([], ['/work/allowed']), tree);
    expect(w.authorizeRead('allowed/x')).toEqual(denied('file read', '"allowed/x"'));
  });

  it('quotes the path as the guest wrote it', () => {
    const a = authority(fsOf([], ['/work/allowed']), tree);
    expect(a.authorizeWrite('denied.bin')).toEqual(denied('file write', '"denied.bin"'));
    expect(a.authorizeRead('we"ird\n')).toEqual(denied('file read', '"we\\"ird\\n"'));
  });

  it('is component-wise and follows symlinks', () => {
    const a = authority(fsOf(['/work/allowed'], []), fakeFs(['/work/allowed', '/work/allowedx']));
    expect(a.authorizeRead('/work/allowedx/f').ok).toBe(false);
    const b = authority(fsOf(['/work/allowed'], []), tree);
    expect(b.authorizeRead('alias/x').ok).toBe(true);
    expect(b.authorizeRead('escape/secret.txt').ok).toBe(false);
    expect(b.authorizeRead('allowed/../denied/secret.txt').ok).toBe(false);
  });

  it('remove and rename act on the entry, not on a symlink target', () => {
    const a = authority(fsOf([], ['/work/allowed']), tree);
    // `alias` lives in /work (not allowed) even though it points into the allowed root.
    expect(a.authorizeRemove('alias').ok).toBe(false);
    expect(a.authorizeRemove('allowed/x').ok).toBe(true);
    expect(a.authorizeRename('allowed/x', 'denied/y').ok).toBe(false);
    expect(a.authorizeRename('allowed/x', 'allowed/y').ok).toBe(true);
  });

  it('wildcard allows everything; empty lists deny; untracked resources are denied', () => {
    expect(authority(fsOf([], ['*']), tree).authorizeWrite('denied/new').ok).toBe(true);
    expect(authority(fsOf([], []), tree).authorizeWrite('allowed/new')).toEqual(
      denied('file write', '"allowed/new"'),
    );
    const any = authority(fsOf(['*'], ['*']), tree);
    expect(any.authorizeResourceMetadata(undefined)).toEqual(
      denied('file read', '"<untracked resource>"'),
    );
    expect(any.authorizeMetadataAt(undefined, 'rel', true)).toEqual(
      denied('file read', '"<untracked resource>"'),
    );
  });

  it('locks: shared needs nothing, exclusive needs write', () => {
    const a = authority(fsOf(['/work/readonly'], []), tree);
    expect(a.authorizeResourceLock('/work/readonly', false).ok).toBe(true);
    expect(a.authorizeResourceLock('/work/readonly', true)).toEqual(
      denied('file write', '"/work/readonly"'),
    );
  });

  it('no policy never consults the filesystem', () => {
    const port: CanonicalPort = {
      realpath: () => {
        throw new Error('must not be called');
      },
    };
    expect(authority(undefined, port).authorizeWrite('anything').ok).toBe(true);
  });

  it('maps open flags to intents', () => {
    expect(intentsForOpen(0, 0, false)).toEqual({ read: true, write: false });
    expect(intentsForOpen(3, 0, false)).toEqual({ read: true, write: false });
    expect(intentsForOpen(1, 0, false)).toEqual({ read: false, write: true });
    expect(intentsForOpen(2, 0, false)).toEqual({ read: true, write: true });
    expect(intentsForOpen(0, 4, false)).toEqual({ read: true, write: true });
    expect(intentsForOpen(0, 0, true)).toEqual({ read: true, write: true });
  });

  it('canonicalizes the longest existing prefix and normalizes the rest', () => {
    const t = fakeFs(['/a/b'], { '/l': '/a' });
    expect(canonicalizeExistingPrefix(t, '/l/b/new/../x')).toEqual(ok('/a/b/x'));
    expect(canonicalizeEntryPath(t, '/l')).toEqual(ok('/l'));
    expect(canonicalizeEntryPath(t, '/')).toEqual(err({ unresolved: true }));
    expect(canonicalizeExistingPrefix(t, 'relative').ok).toBe(false);
    expect(normalizePath('/a/./b/../../..')).toBe('/');
    expect(startsWithPath('/a/bc', '/a/b')).toBe(false);
  });
});

const netOf = (cfg: { dns?: string[]; connect?: string[]; bind?: string[] }): NetPolicy => {
  const r = buildNetPolicy({
    dns: cfg.dns ?? [],
    connect: cfg.connect ?? [],
    bind: cfg.bind ?? [],
  });
  if (!r.ok) {
    throw new Error(r.error.join(' / '));
  }
  return r.value;
};
const addr = (text: string, port: number): SocketAddr => {
  const ip = parseIp(text);
  if (ip === undefined) {
    throw new Error(text);
  }
  return { ip, port };
};

describe('network decisions', () => {
  it('dns wildcard matches only subdomains', () => {
    const p = netOf({ dns: ['*.example.com'] }).dns[0];
    expect(p && dnsMatches(p, 'api.example.com')).toBe(true);
    expect(p && dnsMatches(p, 'example.com')).toBe(false);
    expect(p && dnsMatches(p, 'notexample.com')).toBe(false);
  });

  it('hostname connect rules allow lookup and the addresses it resolved to', () => {
    const net = new NetAuthority(netOf({ connect: ['api.deepseek.com:443'] }));
    expect(net.authorizeDns('API.DEEPSEEK.COM.').ok).toBe(true);
    net.recordResolved('api.deepseek.com', [addr('127.0.0.1', 0).ip]);
    expect(net.authorizeConnect(addr('127.0.0.1', 443)).ok).toBe(true);
    expect(net.authorizeConnect(addr('127.0.0.1', 80))).toEqual(
      denied('network connect', '"127.0.0.1:80"'),
    );
  });

  it('resolved addresses are only learned for hostname rules and are per authority', () => {
    const policy = netOf({ connect: ['*:443', '10.0.0.1:80'] });
    const a = new NetAuthority(policy);
    a.recordResolved('anything.example', [addr('127.0.0.1', 0).ip]);
    expect(a.authorizeConnect(addr('127.0.0.1', 443)).ok).toBe(true); // via *:443 itself
    expect(a.authorizeConnect(addr('127.0.0.1', 80)).ok).toBe(false);
    const named = netOf({ connect: ['a.example:443'] });
    const first = new NetAuthority(named);
    first.recordResolved('a.example', [addr('127.0.0.1', 0).ip]);
    expect(new NetAuthority(named).authorizeConnect(addr('127.0.0.1', 443)).ok).toBe(false);
  });

  it('dns rules do not allow connects; bind rules do not allow connects', () => {
    const net = new NetAuthority(netOf({ dns: ['api.deepseek.com'], bind: ['127.0.0.1:8080'] }));
    expect(net.authorizeDns('api.deepseek.com').ok).toBe(true);
    expect(net.authorizeConnect(addr('127.0.0.1', 443)).ok).toBe(false);
    expect(net.authorizeBind(addr('127.0.0.1', 8080)).ok).toBe(true);
    expect(net.authorizeConnect(addr('127.0.0.1', 8080)).ok).toBe(false);
    expect(net.authorizeBind(addr('127.0.0.1', 0))).toEqual(
      denied('network bind', '"127.0.0.1:0"'),
    );
  });

  it('subdomain connect rules do not match the parent domain', () => {
    const net = new NetAuthority(netOf({ connect: ['*.example.com:443'] }));
    expect(net.authorizeDns('api.example.com').ok).toBe(true);
    expect(net.authorizeDns('example.com')).toEqual(denied('DNS lookup', '"example.com"'));
  });

  it('wildcard connect allows any lookup and connect', () => {
    const net = new NetAuthority(netOf({ connect: ['*:*'] }));
    expect(net.authorizeDns('api.deepseek.com').ok).toBe(true);
    expect(net.authorizeConnect(addr('::1', 9)).ok).toBe(true);
  });

  it('an ip connect rule allows lookup of that literal only', () => {
    const net = new NetAuthority(netOf({ connect: ['127.0.0.1:80'] }));
    expect(net.authorizeDns('127.0.0.1').ok).toBe(true);
    expect(net.authorizeDns('127.0.0.2').ok).toBe(false);
  });

  it('formats IPv6 targets the way Rust does', () => {
    const net = new NetAuthority(netOf({}));
    expect(net.authorizeConnect(addr('::1', 443))).toEqual(
      denied('network connect', '"[::1]:443"'),
    );
    expect(formatIp(parseIp('2001:0db8:0:0:0:0:0:1') ?? addr('::', 0).ip)).toBe('2001:db8::1');
    expect(formatIp(parseIp('::ffff:1.2.3.4') ?? addr('::', 0).ip)).toBe('::ffff:1.2.3.4');
    expect(formatIp(parseIp('1:0:2:0:3:0:4:0') ?? addr('::', 0).ip)).toBe('1:0:2:0:3:0:4:0');
    expect(parseIp('01.2.3.4')).toBeUndefined();
    expect(parseIp('fe80::1%eth0')).toBeUndefined();
  });

  it('rule syntax and errors match moonrun', () => {
    expect(parseSocketRule('[::1]:443').ok).toBe(true);
    expect(parseSocketRule('::1:443')).toEqual(
      err(['IPv6 socket policy rules must use [addr]:port syntax']),
    );
    expect(parseSocketRule('a:b')).toEqual(
      err(['invalid socket policy port "b"', 'invalid digit found in string']),
    );
    expect(parseSocketRule('a:70000')).toEqual(
      err(['invalid socket policy port "70000"', 'number too large to fit in target type']),
    );
    expect(parseSocketRule('a:')).toEqual(
      err(['invalid socket policy port ""', 'cannot parse integer from empty string']),
    );
    expect(parseSocketRule('a')).toEqual(err(['socket policy rules must include a port']));
    expect(buildNetPolicy({ dns: [''], connect: [], bind: [] })).toEqual(
      err(['empty DNS policy pattern']),
    );
    expect(buildNetPolicy({ dns: [], connect: [], bind: ['localhost:8080'] })).toEqual(
      err(['bind policy rules must use an IP address or *']),
    );
    expect(buildNetPolicy({ dns: ['*.'], connect: [], bind: [] }).ok).toBe(true);
  });
});

describe('process decisions', () => {
  const scoped = (program: string, argsPrefix: string[]) => {
    const r = buildProcessPolicy({ spawn: false, allow: [{ program, argsPrefix }] });
    if (!r.ok) {
      throw new Error('bad');
    }
    return r.value;
  };

  it('matches program and complete argument tokens', () => {
    const p = scoped('git', ['status']);
    expect(authorizeSpawn(p, 'git', ['git', 'status', '--short']).ok).toBe(true);
    expect(authorizeSpawn(p, 'git', ['git'])).toEqual(denied('process spawn'));
    expect(authorizeSpawn(p, 'git', ['git', 'status-long']).ok).toBe(false);
    expect(authorizeSpawn(p, 'git-other', ['git-other', 'status']).ok).toBe(false);
    expect(authorizeSpawn(p, 'git', ['not-git', 'status']).ok).toBe(false);
    expect(authorizeSpawn(p, 'git', []).ok).toBe(false);
  });

  it('an empty prefix allows any arguments; "" is one empty token', () => {
    expect(authorizeSpawn(scoped('git', []), 'git', ['git']).ok).toBe(true);
    const empty = scoped('git', ['']);
    expect(authorizeSpawn(empty, 'git', ['git', '']).ok).toBe(true);
    expect(authorizeSpawn(empty, 'git', ['git']).ok).toBe(false);
  });

  it('validates configuration', () => {
    expect(
      buildProcessPolicy({ spawn: true, allow: [{ program: 'git', argsPrefix: [] }] }),
    ).toEqual(err(['process.spawn and process.allow cannot be used together']));
    expect(buildProcessPolicy({ spawn: false, allow: [{ program: '', argsPrefix: [] }] })).toEqual(
      err(['invalid process.allow[0]', 'program must not be empty']),
    );
    expect(
      buildProcessPolicy({ spawn: false, allow: [{ program: 'a\0', argsPrefix: [] }] }).ok,
    ).toBe(false);
    expect(authorizeSpawn(undefined, 'x', ['x']).ok).toBe(true);
    expect(authorizeSpawn({ kind: 'allow-all' }, 'x', ['x']).ok).toBe(true);
    expect(authorizeSpawn({ kind: 'scoped', rules: [] }, 'x', ['x']).ok).toBe(false);
  });

  it('recognizes moonx', () => {
    expect(isMoonxExecutable('/usr/bin/moonx')).toBe(true);
    expect(isMoonxExecutable('moonx.exe')).toBe(true);
    expect(isMoonxExecutable('moonx2')).toBe(false);
  });

  it('tracks child ownership like moonrun', () => {
    const c = new ChildAuthority();
    expect(c.checkOwned(10)).toEqual({ ok: false, error: { code: 'EACCES', report: undefined } });
    c.trackSpawned(10);
    expect(c.checkOwned(10).ok).toBe(true);
    c.trackHandle(1n, 10);
    c.trackHandle(2n, 10);
    expect(c.checkWait(true, 10, 10).ok).toBe(true);
    expect(c.checkWait(true, 10, 11).ok).toBe(false);
    expect(c.checkWait(false, undefined, 10).ok).toBe(true);
    expect(c.checkWait(false, 10, 10).ok).toBe(false);
    c.untrackHandle(1n);
    expect(c.checkOwned(10).ok).toBe(true);
    c.untrackHandle(2n);
    expect(c.checkOwned(10).ok).toBe(false);
    c.trackSpawned(7);
    c.revokeUnclaimed(7);
    expect(c.checkOwned(7).ok).toBe(false);
  });
});

describe('environment provisioning', () => {
  const host = [
    ['PATH', '/bin'],
    ['HOME', '/home/u'],
  ] as const;
  const cfg = (c: Partial<Parameters<typeof provisionEnv>[0]>) =>
    provisionEnv({ fromHost: [], requiredFromHost: [], set: new Map(), ...c }, host);

  it('starts empty and sorts by name', () => {
    expect(cfg({})).toEqual(ok([]));
    expect(
      cfg({
        set: new Map([
          ['B', '2'],
          ['A', '1'],
        ]),
      }),
    ).toEqual(
      ok([
        ['A', '1'],
        ['B', '2'],
      ]),
    );
  });

  it('copies named and all host variables; set overrides', () => {
    expect(cfg({ fromHost: ['PATH', 'MISSING'] })).toEqual(ok([['PATH', '/bin']]));
    expect(cfg({ fromHost: ['*'], set: new Map([['PATH', 'x']]) })).toEqual(
      ok([
        ['HOME', '/home/u'],
        ['PATH', 'x'],
      ]),
    );
  });

  it('reports errors with moonrun wording', () => {
    expect(cfg({ fromHost: ['A', 'A'] })).toEqual(err(['duplicate environment policy entry "A"']));
    expect(cfg({ requiredFromHost: ['NOPE'] })).toEqual(
      err(['required host environment variable "NOPE" is not set']),
    );
    expect(cfg({ set: new Map([['A=B', 'x']]) })).toEqual(
      err(['invalid environment variable name "A=B"']),
    );
    expect(cfg({ set: new Map([['A', 'x\0']]) })).toEqual(
      err(['environment variable "A" contains a NUL in its value']),
    );
    expect(cfg({ set: new Map([['=C:', 'x']]) }).ok).toBe(true);
  });
});

describe('loading and inheritance', () => {
  const opts = { canonical: fakeFs(['/work/read', '/work/write']), hostEnv: [] };

  it('resolves relative roots against the policy directory and keeps "*"', () => {
    const r = loadPolicyFile(
      '/work/policy.toml',
      '[fs]\nread = ["read", "*"]\nwrite = ["/work/write"]\n',
      opts,
    );
    if (!r.ok) {
      throw new Error(r.error.chain.join('\n'));
    }
    expect(r.value.policy.fs.read).toEqual([{ kind: 'path', path: '/work/read' }, { kind: 'any' }]);
    const missing = loadPolicyFile('/work/p.toml', '[fs]\nread = ["nope"]\n', opts);
    expect(missing).toEqual(
      err({
        chain: [
          'failed to load sandbox policy (experimental); run `moonrun --help` for policy format notes',
          'failed to resolve sandbox filesystem root /work/nope',
          'No such file or directory (os error 2)',
        ],
      }),
    );
    const viaSourceDir = loadPolicyFile(
      '/tmp/stdin.mbtx',
      '// policy:\n//   fs:\n//     read:\n//       - read\n',
      {
        ...opts,
        sourceDir: '/work',
      },
    );
    expect(viaSourceDir.ok).toBe(true);
  });

  it('serializes the inherited payload: canonical roots, env copies everything, no secrets', () => {
    const r = loadPolicyFile(
      '/work/policy.toml',
      '[env.set]\nSECRET = "s3cret"\n[fs]\nread = ["read"]\n[net]\ndns = ["Example.com"]\n[process]\nspawn = true\n',
      opts,
    );
    if (!r.ok) {
      throw new Error('load');
    }
    const payload = r.value.policy.inheritance;
    expect(payload).not.toContain('s3cret');
    expect(JSON.parse(payload)).toEqual({
      fs: { read: ['/work/read'], write: [] },
      net: { dns: ['Example.com'], connect: [], bind: [] },
      env: { from_host: ['*'], required_from_host: [], set: {} },
      process: { spawn: true, allow: [] },
    });
    expect(payload.startsWith('{\n  "fs": {\n    "read": [\n      "/work/read"\n    ],')).toBe(
      true,
    );
    // A child reloads the payload; its roots must still exist.
    const child = loadInheritedPolicy(payload, { ...opts, hostEnv: [['PATH', '/bin']] });
    if (!child.ok) {
      throw new Error(child.error.chain.join('\n'));
    }
    expect(child.value.env).toEqual([['PATH', '/bin']]);
    expect(child.value.policy.process).toEqual({ kind: 'allow-all' });
    const gone = loadInheritedPolicy(payload, { canonical: fakeFs([]), hostEnv: [] });
    expect(gone.ok).toBe(false);
  });

  it('an absent section denies that surface in policy mode', () => {
    const r = loadPolicyFile('/work/policy.toml', '', opts);
    if (!r.ok) {
      throw new Error('load');
    }
    const p: Policy = r.value.policy;
    expect(p.fs).toEqual({ read: [], write: [] });
    expect(p.net).toEqual({ dns: [], connect: [], bind: [] });
    expect(p.process).toEqual({ kind: 'scoped', rules: [] });
    expect(r.value.env).toEqual([]);
  });

  it('detects the format', () => {
    expect(detectPolicyFormat('p.JSON', '')).toBe('json');
    expect(detectPolicyFormat('p', '  \n{}')).toBe('json');
    expect(detectPolicyFormat('p', '[fs]')).toBe('toml');
    expect(detectPolicyFormat('x.MBTX', '')).toBe('mbtx');
  });

  it('reports inherited JSON failures with their own context', () => {
    expect(loadInheritedPolicy('{', opts)).toEqual(
      err({
        chain: [
          'failed to load inherited sandbox policy (experimental)',
          'failed to parse inherited JSON Moonrun Policy',
          'EOF while parsing an object at line 1 column 1',
        ],
      }),
    );
  });
});

describe('.mbtx front matter', () => {
  it('extracts leading line comments', () => {
    expect(
      extractMbtxFrontMatter(
        '// policy:\n//   env:\n//     set:\n//       MODE: embedded\n\n///|\nfn main {}\n',
      ),
    ).toBe('policy:\n  env:\n    set:\n      MODE: embedded\n');
    expect(extractMbtxFrontMatter('// policy: {}\n///|\nfn main {}\n')).toBe('policy: {}\n');
    expect(extractMbtxFrontMatter('// policy: {}\n// explanation\nfn main {}\n')).toBe(
      'policy: {}\n',
    );
    expect(extractMbtxFrontMatter('// An ordinary comment.\nfn main {}\n')).toBeUndefined();
    expect(extractMbtxFrontMatter('﻿// policy: {}\r\nfn main {}\r\n')).toBe('policy: {}\n');
  });

  it('reads the YAML subset into a policy', () => {
    const r = loadPolicyFile(
      'x.mbtx',
      '// policy:\n//   env:\n//     set:\n//       APP_ENV: embedded\n//   process:\n//     allow:\n//       - program: git\n//         args_prefix: [status, "--short"]\n//       - program: ls\n',
      { canonical: fakeFs([]), hostEnv: [] },
    );
    if (!r.ok) {
      throw new Error(r.error.chain.join('\n'));
    }
    expect(r.value.env).toEqual([['APP_ENV', 'embedded']]);
    expect(r.value.policy.process).toEqual({
      kind: 'scoped',
      rules: [
        { program: 'git', argsPrefix: ['status', '--short'] },
        { program: 'ls', argsPrefix: [] },
      ],
    });
    const none = loadPolicyFile('x.mbtx', 'fn main {}\n', { canonical: fakeFs([]), hostEnv: [] });
    expect(none).toEqual(
      err({
        chain: [
          'failed to load sandbox policy (experimental); run `moonrun --help` for policy format notes',
          '.mbtx policy source x.mbtx has no `// policy:` front matter',
        ],
      }),
    );
  });
});

describe('rust formatting', () => {
  it('debug-escapes like Rust', () => {
    expect(rustDebugStr('a\'b"c\\d\n\t\0\u{7f}é\u{a0}')).toBe(
      '"a\'b\\"c\\\\d\\n\\t\\0\\u{7f}é\\u{a0}"',
    );
  });
});
