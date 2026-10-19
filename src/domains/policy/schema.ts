import { rustDebugStr, rustFloatDebug } from './rust-fmt.ts';

/**
 * The serde shape of moonrun's `PolicyConfig`. One schema drives the JSON, TOML and YAML
 * deserializers so that all of them produce serde's messages for the same mistakes.
 */
export type Schema =
  | { readonly k: 'struct'; readonly name: string; readonly fields: readonly FieldDef[] }
  | { readonly k: 'seq'; readonly item: Schema }
  | { readonly k: 'stringMap' }
  | { readonly k: 'string' }
  | { readonly k: 'path' }
  | { readonly k: 'bool' };

export interface FieldDef {
  readonly name: string;
  readonly schema: Schema;
  /** `option`: `Option<T>`; `default`: `#[serde(default)]`; `required`: neither. */
  readonly mode: 'option' | 'default' | 'required';
}

/** A deserialized value: structs are plain objects, `Option::None` is `null`, maps are `Map`s. */
export type Value = null | boolean | string | readonly Value[] | Map<string, string> | Struct;
export interface Struct {
  readonly [field: string]: Value;
}

export function expecting(schema: Schema): string {
  switch (schema.k) {
    case 'struct':
      return `struct ${schema.name}`;
    case 'seq':
      return 'a sequence';
    case 'stringMap':
      return 'a map';
    case 'string':
      return 'a string';
    case 'path':
      return 'path string';
    case 'bool':
      return 'a boolean';
  }
}

/** serde's `Unexpected`, as far as the supported formats can produce it. */
export type Unexpected =
  | { readonly k: 'unit' }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'int'; readonly text: string }
  | { readonly k: 'float'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'seq' }
  | { readonly k: 'map' };

/** `Unexpected`'s Display. serde_json prints the unit value as `null`; callers pass `jsonNull`. */
export function describeUnexpected(u: Unexpected, jsonNull: boolean): string {
  switch (u.k) {
    case 'unit':
      return jsonNull ? 'null' : 'unit value';
    case 'bool':
      return `boolean \`${u.v}\``;
    case 'int':
      return `integer \`${u.text}\``;
    case 'float':
      return `floating point \`${rustFloatDebug(u.v)}\``;
    case 'str':
      return `string ${rustDebugStr(u.v)}`;
    case 'seq':
      return 'sequence';
    case 'map':
      return 'map';
  }
}

export function invalidType(u: Unexpected, schema: Schema, jsonNull: boolean): string {
  return `invalid type: ${describeUnexpected(u, jsonNull)}, expected ${expecting(schema)}`;
}

export function unknownField(name: string, fields: readonly FieldDef[]): string {
  const names = fields.map((f) => `\`${f.name}\``);
  let expected: string;
  if (names.length === 1) {
    expected = names[0] ?? '';
  } else if (names.length === 2) {
    expected = `${names[0]} or ${names[1]}`;
  } else {
    expected = `one of ${names.join(', ')}`;
  }
  return `unknown field \`${name}\`, expected ${expected}`;
}

export function invalidLength(len: number, schema: Schema & { k: 'struct' }): string {
  return `invalid length ${len}, expected struct ${schema.name} with ${schema.fields.length} elements`;
}

export function defaultOf(schema: Schema): Value {
  switch (schema.k) {
    case 'seq':
      return [];
    case 'stringMap':
      return new Map();
    case 'bool':
      return false;
    case 'string':
    case 'path':
      return '';
    case 'struct':
      return {};
  }
}

// --- The policy document -------------------------------------------------------------------

const seqOf = (item: Schema): Schema => ({ k: 'seq', item });
const field = (name: string, schema: Schema, mode: FieldDef['mode']): FieldDef => ({
  name,
  schema,
  mode,
});

export const PROCESS_RULE: Schema = {
  k: 'struct',
  name: 'ProcessRuleConfig',
  fields: [
    field('program', { k: 'string' }, 'required'),
    field('args_prefix', seqOf({ k: 'string' }), 'default'),
  ],
};

export const POLICY_SCHEMA: Schema & { k: 'struct' } = {
  k: 'struct',
  name: 'PolicyConfig',
  fields: [
    field(
      'fs',
      {
        k: 'struct',
        name: 'FsConfig',
        fields: [
          field('read', seqOf({ k: 'path' }), 'default'),
          field('write', seqOf({ k: 'path' }), 'default'),
        ],
      },
      'option',
    ),
    field(
      'net',
      {
        k: 'struct',
        name: 'NetConfig',
        fields: [
          field('dns', seqOf({ k: 'string' }), 'default'),
          field('connect', seqOf({ k: 'string' }), 'default'),
          field('bind', seqOf({ k: 'string' }), 'default'),
        ],
      },
      'option',
    ),
    field(
      'env',
      {
        k: 'struct',
        name: 'EnvConfig',
        fields: [
          field('from_host', seqOf({ k: 'string' }), 'default'),
          field('required_from_host', seqOf({ k: 'string' }), 'default'),
          field('set', { k: 'stringMap' }, 'default'),
        ],
      },
      'option',
    ),
    field(
      'process',
      {
        k: 'struct',
        name: 'ProcessConfig',
        fields: [
          field('spawn', { k: 'bool' }, 'default'),
          field('allow', seqOf(PROCESS_RULE), 'default'),
        ],
      },
      'option',
    ),
  ],
};
