import type { CompletionSource } from './completion.ts';

/**
 * Run Signals: the guest's cancellation-signal selection and where accepted
 * signals go. Capturing OS signals is the host's job (P5); it calls
 * {@link RunSignals.deliver}, and falls back to the default action when that
 * returns false.
 */
export class RunSignals {
  #known: readonly number[] = [];
  #selected: ReadonlySet<number> = new Set();
  #target: CompletionSource | undefined;

  /** `set_global_cancellation_signals` (scoped to this Run). */
  configure(known: readonly number[], selected: readonly number[]): void {
    this.#known = known;
    this.#selected = new Set(selected);
  }

  /** `start_signal_handler`: deliver to the thread pool's Completion Source. */
  start(target: CompletionSource): void {
    this.#target ??= target;
  }

  /** `terminate_signal_handler`: stop delivery and drop accepted, unfetched signals. */
  stop(): void {
    this.#target?.discardSignals();
    this.#target = undefined;
  }

  /** Detaches when the Completion Source it delivers to goes away. */
  detachFrom(source: CompletionSource): void {
    if (this.#target === source) {
      this.stop();
    }
  }

  get known(): readonly number[] {
    return this.#known;
  }

  get selected(): ReadonlySet<number> {
    return this.#selected;
  }

  get active(): boolean {
    return this.#target !== undefined;
  }

  /** Offers a captured signal to the Run; true when it was accepted. */
  deliver(signal: number): boolean {
    if (this.#target === undefined || !this.#selected.has(signal)) {
      return false;
    }
    this.#target.notifySignal(signal);
    return true;
  }
}
