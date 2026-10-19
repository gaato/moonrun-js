/**
 * The Run's single generational handle namespace (moonrun ADR 0009).
 *
 * Guest-visible values are exactly those of moonrun's `slotmap` `HostKeys`:
 * `KeyData::as_ffi` is `(version << 32) | index`, slot 0 is a sentinel that is
 * never issued, a freed slot's version becomes even and its reuse takes the next
 * odd version, and the free list is LIFO. The null handle is slotmap's
 * `KeyData::null()` (index `u32::MAX`, version 1); it never names an entry.
 * Decoding follows `KeyData::from_ffi`, which forces the version odd.
 */

declare const handleBrand: unique symbol;

/** An opaque u64 handle as the guest sees it. */
export type Handle = bigint & { readonly [handleBrand]: true };

/** Every family of host object that receives a handle (moonrun `HostResourceKind`). */
export type HandleKind =
  | 'resource'
  | 'job'
  | 'poll'
  | 'worker'
  | 'c-buffer'
  | 'process-argv'
  | 'process-env'
  | 'process-env-builder'
  | 'addr-info'
  | 'tls-connection'
  | 'sqlite-database'
  | 'sqlite-database-mutex'
  | 'sqlite-statement';

/** The low bit of the version: `from_ffi` sets it on every decoded value. */
const ODD_VERSION = 1n << 32n;

/** Normalizes a raw wasm i64/u64 value into a handle. */
export function asHandle(raw: bigint): Handle {
  return BigInt.asUintN(64, raw) as Handle;
}

function encode(index: number, version: number): Handle {
  return ((BigInt(version >>> 0) << 32n) | BigInt(index >>> 0)) as Handle;
}

/** The key a guest value decodes to (`KeyData::from_ffi`). */
export function canonical(handle: Handle): Handle {
  return (handle | ODD_VERSION) as Handle;
}

/** `runtime::null_handle()`: 0x1_FFFF_FFFF. */
export const NULL_HANDLE: Handle = encode(0xffff_ffff, 1);

interface Slot {
  /** Odd while occupied, even while vacant; the sentinel at index 0 stays 0. */
  version: number;
  nextFree: number;
}

/**
 * Liveness and kind of every issued handle (moonrun `HostKeys`). Slots model the
 * allocator; lookups go through a map of live keys, which is exact because a key
 * is never issued twice.
 */
export class HostKeys {
  readonly #slots: Slot[] = [{ version: 0, nextFree: 0 }];
  readonly #live = new Map<Handle, HandleKind>();
  #freeHead = 1;

  insert(kind: HandleKind): Handle {
    let handle: Handle;
    const reused = this.#slots[this.#freeHead];
    if (reused === undefined) {
      const index = this.#slots.length;
      this.#slots.push({ version: 1, nextFree: 0 });
      this.#freeHead = index + 1;
      handle = encode(index, 1);
    } else {
      reused.version = (reused.version | 1) >>> 0;
      handle = encode(this.#freeHead, reused.version);
      this.#freeHead = reused.nextFree;
    }
    this.#live.set(handle, kind);
    return handle;
  }

  /** The kind of a live handle; `undefined` for null, stale or never-issued values. */
  kind(handle: Handle): HandleKind | undefined {
    return this.#live.get(canonical(handle));
  }

  /** {@link kind} for a value already decoded with {@link canonical}. */
  kindOfKey(key: Handle): HandleKind | undefined {
    return this.#live.get(key);
  }

  remove(handle: Handle): HandleKind | undefined {
    const key = canonical(handle);
    const kind = this.#live.get(key);
    if (kind === undefined) {
      return undefined;
    }
    this.#live.delete(key);
    const index = Number(BigInt.asUintN(32, key));
    const slot = this.#slots[index];
    if (slot !== undefined) {
      slot.nextFree = this.#freeHead;
      slot.version = (slot.version + 1) >>> 0;
      this.#freeHead = index;
    }
    return kind;
  }

  get size(): number {
    return this.#live.size;
  }
}

/**
 * One family's payloads together with their registrations in the shared
 * namespace (moonrun `Handles<T>`). Lookup checks both the central kind and
 * membership in this table.
 */
export class Handles<T> {
  readonly #keys: HostKeys;
  readonly #kind: HandleKind;
  readonly #entries = new Map<Handle, T>();

  constructor(keys: HostKeys, kind: HandleKind) {
    this.#keys = keys;
    this.#kind = kind;
  }

  insert(value: T): Handle {
    const handle = this.#keys.insert(this.#kind);
    this.#entries.set(handle, value);
    return handle;
  }

  get(handle: Handle): T | undefined {
    const key = canonical(handle);
    return this.#keys.kindOfKey(key) === this.#kind ? this.#entries.get(key) : undefined;
  }

  /** Replaces the payload of a live entry; false when the handle is not in this table. */
  set(handle: Handle, value: T): boolean {
    const key = canonical(handle);
    if (this.get(key) === undefined) {
      return false;
    }
    this.#entries.set(key, value);
    return true;
  }

  remove(handle: Handle): T | undefined {
    const key = canonical(handle);
    const value = this.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    this.#keys.remove(key);
    return value;
  }

  /** Retires every registration and returns the payloads for cleanup. */
  takeAll(): T[] {
    const values = [...this.#entries.values()];
    for (const handle of this.#entries.keys()) {
      this.#keys.remove(handle);
    }
    this.#entries.clear();
    return values;
  }

  entries(): IterableIterator<[Handle, T]> {
    return this.#entries.entries();
  }

  get size(): number {
    return this.#entries.size;
  }
}
