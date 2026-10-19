import { readFileSync } from 'node:fs';
const b = readFileSync(process.argv[2]);
const m = new WebAssembly.Module(b, { builtins: ['js-string'], importedStringConstants: '_' });
console.log(JSON.stringify(WebAssembly.Module.imports(m)));
const i = new WebAssembly.Instance(m, {});
console.log(i.exports.f(), i.exports.g());
const m2 = new WebAssembly.Module(b);
console.log(JSON.stringify(WebAssembly.Module.imports(m2)));
