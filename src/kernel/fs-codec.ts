/**
 * Guest-visible layouts of the Host Filesystem, kept apart from the code that
 * performs the OS operations so they can be replaced by moonrun's own encoders
 * (compiled to wasm) later: the generic stat result (ADR 0011), the compat
 * FileTime record, `linux_dirent64` records and `struct inotify_event`.
 */
import type { DirectoryRecord } from '../ports/files.ts';
import { fileKindCode, STAT_OPEN_IDENTITY, type StatValues, type Timestamp } from './file.ts';
import type { StatRequest } from './job.ts';

/** An access outside the decoded buffer (the ABI reports it as `Fault`). */
export class LayoutFault extends Error {
  constructor() {
    super('layout access out of range');
    this.name = 'LayoutFault';
  }
}

/** Linux `inotify` event bits. */
export const IN_MODIFY = 0x0000_0002;
export const IN_MOVED_FROM = 0x0000_0040;
export const IN_MOVED_TO = 0x0000_0080;
export const IN_CREATE = 0x0000_0100;
export const IN_DELETE = 0x0000_0200;
export const IN_Q_OVERFLOW = 0x0000_4000;
export const IN_IGNORED = 0x0000_8000;

/** `sizeof(struct inotify_event)`: wd, mask, cookie, len. */
export const INOTIFY_EVENT_SIZE = 16;

// ----- generic stat codec (moonrun ADR 0011) -----

const STAT_SUPPORTED_MASK = 0xff;
const STAT_HEADER_LEN = 8;

/** moonrun `StatRequest::new`; `undefined` is a rejected request (a failed Job with `EINVAL`). */
export function statRequest(mask: number, capacity: number): StatRequest | undefined {
  const bits = mask >>> 0;
  if ((bits & ~STAT_SUPPORTED_MASK) !== 0 || capacity < STAT_HEADER_LEN) {
    return undefined;
  }
  let words = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (bits & (1 << bit)) {
      words += bit < 4 ? 1 : 2;
    }
  }
  const encodedLen = STAT_HEADER_LEN + words * 8;
  return encodedLen > capacity ? undefined : { mask: bits, encodedLen };
}

/** The request of the pre-PR-527 open Job: kind, device and file id. */
export const OPEN_IDENTITY_REQUEST: StatRequest = { mask: STAT_OPEN_IDENTITY, encodedLen: 32 };

/** moonrun `PackedStat::new`: header (length, returned mask) and fixed slots in bit order. */
export function packStat(request: StatRequest, values: StatValues): Uint8Array {
  const bytes = new Uint8Array(request.encodedLen);
  const view = new DataView(bytes.buffer);
  let returned = 0;
  let offset = STAT_HEADER_LEN;
  const scalar = (bit: number, value: bigint | undefined, signed: boolean): void => {
    if (value !== undefined) {
      returned |= bit;
      if (signed) {
        view.setBigInt64(offset, value, true);
      } else {
        view.setBigUint64(offset, BigInt.asUintN(64, value), true);
      }
    }
    offset += 8;
  };
  const time = (bit: number, value: Timestamp | undefined): void => {
    if (value !== undefined) {
      returned |= bit;
      view.setBigInt64(offset, value.seconds, true);
      view.setBigInt64(offset + 8, value.nanoseconds, true);
    }
    offset += 16;
  };
  const kind = values.kind === undefined ? undefined : BigInt(fileKindCode(values.kind));
  const slots: Array<() => void> = [
    () => scalar(0x01, kind, false),
    () => scalar(0x02, values.size, true),
    () => scalar(0x04, values.deviceId, false),
    () => scalar(0x08, values.fileId, false),
    () => time(0x10, values.accessTime),
    () => time(0x20, values.modifyTime),
    () => time(0x40, values.changeTime),
    () => time(0x80, values.createTime),
  ];
  slots.forEach((slot, bit) => {
    if (request.mask & (1 << bit)) {
      slot();
    }
  });
  view.setUint32(0, request.encodedLen, true);
  view.setUint32(4, returned, true);
  return bytes;
}

/** The compat `FileTime` record: (i64 seconds, i32 nanoseconds) at 16-byte strides. */
export function fileTimeRecord(times: {
  readonly access: Timestamp;
  readonly modify: Timestamp;
  readonly change: Timestamp;
}): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  [times.access, times.modify, times.change].forEach((t, i) => {
    view.setBigInt64(i * 16, t.seconds, true);
    view.setInt32(i * 16 + 8, Number(t.nanoseconds), true);
  });
  return bytes;
}

// ----- linux_dirent64 (moonrun `async_sys::fs::dir`) -----

const D_RECLEN = 16;
const D_TYPE = 18;
const D_NAME = 19;

/** A record's length: header, name, NUL, rounded up to 8. */
export function direntLength(name: Uint8Array): number {
  return (D_NAME + name.length + 1 + 7) & ~7;
}

/** Writes one `linux_dirent64` record at `at`; returns its length. */
export function writeDirent(
  target: Uint8Array,
  at: number,
  record: DirectoryRecord,
  off: bigint,
): number {
  const length = direntLength(record.name);
  const view = new DataView(target.buffer, target.byteOffset + at, length);
  target.fill(0, at, at + length);
  view.setBigUint64(0, BigInt.asUintN(64, record.ino), true);
  view.setBigInt64(8, off, true);
  view.setUint16(D_RECLEN, length, true);
  view.setUint8(D_TYPE, record.type);
  target.set(record.name, at + D_NAME);
  return length;
}

/** `d_type` of a directory. */
export const DT_DIR = 4;

function u16At(buf: Uint8Array, at: number): number {
  if (at + 2 > buf.length) {
    throw new LayoutFault();
  }
  return (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8);
}

function byteAt(buf: Uint8Array, at: number): number {
  const value = buf[at];
  if (value === undefined) {
    throw new LayoutFault();
  }
  return value;
}

/** `[name start, name length]` of the record at `entry`. */
function nameRange(buf: Uint8Array, entry: number): [number, number] {
  const reclen = u16At(buf, entry + D_RECLEN);
  const start = entry + D_NAME;
  const end = entry + reclen;
  if (start > end || end > buf.length) {
    throw new LayoutFault();
  }
  const nul = buf.subarray(start, end).indexOf(0);
  if (nul < 0) {
    throw new LayoutFault();
  }
  return [start, nul];
}

export const dirEntry = {
  length: (buf: Uint8Array, entry: number): number => u16At(buf, entry + D_RECLEN),
  nameLen: (buf: Uint8Array, entry: number): number => nameRange(buf, entry)[1],
  nameOffset: (buf: Uint8Array, entry: number): number => {
    nameRange(buf, entry);
    return D_NAME;
  },
  isDir: (buf: Uint8Array, entry: number): number => {
    const type = byteAt(buf, entry + D_TYPE);
    return type === 0 ? -1 : type === 4 ? 1 : 0;
  },
  isHidden: (buf: Uint8Array, entry: number): boolean =>
    byteAt(buf, nameRange(buf, entry)[0]) === 0x2e,
  fileId: (buf: Uint8Array, entry: number): bigint => {
    if (entry + 8 > buf.length) {
      throw new LayoutFault();
    }
    return new DataView(buf.buffer, buf.byteOffset + entry, 8).getBigUint64(0, true);
  },
};

// ----- inotify events -----

function eventHeader(buf: Uint8Array, offset: number): DataView {
  if (offset + INOTIFY_EVENT_SIZE > buf.length) {
    throw new LayoutFault();
  }
  return new DataView(buf.buffer, buf.byteOffset + offset, INOTIFY_EVENT_SIZE);
}

const RELEVANT = IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO;

/** `fs/inotify/event_buffer_size`: max(4096, header + NAME_MAX + 1). */
export const INOTIFY_BUFFER_SIZE = 4096;

/** A `struct inotify_event` without a name (`len` 0). */
export function inotifyEvent(wd: number, mask: number): Uint8Array {
  const event = new Uint8Array(INOTIFY_EVENT_SIZE);
  const view = new DataView(event.buffer);
  view.setInt32(0, wd, true);
  view.setUint32(4, mask, true);
  return event;
}

/** moonrun `watch_inotify::event_*`. */
export const inotifyEventAt = {
  size: (buf: Uint8Array, offset: number): number => {
    const size = INOTIFY_EVENT_SIZE + eventHeader(buf, offset).getUint32(12, true);
    if (offset + size > buf.length) {
      throw new LayoutFault();
    }
    return size;
  },
  wd: (buf: Uint8Array, offset: number): number => eventHeader(buf, offset).getInt32(0, true),
  relevant: (buf: Uint8Array, offset: number): boolean =>
    (eventHeader(buf, offset).getUint32(4, true) & RELEVANT) !== 0,
  overflow: (buf: Uint8Array, offset: number): boolean =>
    (eventHeader(buf, offset).getUint32(4, true) & IN_Q_OVERFLOW) !== 0,
  ignore: (buf: Uint8Array, offset: number): boolean =>
    (eventHeader(buf, offset).getUint32(4, true) & IN_IGNORED) !== 0,
};
