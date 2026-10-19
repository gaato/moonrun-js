import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import cp from 'node:child_process';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const R = {};
const rt = typeof Deno !== 'undefined' ? 'deno' : typeof Bun !== 'undefined' ? 'bun' : 'node';
R.runtime = rt + ' ' + (process.versions.node);
const T = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT ' + label)), ms))]);
const err = (e) => ({ error: String(e && e.message || e), code: e && e.code, errno: e && e.errno });
const once = (em, ev) => new Promise((res) => em.once(ev, (...a) => res(a)));

async function check1() {
  const o = R.c1_partial = {};
  const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true });
  const events = {};
  const serverSock = new Promise((res) => server.on('connection', res));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  o.address = server.address();
  const port = server.address().port;
  const c = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  c.on('connect', () => events.connect = true);
  const cdata = [];
  c.on('data', (d) => cdata.push(d.toString()));
  let cEnd = false; c.on('end', () => cEnd = true);
  await T(once(c, 'connect'), 3000, 'connect');
  o.connectEvent = !!events.connect;
  const s = await T(serverSock, 3000, 'server conn');
  o.serverPausedOnConnect = s.isPaused ? s.isPaused() : 'no isPaused';
  o.writableNeedDrainType = typeof c.writableNeedDrain;
  o.writableNeedDrainInitial = c.writableNeedDrain;
  o.setNoDelay = typeof c.setNoDelay; o.setKeepAlive = typeof c.setKeepAlive;
  try { c.setNoDelay(true); c.setKeepAlive(true, 1000); o.setNoDelayCall = 'ok'; } catch (e) { o.setNoDelayCall = err(e); }
  // drain: server paused, write 16MiB
  const big = Buffer.alloc(16 * 1024 * 1024, 1);
  const ok = c.write(big);
  o.writeReturned = ok;
  o.needDrainAfterBigWrite = c.writableNeedDrain;
  let drained = false;
  const dp = once(c, 'drain').then(() => drained = true);
  // now resume server and count
  let got = 0;
  s.on('data', (d) => got += d.length);
  let sEnd = false; s.on('end', () => sEnd = true);
  s.resume();
  o.resumeAfterPause = 'called';
  try { await T(dp, 5000, 'drain'); } catch (e) { o.drainErr = String(e.message); }
  o.drainEvent = drained;
  await new Promise((r) => setTimeout(r, 300));
  o.serverReceivedBytes = got;
  // half close
  c.end();
  await T(new Promise((res) => { if (sEnd) res(); else s.once('end', res); }), 3000, 'server end').catch((e) => o.serverEndErr = String(e.message));
  o.serverGotEnd = sEnd;
  o.serverWritableAfterEnd = s.writable;
  s.write('pong');
  await new Promise((r) => setTimeout(r, 300));
  o.clientReceivedAfterHalfClose = cdata.join('');
  s.end();
  await new Promise((r) => setTimeout(r, 200));
  o.clientGotEnd = cEnd;
  c.destroy(); s.destroy();
  // destroy(err)
  const s2p = new Promise((res) => server.once('connection', res));
  const c2 = net.connect({ host: '127.0.0.1', port });
  const c2conn = once(c2, 'connect'); let order = [];
  c2conn.then(() => order.push('client-connect')); s2p.then(() => order.push('server-connection'));
  const s2 = await T(s2p, 3000, 's2');
  const errP = new Promise((res) => c2.on('error', res));
  await T(c2conn, 3000, 'c2 connect');
  await new Promise((r) => setTimeout(r, 20)); o.connectOrder = order;
  c2.destroy(new Error('boom'));
  const e2 = await T(errP, 2000, 'destroy err').catch((e) => e);
  o.destroyErr = e2 && e2.message;
  s2.destroy();
  await new Promise((r) => server.close(r));
  // ECONNREFUSED
  o.econnrefused = await T(new Promise((res) => { const x = net.connect({ host: '127.0.0.1', port }); x.on('error', (e) => res({ code: e.code, errno: e.errno, syscall: e.syscall, message: e.message })); x.on('connect', () => res('connected?!')); }), 3000, 'refused').catch((e) => String(e.message));
  // IPv6
  try {
    const s6 = net.createServer();
    await new Promise((res, rej) => { s6.once('error', rej); s6.listen(0, '::1', res); });
    o.ipv6 = s6.address();
    const c6 = net.connect({ host: '::1', port: s6.address().port });
    await T(once(c6, 'connect'), 2000, 'c6');
    o.ipv6connect = true; c6.destroy();
    s6.close();
  } catch (e) { o.ipv6 = err(e); }
  return o;
}

async function check2() {
  const o = {};
  const a = dgram.createSocket('udp4');
  await new Promise((res, rej) => { a.once('error', rej); a.bind(0, '127.0.0.1', res); });
  o.address = a.address();
  const msg = once(a, 'message');
  await new Promise((res, rej) => a.send(Buffer.from('hello'), a.address().port, '127.0.0.1', (e) => e ? rej(e) : res()));
  const [m, rinfo] = await T(msg, 2000, 'udp');
  o.msg = m.toString(); o.rinfo = rinfo; o.msgIsBuffer = Buffer.isBuffer(m) || m instanceof Uint8Array;
  a.close();
  return o;
}

async function check3() {
  const o = {};
  o.lookupAll = await new Promise((res) => dns.lookup('localhost', { all: true, order: 'verbatim' }, (e, r) => res(e ? err(e) : r)));
  o.lookupInvalid = await new Promise((res) => dns.lookup('nonexistent.invalid', (e, a, f) => res(e ? { ...err(e), syscall: e.syscall, hostname: e.hostname, message: e.message } : { a, f })));
  return o;
}

async function check4() {
  const o = {};
  const c = cp.spawn('sh', ['-c', 'echo out; echo err 1>&2; exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnEv = false; c.on('spawn', () => spawnEv = true);
  let so = '', se = '';
  c.stdout.on('data', (d) => so += d); c.stderr.on('data', (d) => se += d);
  o.pidType = typeof c.pid;
  const [code, sig] = await T(once(c, 'exit'), 3000, 'exit');
  await new Promise((r) => setTimeout(r, 100));
  o.exit = { code, sig }; o.spawnEvent = spawnEv; o.stdout = so; o.stderr = se;
  // fd redirection
  const tmp = path.join(os.tmpdir(), 'probe-fd-' + process.pid);
  const fd = fs.openSync(tmp, 'w');
  try {
    const c2 = cp.spawn('sh', ['-c', 'echo tofile; echo e2 1>&2'], { stdio: ['ignore', fd, fd] });
    const [code2] = await T(once(c2, 'exit'), 3000, 'exit2');
    o.fdExit = code2;
  } catch (e) { o.fdErr = err(e); }
  fs.closeSync(fd);
  o.fdFileContent = fs.readFileSync(tmp, 'utf8'); fs.unlinkSync(tmp);
  // ENOENT
  const c3 = cp.spawn('definitely-not-a-command-xyz', []);
  const e3 = await T(once(c3, 'error'), 3000, 'enoent').catch((e) => [e]);
  o.enoent = { code: e3[0].code, errno: e3[0].errno, syscall: e3[0].syscall, pid: c3.pid };
  // kill
  const c4 = cp.spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(c4, 'spawn');
  o.killPid = typeof c4.pid;
  const r = c4.kill('SIGTERM');
  const [k, ks] = await T(once(c4, 'exit'), 3000, 'kill');
  o.kill = { returned: r, code: k, signal: ks, killed: c4.killed, signalCode: c4.signalCode, exitCode: c4.exitCode };
  return o;
}

async function check5() {
  const o = {};
  o.hasGetCA = typeof tls.getCACertificates;
  if (typeof tls.getCACertificates === 'function') {
    for (const k of ['system', 'bundled', 'default', 'extra']) {
      try { const r = tls.getCACertificates(k); o[k] = Array.isArray(r) ? r.length : typeof r; } catch (e) { o[k] = err(e); }
    }
    try { const r = tls.getCACertificates(); o.noarg = Array.isArray(r) ? r.length : typeof r; } catch (e) { o.noarg = err(e); }
  }
  try { o.rootCertificatesLen = tls.rootCertificates.length; } catch (e) { o.rootCertificatesLen = err(e); }
  return o;
}

function check6() {
  const o = {};
  try { const n = fs.writeSync(1, Buffer.from('')); o.writeSyncEmpty = n; } catch (e) { o.writeSyncEmpty = err(e); }
  try { const n = fs.writeSync(2, Buffer.from('')); o.writeSyncStderrEmpty = n; } catch (e) { o.writeSyncStderrEmpty = err(e); }
  try { const st = fs.fstatSync(0); o.stdin = { isFIFO: st.isFIFO(), isFile: st.isFile(), isCharDev: st.isCharacterDevice(), isSocket: st.isSocket() }; } catch (e) { o.stdin = err(e); }
  try { const st = fs.fstatSync(1); o.stdout = { isFIFO: st.isFIFO(), isFile: st.isFile(), isCharDev: st.isCharacterDevice() }; } catch (e) { o.stdout = err(e); }
  const buf = Buffer.alloc(64);
  const reads = []; const errs = [];
  for (let i = 0; i < 3; i++) {
    try { const n = fs.readSync(0, buf, 0, 64, null); reads.push(n === 0 ? 0 : buf.subarray(0, n).toString()); if (n === 0) break; } catch (e) { errs.push(e.code || String(e.message)); break; }
  }
  o.readSync = { reads, errs };
  return o;
}

function check7() {
  const o = {};
  o.onOff = [typeof process.on, typeof process.off, typeof process.removeListener, typeof process.removeAllListeners];
  try { const h = () => {}; process.on('SIGINT', h); process.off('SIGINT', h); o.sigintRegisterRemove = 'ok'; o.sigintListenersAfter = process.listenerCount('SIGINT'); } catch (e) { o.sigintRegisterRemove = err(e); }
  return new Promise((res) => {
    let got = false;
    try {
      process.on('SIGUSR2', () => { got = true; });
      process.kill(process.pid, 'SIGUSR2');
    } catch (e) { o.sigusr2 = err(e); return res(o); }
    setTimeout(() => { o.sigusr2Delivered = got; process.removeAllListeners('SIGUSR2'); res(o); }, 300);
  });
}

function check8() {
  const o = {};
  o.Suspending = typeof WebAssembly.Suspending; o.promising = typeof WebAssembly.promising;
  o.JSPI_other = Object.getOwnPropertyNames(WebAssembly).filter((k) => /susp|promis|Stack|Exception|Tag/i.test(k));
  o.setImmediate = typeof setImmediate; o.MessageChannel = typeof MessageChannel;
  try { const sab = new SharedArrayBuffer(8); const ia = new Int32Array(sab); const t = performance.now(); const r = Atomics.wait(ia, 0, 0, 1); o.atomicsWait = { r, ms: +(performance.now() - t).toFixed(1) }; } catch (e) { o.atomicsWait = err(e); }
  return o;
}

function check9() {
  const o = {};
  try { o.perfNow = typeof performance.now() ; } catch (e) { o.perfNow = err(e); }
  try { o.getRandomValues = crypto.getRandomValues(new Uint8Array(4)).length; } catch (e) { o.getRandomValues = err(e); }
  try { o.hrtimeBigint = typeof process.hrtime.bigint(); } catch (e) { o.hrtimeBigint = err(e); }
  return o;
}

const run = async (name, f) => { try { R[name] = await T(Promise.resolve(f()), 20000, name); } catch (e) { R[name] = err(e); } };
// check6 first (stdin) before anything else touches it
await run('c6_fs_sync_stdio', check6);
await run('c1_net', check1);
await run('c2_dgram', check2);
await run('c3_dns', check3);
await run('c4_child_process', check4);
await run('c5_tls', check5);
await run('c7_signals', check7);
await run('c8_misc', check8);
await run('c9_timing', check9);
fs.writeSync(1, Buffer.from(JSON.stringify(R) + '\n'));
process.exit(0);
