import { readFileSync } from 'node:fs';
const bytes = readFileSync(process.argv[2]);
const tag = new WebAssembly.Tag({ parameters: [] });
const out = {};
const wait = new WebAssembly.Suspending((mode) => {
  if (mode === 0) return 7; // non-promise
  if (mode === 2) return new Promise(() => {}); // forever
  return new Promise((r) => setTimeout(() => r(1), 1));
});
const imports = { h: { wait, sync: (x) => 1 }, exception: { tag, throw: () => { throw new WebAssembly.Exception(tag, [], { traceStack: true }); } } };
const { instance } = await WebAssembly.instantiate(bytes, imports);
const e = instance.exports;
const P = (f) => WebAssembly.promising(f);
try { await P(e.trap_after_resume)(); } catch (err) { out.trap = { ctor: err.constructor.name, isRuntimeError: err instanceof WebAssembly.RuntimeError, msg: err.message, stack: String(err.stack).split('\n').slice(0, 8) }; }
try { await P(e.throw_after_resume)(); } catch (err) { out.throw = { isExc: err instanceof WebAssembly.Exception, is: err.is?.(tag), stack: String(err.stack).split('\n').slice(0, 5) }; }
try { e.inner(1); } catch (err) { out.noPromising = { ctor: err.constructor.name, msg: err.message }; }
let t0 = performance.now(); e.loop_sync(1e6); out.syncPerCallNs = ((performance.now() - t0) * 1e6) / 1e6;
t0 = performance.now(); await P(e.loop_wait_nopromise)(1e6); out.suspendingNonPromisePerCallNs = ((performance.now() - t0) * 1e6) / 1e6;
const depth = (f) => { let lo = 1, hi = 1 << 24; while (lo < hi) { const m = (lo + hi + 1) >> 1; try { f(m); lo = m; } catch { hi = m - 1; } } return lo; };
out.recDepthMain = depth((n) => e.rec(n));
// depth on suspended (secondary) stack
let lo = 1, hi = 1 << 24; while (lo < hi) { const m = (lo + hi + 1) >> 1; try { await P(e.rec_after_resume)(m); lo = m; } catch { hi = m - 1; } } out.recDepthAfterResume = lo;
try { await P(e.rec_after_resume)(lo + 1000); } catch (err) { out.overflowErr = { ctor: err.constructor.name, msg: err.message }; }
// forever-pending freeze: does the process exit with pending promise? race with timeout
const frozen = P(e.freeze)(); const r = await Promise.race([frozen.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('timeout'), 20))]);
out.freeze = r;
out.stackTraceLimit = Error.stackTraceLimit;
console.log(JSON.stringify(out, null, 1));
