/** How a run was asked to stop. The first request wins (moonrun `TerminationRequest`). */
export type Termination =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: number };

export class TerminationCell {
  #request: Termination | undefined;

  request(termination: Termination): void {
    this.#request ??= termination;
  }

  get current(): Termination | undefined {
    return this.#request;
  }
}

/**
 * Thrown by exit imports to unwind the guest. MoonBit output contains no catch
 * instructions, so the guest cannot intercept it; the engine checks the cell first anyway.
 */
export class TerminationSignal extends Error {
  constructor() {
    super('moonrun-js termination');
    this.name = 'TerminationSignal';
  }
}
