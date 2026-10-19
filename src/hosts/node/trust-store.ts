// System root certificates the way moonrun's OpenSSL finds them
// (`load_system_root_paths`, openssl.rs:721-748, with openssl-probe 0.2 on
// Linux): the CA file is SSL_CERT_FILE or the first existing well-known
// bundle; CA directories are SSL_CERT_DIR plus every existing well-known
// directory, read as OpenSSL's hashed lookup does (`<hash>.<n>` files).
// When none exists, moonrun falls back to the vendored OpenSSL's built-in
// paths (/usr/local/ssl); after those, moonrun-js uses Node's own store.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';
import type { TrustStorePort } from '../../ports/tls.ts';

/** openssl-probe 0.2 `CERTIFICATE_FILE_NAMES` for Linux, in order. */
export const CERTIFICATE_FILE_NAMES: readonly string[] = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Gentoo
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // CentOS, RHEL 7
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora, RHEL 6
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/pki/tls/cacert.pem', // OpenELEC
  '/etc/ssl/cert.pem', // Alpine
  '/opt/etc/ssl/certs/ca-certificates.crt', // Entware
  '/etc/ssl/certs/cacert.pem', // OpenHarmony
];

/** openssl-probe 0.2 `CERTIFICATE_DIRS` for Linux. */
export const CERTIFICATE_DIRS: readonly string[] = [
  '/etc/ssl/certs',
  '/etc/pki/tls/certs',
  '/etc/security/certificates',
];

/** OPENSSLDIR of the vendored OpenSSL moonrun links (`set_default_verify_paths`). */
const OPENSSL_DEFAULT_FILE = '/usr/local/ssl/cert.pem';
const OPENSSL_DEFAULT_DIR = '/usr/local/ssl/certs';

const HASHED_NAME = /^[0-9a-f]{8}\.[0-9]+$/;
const PEM_BLOCK = /-----BEGIN (TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END \1?CERTIFICATE-----/g;

export interface NodeTrustStoreOptions {
  readonly env?: (name: string) => string | undefined;
}

export function nodeTrustStore(options: NodeTrustStoreOptions = {}): TrustStorePort {
  const env = options.env ?? ((name: string) => process.env[name]);
  let cached: Result<readonly Uint8Array[], HostError> | undefined;
  return {
    systemRoots: () => {
      cached ??= loadSystemRoots(env);
      return cached;
    },
  };
}

function kind(file: string): 'file' | 'dir' | undefined {
  try {
    const s = statSync(file);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return undefined;
  }
}

function exists(file: string | undefined): file is string {
  return file !== undefined && file !== '' && kind(file) !== undefined;
}

/** DER certificates of every CERTIFICATE / TRUSTED CERTIFICATE block. */
export function pemCertificates(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const m of text.matchAll(PEM_BLOCK)) {
    const der = Buffer.from((m[2] ?? '').replace(/\s+/g, ''), 'base64');
    // A TRUSTED CERTIFICATE is the DER certificate followed by OpenSSL's
    // trust settings; keep only the leading SEQUENCE.
    out.push(new Uint8Array(m[1] === undefined ? der : der.subarray(0, derLength(der))));
  }
  return out;
}

function derLength(der: Uint8Array): number {
  const first = der[1] ?? 0;
  if (first < 0x80) {
    return 2 + first;
  }
  const count = first & 0x7f;
  let len = 0;
  for (let i = 0; i < count; i++) {
    len = len * 256 + (der[2 + i] ?? 0);
  }
  return 2 + count + len;
}

function readPem(file: string): Result<Uint8Array[], HostError> {
  try {
    return ok(pemCertificates(readFileSync(file, 'latin1')));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EIO';
    return err(hostError(code === 'EACCES' ? 'EACCES' : 'EIO', `${file}: ${String(error)}`));
  }
}

function loadSystemRoots(
  env: (name: string) => string | undefined,
): Result<readonly Uint8Array[], HostError> {
  const envFile = env('SSL_CERT_FILE');
  const envDir = env('SSL_CERT_DIR');
  const certFile = exists(envFile) ? envFile : CERTIFICATE_FILE_NAMES.find((f) => exists(f));
  const certDirs = [
    ...(exists(envDir) ? [envDir] : []),
    ...CERTIFICATE_DIRS.filter((d) => exists(d)),
  ];

  const found: Uint8Array[] = [];
  let loaded = false;
  const addFile = (file: string): HostError | undefined => {
    const certs = readPem(file);
    if (!certs.ok) {
      return certs.error;
    }
    found.push(...certs.value);
    return undefined;
  };
  const addDir = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => HASHED_NAME.test(n)).sort()) {
      const certs = readPem(path.join(dir, name));
      if (certs.ok) {
        found.push(...certs.value);
      }
    }
  };

  if (certFile !== undefined) {
    const failure = addFile(certFile);
    if (failure !== undefined) {
      return err(failure);
    }
    loaded = true;
  }
  for (const dir of certDirs) {
    addDir(dir);
    loaded = true;
  }
  if (!loaded) {
    if (exists(OPENSSL_DEFAULT_FILE)) {
      addFile(OPENSSL_DEFAULT_FILE);
    }
    if (exists(OPENSSL_DEFAULT_DIR)) {
      addDir(OPENSSL_DEFAULT_DIR);
    }
  }
  if (found.length === 0 && !loaded) {
    found.push(...nodeRoots());
  }
  return ok(dedupe(found));
}

function nodeRoots(): Uint8Array[] {
  let pems: readonly string[];
  try {
    pems = tls.getCACertificates('system');
  } catch {
    pems = [];
  }
  if (pems.length === 0) {
    pems = tls.rootCertificates;
  }
  return pems.flatMap((pem) => pemCertificates(pem));
}

function dedupe(certs: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  return certs.filter((der) => {
    const key = Buffer.from(der).toString('base64');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
