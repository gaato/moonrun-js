/** The process environment as seen at run start, plus write-through mutation. */
export interface EnvPort {
  get(key: string): string | undefined;
  /** Entries in host order. Non-UTF-8 entries are already skipped by the adapter. */
  entries(): ReadonlyArray<readonly [string, string]>;
  set(key: string, value: string): void;
  unset(key: string): void;
}
