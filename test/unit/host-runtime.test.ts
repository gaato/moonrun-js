import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const files = new URL('../../src/hosts/node/files.ts', import.meta.url).href;
const net = new URL('../../src/hosts/node/net.ts', import.meta.url).href;
mkdirSync(new URL('../../.cache/deno', import.meta.url), { recursive: true });

for (const runtime of ['node', 'deno', 'bun']) {
  describe.skipIf(spawnSync(runtime, ['--version']).status !== 0)(
    `${runtime} host contracts`,
    () => {
      it('iterates directories, preserves successful void callbacks and reports missing paths', () => {
        const code = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {nodeFiles} from ${JSON.stringify(files)};
        const root = fs.mkdtempSync('.cache/host-contract-');
        const port = nodeFiles(root);
        try {
          fs.writeFileSync(root + '/entry', 'hello');
          assert.deepEqual(port.readDir('.'), {ok:true,value:[{name:Buffer.from('entry'),kind:'file'}]});
          const opened = port.async.openPath('.');
          assert.ok(opened.ok);
          const reader = await port.async.openDirectory(opened.value);
          assert.ok(reader.ok);
          const next = await reader.value.next();
          assert.ok(next.ok && next.value !== null);
          assert.equal(new TextDecoder().decode(next.value.name), 'entry');
          assert.equal(next.value.type, 8);
          assert.ok(next.value.ino > 0n);
          reader.value.close();
          port.close(opened.value);
          assert.deepEqual(await port.async.unlink('entry'), {ok:true,value:undefined});
          const missing = await port.async.unlink('entry');
          assert.ok(!missing.ok);
          assert.equal(missing.error.code, 'ENOENT');
        } finally { fs.rmSync(root,{recursive:true,force:true}); }
      `;
        check(runtime, code);
      });

      it('keeps a duplicate directory watch alive across ancestor and child renames', () => {
        const code = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {nodeFiles} from ${JSON.stringify(files)};
        const root=fs.mkdtempSync('.cache/watch-contract-');
        fs.mkdirSync(root+'/inner');
        fs.writeFileSync(root+'/inner/a','a');
        const port=nodeFiles(root);
        let resolve;
        const listener=()=>resolve?.();
        const first=port.async.watch('inner',listener), second=port.async.watch('inner',listener);
        assert.ok(first.ok && second.ok);
        first.value.close();
        const event=async(action)=>{
          let timer;
          try {
            await new Promise((done,reject)=>{
              resolve=done;
              timer=setTimeout(()=>reject(new Error('watch lost after rename')),1000);
              action();
            });
          }finally{clearTimeout(timer);resolve=undefined;}
        };
        try{
          await event(()=>fs.renameSync(root+'/inner',root+'/moved'));
          await event(()=>fs.renameSync(root+'/moved/a',root+'/moved/b'));
        }finally{second.value.close();fs.rmSync(root,{recursive:true,force:true});}
      `;
        check(runtime, code);
      });

      it('delivers an accepted datagram even when the sender closes immediately', () => {
        const code = `
        import assert from 'node:assert/strict';
        import {nodeNet} from ${JSON.stringify(net)};
        const host = nodeNet();
        let server, client;
        await new Promise((resolve,reject) => {
          const timer = setTimeout(()=>reject(new Error('datagram lost on close')),2000);
          const events = {listening:()=>{},connected:()=>{},message:()=>{},error:reject};
          server=host.datagram(4,{reuseAddr:false,reusePort:false,ipv6Only:false},{...events,
            listening:()=>{
              client=host.datagram(4,{reuseAddr:false,reusePort:false,ipv6Only:false},{...events,
                connected:()=>{client.send(new TextEncoder().encode('hello'));client.close();}
              });
              client.connect(server.localAddress());
            },
            message:(bytes)=>{assert.equal(new TextDecoder().decode(bytes),'hello');clearTimeout(timer);server.close();resolve();}
          });
          server.bind({family:4,ip:new Uint8Array([127,0,0,1]),port:0,scopeId:0,flowInfo:0});
        }).finally(()=>{server?.close();client?.close()});
      `;
        check(runtime, code);
      });
    },
  );
}

function check(runtime: string, code: string): void {
  const args =
    runtime === 'node'
      ? ['--input-type=module', '-e', code]
      : runtime === 'deno'
        ? ['eval', code]
        : ['-e', code];
  const result = spawnSync(runtime, args, {
    cwd: repo,
    timeout: 5000,
    encoding: 'utf8',
    env: { ...process.env, DENO_DIR: `${repo}/.cache/deno` },
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}
