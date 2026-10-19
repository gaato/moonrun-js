import { EPOLLERR, EPOLLHUP, EPOLLIN, EPOLLOUT, EPOLLRDHUP } from '../../kernel/readiness.ts';
import { ok } from '../../ports/result.ts';
import { type AsyncEnv, bool, fail, handle, status, unwrap } from './env.ts';
import type { HandlerGroup } from './types.ts';

/** async's `ReadEvent`/`WriteEvent` bits (moonrun `epoll_result_events`). */
const READ_EVENT = 1;
const WRITE_EVENT = 2;

export function guestEvents(epoll: number): number {
  if ((epoll & (EPOLLERR | EPOLLHUP | EPOLLRDHUP)) !== 0) {
    return READ_EVENT | WRITE_EVENT;
  }
  return ((epoll & EPOLLIN) !== 0 ? READ_EVENT : 0) | ((epoll & EPOLLOUT) !== 0 ? WRITE_EVENT : 0);
}

/** `event_bus/*`: the epoll-shaped Host Poller. */
export function eventBus(env: AsyncEnv) {
  const { kernel } = env;
  return {
    'event_bus/create': () => kernel.pollCreate(),
    'event_bus/destroy': (bus) => unwrap(kernel.pollDestroy(handle(bus))),
    'event_bus/try_register': (bus, fd, readOnly) =>
      status(env, () => kernel.pollRegister(handle(bus), handle(fd), bool(readOnly))),
    'event_bus/register': (bus, fd, readOnly) =>
      status(env, () => {
        const r = kernel.pollRegisterLegacy(handle(bus), handle(fd), bool(readOnly));
        return r.ok ? ok(0) : r;
      }),
    'event_bus/wait': {
      suspends: true,
      impl: (bus, timeoutMs) => {
        const waited = kernel.pollWait(handle(bus), timeoutMs);
        return waited.ok ? waited.value : fail(env, waited.error);
      },
    },
    'event_bus/get_event': (bus, index) => unwrap(kernel.pollGetEvent(handle(bus), index)),
    'event_bus/event_fd': (event) => unwrap(kernel.event(event)).data,
    'event_bus/event_events/unix': (event) => guestEvents(unwrap(kernel.event(event)).events),
  } satisfies HandlerGroup;
}
