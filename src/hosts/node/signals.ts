import type { SignalPort } from '../../ports/process.ts';

/** Linux signal numbers by name (asm-generic; x86-64 and aarch64 agree). */
export const LINUX_SIGNALS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

/** The host's name of a Linux signal number. */
export function signalName(signal: number): NodeJS.Signals | undefined {
  for (const [name, number] of Object.entries(LINUX_SIGNALS)) {
    if (number === signal) {
      return name as NodeJS.Signals;
    }
  }
  return undefined;
}

/** Listeners this module installed, per signal (the process is global, so is this). */
const captured = new Map<NodeJS.Signals, Set<() => void>>();

/** OS signals through `process.on`: installed only while a Run captures them. */
export function nodeSignals(): SignalPort {
  return {
    capture: (signal, handler) => {
      const name = signalName(signal);
      if (name === undefined) {
        return () => {};
      }
      const listener = (): void => handler();
      let set = captured.get(name);
      if (set === undefined) {
        set = new Set();
        captured.set(name, set);
      }
      set.add(listener);
      process.on(name, listener);
      return () => {
        set.delete(listener);
        process.off(name, listener);
      };
    },
    raise: (signal) => {
      const name = signalName(signal);
      if (name === undefined) {
        return;
      }
      // With no listener left, libuv restores the default action and the signal applies.
      for (const listener of captured.get(name) ?? []) {
        process.off(name, listener);
      }
      captured.delete(name);
      process.kill(process.pid, name);
    },
  };
}
