// The WebAssembly JS API surface moonrun-js relies on, including JSPI and
// compile-time builtins. TypeScript only ships these in lib.dom, which the core
// must not depend on.

declare namespace WebAssembly {
  type ImportValue = unknown;
  type ModuleImports = Record<string, ImportValue>;
  type Imports = Record<string, ModuleImports>;
  type Exports = Record<string, unknown>;
  type ImportExportKind = 'function' | 'table' | 'memory' | 'global' | 'tag';

  interface ModuleImportDescriptor {
    readonly module: string;
    readonly name: string;
    readonly kind: ImportExportKind;
  }
  interface ModuleExportDescriptor {
    readonly name: string;
    readonly kind: ImportExportKind;
  }

  interface CompileOptions {
    builtins?: string[];
    importedStringConstants?: string;
  }

  class Module {
    constructor(bytes: BufferSource, options?: CompileOptions);
    static imports(module: Module): ModuleImportDescriptor[];
    static exports(module: Module): ModuleExportDescriptor[];
    static customSections(module: Module, name: string): ArrayBuffer[];
  }

  class Instance {
    constructor(module: Module, imports?: Imports);
    readonly exports: Exports;
  }

  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }

  interface TagType {
    parameters: string[];
  }
  class Tag {
    constructor(type: TagType);
  }

  interface ExceptionOptions {
    traceStack?: boolean;
  }
  class Exception {
    constructor(tag: Tag, payload: unknown[], options?: ExceptionOptions);
    is(tag: Tag): boolean;
    getArg(tag: Tag, index: number): unknown;
    readonly stack?: string;
  }

  class CompileError extends Error {}
  class LinkError extends Error {}
  class RuntimeError extends Error {}

  // JS Promise Integration.
  class Suspending {
    constructor(fn: (...args: never[]) => unknown);
  }
  function promising<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<R>;

  function validate(bytes: BufferSource, options?: CompileOptions): boolean;
  function compile(bytes: BufferSource, options?: CompileOptions): Promise<Module>;
}

type BufferSource = ArrayBufferView | ArrayBuffer;
