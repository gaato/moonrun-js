import { createHash } from 'node:crypto';

/** A reference recording belongs to one compiler, runner and upstream revision. */
export function suiteCacheIdentity(...identities: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex').slice(0, 16);
}
