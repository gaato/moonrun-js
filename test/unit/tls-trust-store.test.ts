import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeTrustStore, pemCertificates } from '../../src/hosts/node/trust-store.ts';
import { FIXTURES, fixture, pemToDer } from './tls-harness.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'moonrun-js-trust-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ca = pemToDer(fixture('ca.pem'))[0] ?? new Uint8Array();
const valid = pemToDer(fixture('valid_root_cert.pem'))[0] ?? new Uint8Array();
const env = (vars: Record<string, string>) => (name: string) => vars[name];

describe('node trust store', () => {
  it('reads SSL_CERT_FILE and the hashed files of SSL_CERT_DIR, deduplicated', () => {
    const certDir = path.join(dir, 'certs');
    rmSync(certDir, { recursive: true, force: true });
    mkdirSync(certDir, { recursive: true });
    writeFileSync(path.join(certDir, '0123abcd.0'), fixture('valid_root_cert.pem'));
    writeFileSync(path.join(certDir, '0123abcd.1'), fixture('ca.pem')); // duplicate of the file
    writeFileSync(path.join(certDir, 'not-hashed.pem'), fixture('other_root_cert.pem'));
    const store = nodeTrustStore({
      env: env({ SSL_CERT_FILE: path.join(FIXTURES, 'ca.pem'), SSL_CERT_DIR: certDir }),
    });
    const roots = store.systemRoots();
    expect(roots.ok).toBe(true);
    const ders = roots.ok ? roots.value.map((d) => Buffer.from(d).toString('base64')) : [];
    expect(ders).toContain(Buffer.from(ca).toString('base64'));
    expect(ders).toContain(Buffer.from(valid).toString('base64'));
    expect(ders.filter((d) => d === Buffer.from(ca).toString('base64'))).toHaveLength(1);
    expect(ders).not.toContain(
      Buffer.from(pemToDer(fixture('other_root_cert.pem'))[0] ?? []).toString('base64'),
    );
    expect(store.systemRoots()).toBe(roots); // cached
  });

  it('keeps only the certificate of a TRUSTED CERTIFICATE block', () => {
    const aux = Buffer.concat([Buffer.from(ca), Buffer.from([0x30, 0x03, 0x06, 0x01, 0x00])]);
    const pem = `-----BEGIN TRUSTED CERTIFICATE-----\n${aux.toString('base64')}\n-----END TRUSTED CERTIFICATE-----\n`;
    expect(pemCertificates(pem)).toEqual([ca]);
  });
});
