// The OS side of moonrun's policy transport (moonutil `policy_transport`): the inherited
// descriptor and the anonymous file handed to moonx children. Loading and checking the
// policy itself is the moonrun-policy component's (domains/policy/component.ts).
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { rustIoErrorText } from '../../abi/errno.ts';
import { osCapabilities } from '../../abi/os-capabilities.ts';
import { PolicyComponent, type PolicyError } from '../../domains/policy/component.ts';
import { POLICY_URL } from '../../domains/policy/policy-url.ts';
import {
  err,
  type HostError,
  type HostErrorCode,
  hostError,
  ok,
  type Result,
} from '../../ports/result.ts';
import { nodeComponentModule } from './components.ts';
import { nodeHost } from './index.ts';

/** Name of the variable moonrun uses to hand a policy to child runs (`moonutil::constants`). */
export const MOONRUN_INHERITED_POLICY = 'MOONRUN_INHERITED_POLICY';

function toHostError(e: unknown): HostError {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return hostError((typeof code === 'string' ? code : 'EIO') as HostErrorCode, message);
}

/**
 * `PolicyTransfer::take_from_env` + `read`: if the variable is present it is removed from `env`
 * (before anything else can copy it) and the file descriptor it names is read to the end.
 * Returns `undefined` when there is no inherited policy. Errors are moonrun's bare chains
 * (no "failed to load sandbox policy" wrapper).
 */
export function takeInheritedPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Result<Uint8Array | undefined, PolicyError> {
  const token = env[MOONRUN_INHERITED_POLICY];
  if (token === undefined) {
    return ok(undefined);
  }
  delete env[MOONRUN_INHERITED_POLICY];
  const fdError = 'invalid inherited Moonrun Policy file descriptor';
  if (!/^[+-]?\d+$/.test(token)) {
    return err({
      chain: [
        fdError,
        token === '' ? 'cannot parse integer from empty string' : 'invalid digit found in string',
      ],
    });
  }
  const fd = Number(token);
  if (fd > 2147483647 || fd < -2147483648) {
    return err({ chain: [fdError, 'number too large to fit in target type'] });
  }
  if (fd <= 2) {
    return err({ chain: [fdError] });
  }
  try {
    fstatSync(fd);
  } catch (e) {
    return err({
      chain: [
        'failed to isolate inherited Moonrun Policy file descriptor',
        rustIoErrorText(toHostError(e)),
      ],
    });
  }
  const chunks: Buffer[] = [];
  try {
    const buf = Buffer.allocUnsafe(65536);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch (e) {
    return err({
      chain: ['failed to read inherited Moonrun Policy', rustIoErrorText(toHostError(e))],
    });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is only ours to read once.
    }
  }
  return ok(new Uint8Array(Buffer.concat(chunks)));
}

export interface PolicyRequest {
  /** `--policy PATH`, exactly as given. Ignored when an inherited policy is present. */
  readonly policyPath?: string | undefined;
  /** Hidden `--policy-source-dir`. */
  readonly sourceDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * moonrun's `main` + `Runtime::new` policy steps in one call (the CLI does them around
 * argument parsing): an inherited policy wins; otherwise `--policy` is read; with neither
 * the run is unrestricted (`undefined`). The inherited variable is always removed from `env`.
 */
export function loadRunPolicy(
  request: PolicyRequest = {},
): Result<PolicyComponent | undefined, PolicyError> {
  const inherited = takeInheritedPolicy(request.env ?? process.env);
  if (!inherited.ok) {
    return inherited;
  }
  if (inherited.value === undefined && request.policyPath === undefined) {
    return ok(undefined);
  }
  const module = nodeComponentModule(POLICY_URL);
  if (!module.ok) {
    return err({ chain: [module.error.message ?? module.error.code] });
  }
  const host = nodeHost();
  const policy = new PolicyComponent(
    module.value,
    osCapabilities(host, (bytes) => host.stdio.writeStderr(bytes)),
  );
  const loaded =
    inherited.value !== undefined
      ? policy.loadInherited(inherited.value)
      : policy.loadFile(request.policyPath ?? '', request.sourceDir);
  return loaded.ok ? ok(policy) : loaded;
}

/**
 * Materializes the inheritance payload as an anonymous file (created, unlinked, written with a
 * positional write so the offset stays 0) and returns its descriptor. Pass it to the child as an
 * extra `stdio` entry at index >= 3 and set `MOONRUN_INHERITED_POLICY` to that index.
 * The caller closes the descriptor once the child has been created.
 */
export function openPolicyTransfer(payload: Uint8Array): number {
  const file = path.join(tmpdir(), `moonrun-policy-${randomBytes(8).toString('hex')}`);
  const fd = openSync(file, 'wx+', 0o600);
  try {
    unlinkSync(file);
    const bytes = payload;
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, written);
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}
