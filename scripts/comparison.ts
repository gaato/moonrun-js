/** D12: sort result records inside each protocol block as well as the blocks. */
export function unorderedResults(stdout: string): string {
  const records: string[] = [];
  const rest = stdout.replace(
    /----- BEGIN MOON TEST RESULT -----\n([\s\S]*?)\n----- END MOON TEST RESULT -----\n/g,
    (block, body: string) => {
      const lines = body.split('\n');
      // Sort only protocol JSON records. Preserve malformed or arbitrary output.
      if (
        !lines.every((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return (
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              (value.type === 'result' || value.type === 'start')
            );
          } catch {
            return false;
          }
        })
      )
        return block;
      records.push(...lines);
      return '';
    },
  );
  return `${rest}\0${records.sort().join('\n')}`;
}

/** D3: unavailable JSC frame names/locations; applies to stderr only. */
export function jscStderr(stderr: string): string {
  return stderr
    .replace(/^( {4,})at [^\n]+$/gm, '$1at <D3>')
    .replace(
      /(Uncaught CompileError: )WebAssembly\.Module\(\): expected magic word [^\n]+ @\+0/g,
      '$1invalid wasm magic',
    )
    .replace(
      /(Uncaught CompileError: )WebAssembly\.Module doesn't parse at byte 0: module doesn't start with '\\0asm'(?: \(evaluating '[^\n]*'\))?/g,
      '$1invalid wasm magic',
    )
    .replace(
      /LinkError: WebAssembly\.Instance\(\): Import #\d+ "([^"]+)" "([^"]+)": function import requires a callable/g,
      'LinkError: callable import $1:$2 required',
    )
    .replace(
      /LinkError: import function ([^\s]+) must be callable(?: \(evaluating '[^\n]*'\))?/g,
      'LinkError: callable import $1 required',
    );
}
