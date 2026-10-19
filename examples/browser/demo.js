import { runInWorker } from '/dist/browser/index.js';

const form = document.querySelector('#run-form');
const button = document.querySelector('#run');
const status = document.querySelector('#status');
async function runDemo(event) {
  event.preventDefault();
  button.disabled = true;
  const stdout = document.querySelector('#stdout');
  const stderr = document.querySelector('#stderr');
  stdout.textContent = '';
  stderr.textContent = '';
  const outDecoder = new TextDecoder();
  const errDecoder = new TextDecoder();
  status.textContent = 'Preparing…';
  try {
    const args = JSON.parse(document.querySelector('#args').value);
    const env = JSON.parse(document.querySelector('#env').value);
    if (!Array.isArray(args) || !args.every((v) => typeof v === 'string'))
      throw new Error('Arguments must be an array of strings');
    if (
      env === null ||
      Array.isArray(env) ||
      typeof env !== 'object' ||
      !Object.values(env).every((v) => typeof v === 'string')
    )
      throw new Error('Environment must be an object of strings');
    const file = document.querySelector('#wasm').files[0];
    let bytes;
    if (file) bytes = await file.arrayBuffer();
    else {
      const url = document.querySelector('#url').value;
      if (!url) throw new Error('Select a wasm file or enter a URL');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Guest fetch: HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    }
    const files = Object.create(null);
    for (const f of document.querySelector('#files').files)
      files[f.name] = new Uint8Array(await f.arrayBuffer());
    const relay = new URL('/relay', location.href);
    relay.protocol = 'ws:';
    relay.search = location.search;
    status.textContent = 'Running…';
    const result = await runInWorker({
      wasm: new Uint8Array(bytes),
      name: file?.name ?? 'program.wasm',
      args,
      env,
      files,
      stdin: new TextEncoder().encode(document.querySelector('#stdin').value),
      relay: relay.href,
      stdout: (chunk) => {
        stdout.textContent += outDecoder.decode(chunk, { stream: true });
      },
      stderr: (chunk) => {
        stderr.textContent += errDecoder.decode(chunk, { stream: true });
      },
    });
    const exit =
      result.kind === 'completed' ? 0 : result.kind === 'exited' ? result.code : undefined;
    status.textContent = exit === undefined ? result.kind : `Exit ${exit} (${result.kind})`;
    if (result.kind === 'host-failure')
      stderr.textContent += `${result.failure.chain.join('\n')}\n`;
  } catch (error) {
    status.textContent = 'Failed';
    stderr.textContent += `${String(error)}\n`;
  } finally {
    stdout.textContent += outDecoder.decode();
    stderr.textContent += errDecoder.decode();
    button.disabled = false;
  }
}
form.addEventListener('submit', (event) => {
  void runDemo(event);
});
