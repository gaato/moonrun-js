import { type Err, err } from '../../ports/result.ts';

/**
 * A refused operation. moonrun's `sandbox_denied` prints `report` to the process stderr
 * (`eprintln!`, so with a trailing newline, at the moment of denial) and returns
 * `AsyncHostError::PermissionDenied`, which the guest sees as EACCES.
 * Provenance failures (unowned child pids) are denied silently: `report` is `undefined`.
 */
export interface PolicyDenied {
  readonly code: 'EACCES';
  readonly report: string | undefined;
}

/** Text to write to stderr for a denial, newline included; empty when nothing is printed. */
export function denialStderr(denied: PolicyDenied): string {
  return denied.report === undefined ? '' : `${denied.report}\n`;
}

export function sandboxDenied(action: string, target?: string): Err<PolicyDenied> {
  return err({
    code: 'EACCES',
    report:
      target === undefined
        ? `Sandbox policy blocked ${action}`
        : `Sandbox policy blocked ${action}: ${target}`,
  });
}

export function silentDenied(): Err<PolicyDenied> {
  return err({ code: 'EACCES', report: undefined });
}
