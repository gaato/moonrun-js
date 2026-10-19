import { demangleMangledFunctionName } from './demangle.ts';
import type { SourceMap } from './source-map.ts';

/** One line of an engine stack, after parsing (moonrun `DiagnosticLine`). */
export type DiagnosticLine =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'frame';
      readonly indentation: string;
      readonly fn: string;
      readonly moduleOffset: number | undefined;
    };

/** Port of moonrun `wasm_diagnostic::render`. */
export function render(
  lines: Iterable<DiagnosticLine>,
  sourceMap: SourceMap | undefined,
  noStackTrace: boolean,
): string {
  let result = '';
  let index = 0;
  for (const line of lines) {
    if (noStackTrace && index !== 0) {
      break;
    }
    if (index !== 0) {
      result += '\n';
    }
    if (line.kind === 'text') {
      result += line.text;
    } else {
      result += `${line.indentation}at ${demangleMangledFunctionName(line.fn)}`;
      if (sourceMap !== undefined && line.moduleOffset !== undefined) {
        const position = sourceMap.position(line.moduleOffset);
        if (position !== undefined) {
          result += ` ${position.file}:${position.line}`;
        }
      }
    }
    index++;
  }
  return result;
}
