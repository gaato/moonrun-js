import type { DnsPort } from '../ports/net.ts';
import { type AsyncError, BADF, INVAL, IO, native } from './errors.ts';
import type { Job, NetworkPayload } from './job.ts';
import type { Execution } from './job-runner.ts';
import { addrinfoAddresses, decodeSockaddr, EAI_NUMBERS } from './net-codec.ts';

const FINISHED: Execution = { interrupt: () => false };

/**
 * Runs a Network Job (moonrun `network::job::runner`). Neither can be interrupted:
 * `bind` returns at once on Linux and `getaddrinfo` ignores the cancellation signal,
 * so a cancelled Job still finishes and its result is discarded with it.
 */
export function startNetworkJob(
  job: Job,
  payload: NetworkPayload,
  dns: DnsPort,
  done: () => void,
): Execution {
  const finish = (error: AsyncError | undefined, ret = 0): void => {
    if (error === undefined) {
      job.succeed(ret);
    } else {
      job.fail(error);
    }
    done();
  };
  switch (payload.kind) {
    case 'bind': {
      const resource = payload.resource;
      if (resource.kind !== 'socket') {
        finish(BADF);
        return FINISHED;
      }
      const address = decodeSockaddr(payload.address);
      if (!address.ok) {
        finish(address.error);
        return FINISHED;
      }
      const started = resource.socket.bind(address.value, (error) => finish(error));
      if (!started.ok) {
        finish(started.error);
      }
      return FINISHED;
    }
    case 'getaddrinfo': {
      // `CString::new` of the host name.
      if (payload.host.includes('\0')) {
        finish(INVAL);
        return FINISHED;
      }
      if (payload.host === '') {
        payload.result = [];
        finish(undefined, EAI_NUMBERS.EAI_NONAME);
        return FINISHED;
      }
      dns.lookup(payload.host).then(
        (r) => {
          if (r.ok) {
            payload.result = addrinfoAddresses(r.value);
            finish(undefined);
          } else if (r.error.kind === 'eai') {
            payload.result = [];
            finish(undefined, EAI_NUMBERS[r.error.code]);
          } else {
            finish(native(r.error.error.code));
          }
        },
        () => finish(IO),
      );
      return FINISHED;
    }
  }
}
