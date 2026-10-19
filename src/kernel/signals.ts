import type { SignalPort } from '../ports/process.ts';
import { err, ok, type Result } from '../ports/result.ts';
import type { CompletionSource } from './completion.ts';
import { type AsyncError, INVAL } from './errors.ts';

/** The signals moonrun's CLI brokers (`cli/process_signals.rs`): SIGINT, SIGTERM, SIGHUP. */
const MANAGED_SIGNALS: readonly number[] = [2, 15, 1];

/** Signal notifications set the top bit of a completion id. */
const SIGNAL_FLAG = 0x8000_0000;

/** `run_signal::signal_bit`: signals outside 0..32 have no bit. */
function signalBit(signal: number): number {
  return signal >= 0 && signal < 32 ? (1 << signal) >>> 0 : 0;
}

function signalMask(signals: readonly number[]): number {
  return signals.reduce((mask, signal) => (mask | signalBit(signal)) >>> 0, 0);
}

/**
 * The target of the compat `make_sigwait_job` (moonrun `SigwaitTarget`): accepted signals
 * are queued until the Job's worker publishes them as completion ids.
 */
export class SigwaitSink {
  readonly #mask: number;
  readonly #source: CompletionSource;
  #pending = 0;
  #cancelled = false;
  #wake: (() => void) | undefined;
  #detach: (() => void) | undefined;

  constructor(signals: readonly number[], source: CompletionSource) {
    this.#mask = signalMask(signals);
    this.#source = source;
  }

  /** Attaches to the Run (fails when another target is attached). */
  attach(signals: RunSignals): boolean {
    if (!signals.attachSigwait(this)) {
      return false;
    }
    this.#detach = () => signals.detachSigwait(this);
    return true;
  }

  /** The Job ended or was freed: the target goes with it (moonrun drops its guard). */
  detach(): void {
    this.#detach?.();
    this.#detach = undefined;
    this.#wake = undefined;
  }

  send(bit: number): boolean {
    if ((this.#mask & bit) === 0 || this.#cancelled) {
      return false;
    }
    this.#pending = (this.#pending | bit) >>> 0;
    this.#wake?.();
    return true;
  }

  /** The Job's loop: publish what is pending, then wait for the next wakeup. */
  run(): void {
    this.#publish();
    this.#wake = () => this.#publish();
  }

  /** Cancellation: publish what is pending and stop. */
  cancel(): void {
    this.#cancelled = true;
    this.#publish();
    this.#wake = undefined;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  #publish(): void {
    while (this.#pending !== 0) {
      const signal = 31 - Math.clz32(this.#pending & -this.#pending);
      this.#pending = (this.#pending & ~(1 << signal)) >>> 0;
      this.#source.notify(signal | SIGNAL_FLAG);
    }
  }
}

/** A port that captures nothing (embedders without OS signals). */
export const NO_SIGNALS: SignalPort = {
  capture: () => () => {},
  raise: () => {},
};

/**
 * Run Signals (moonrun `SignalReceiver`): the guest's interest, where accepted signals go,
 * and the host capture. OS signals are captured only while a target is attached and the
 * guest is interested in them; a captured signal the Run does not accept gets its default
 * action (moonrun `apply_process_signal`).
 */
export class RunSignals {
  readonly #port: SignalPort;
  #interested = 0;
  /** `start_signal_handler`'s target. */
  #handler: CompletionSource | undefined;
  #sigwait: SigwaitSink | undefined;
  readonly #captures = new Map<number, () => void>();

  constructor(port: SignalPort = NO_SIGNALS) {
    this.#port = port;
  }

  /** `set_global_cancellation_signals` (scoped to this Run). */
  configure(known: readonly number[], selected: readonly number[]): void {
    this.#interested = (signalMask(selected) & signalMask(known)) >>> 0;
    this.#sync();
  }

  /** `start_signal_handler`: deliver to the thread pool's Completion Source. */
  start(target: CompletionSource): Result<void, AsyncError> {
    if (this.#handler !== undefined) {
      return ok(undefined);
    }
    if (this.#sigwait !== undefined) {
      return err(INVAL);
    }
    this.#handler = target;
    this.#sync();
    return ok(undefined);
  }

  /** `terminate_signal_handler`: drop the handler and its unfetched signals, clear interest. */
  stop(): void {
    this.#handler?.discardSignals();
    this.#handler = undefined;
    this.#interested = 0;
    this.#sync();
  }

  /** Detaches when the Completion Source it delivers to goes away. */
  detachFrom(source: CompletionSource): void {
    if (this.#handler === source) {
      this.stop();
    }
  }

  /** `make_sigwait_job` attaches its target; false when another target is attached. */
  attachSigwait(sink: SigwaitSink): boolean {
    if (this.#handler !== undefined || this.#sigwait !== undefined) {
      return false;
    }
    this.#sigwait = sink;
    this.#sync();
    return true;
  }

  detachSigwait(sink: SigwaitSink): void {
    if (this.#sigwait === sink) {
      this.#sigwait = undefined;
      this.#sync();
    }
  }

  get active(): boolean {
    return this.#handler !== undefined;
  }

  /** Offers a captured signal to the Run (moonrun `SignalSender::send`); true when accepted. */
  deliver(signal: number): boolean {
    const bit = signalBit(signal);
    if ((this.#interested & bit) === 0) {
      return false;
    }
    if (this.#handler !== undefined) {
      this.#handler.notifySignal(signal);
      return true;
    }
    return this.#sigwait?.send(bit) ?? false;
  }

  /** Captures exactly the brokered signals the Run would accept now. */
  #sync(): void {
    const attached = this.#handler !== undefined || this.#sigwait !== undefined;
    for (const signal of MANAGED_SIGNALS) {
      const wanted = attached && (this.#interested & signalBit(signal)) !== 0;
      const release = this.#captures.get(signal);
      if (wanted && release === undefined) {
        this.#captures.set(
          signal,
          this.#port.capture(signal, () => {
            if (!this.deliver(signal)) {
              this.#port.raise(signal);
            }
          }),
        );
      } else if (!wanted && release !== undefined) {
        this.#captures.delete(signal);
        release();
      }
    }
  }
}
