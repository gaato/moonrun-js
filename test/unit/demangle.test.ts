import { describe, expect, it } from 'vitest';

import { demangleMangledFunctionName as demangle } from '../../src/diagnostics/demangle.ts';

describe('demangleMangledFunctionName', () => {
  it('demangle tags', () => {
    expect(demangle('_M0FP13pkg3foo')).toBe('@pkg.foo');
    expect(demangle('_M0MP13pkg4Type3bar')).toBe('@pkg.Type::bar');
    expect(demangle('_M0IP13pkg4ImplP13pkg5Trait3run')).toBe(
      'impl @pkg.Trait for @pkg.Impl with run',
    );
    expect(demangle('_M0EP13pkg4TypeP14util3new')).toBe('@util.pkg.Type::new');
    expect(demangle('_M0L3fooS0')).toBe('foo/0');
    expect(demangle('_M0Lm7$foo.fnS12')).toBe('foo/12');
  });

  it('demangle type args and identifier escapes', () => {
    expect(demangle('_M0FP13pkg3fooGiE')).toBe('@pkg.foo[Int]');
    expect(demangle('_M0FP13pkg4a__b')).toBe('@pkg.a_b');
    expect(demangle('_M0FP13pkg5a_2db')).toBe('@pkg.a-b');
    expect(demangle('_M0EP211moonbitlang4core4TypeP14util3new')).toBe('@util.Type::new');
  });

  it('demangle name mangling reference elements', () => {
    expect(demangle('_M0FPB5print')).toBe('@moonbitlang/core/builtin.print');
    expect(demangle('_M0FP15myapp5outerN5inner')).toBe('_M0FP15myapp5outerN5inner');
    expect(demangle('_M0FP15myapp5outerN5innerS42')).toBe('@myapp.outer.inner[stamp=42]');
    expect(demangle('_M0FP15myapp5outerC0')).toBe('@myapp.outer.anonymous[uuid=0]');
    expect(demangle('_M0FP15myapp5outerC245l10')).toBe('@myapp.outer.anonymous[uuid=245,line=10]');
    expect(demangle('_M0IP05outerL5LocalP311moonbitlang4core7builtin7Default7defaultGiE')).toBe(
      'impl @moonbitlang/core/builtin.Default for outer.Local[Int] with default',
    );
    expect(demangle('_M0L1xS123')).toBe('x/123');
    expect(demangle('_M0Lm1yS124')).toBe('y/124');
    expect(demangle('_M0L6_2atmpS9127')).toBe('*tmp/9127');
    expect(demangle('_M0FP03foo')).toBe('foo');
  });

  it('demangle name mangling reference type args', () => {
    expect(demangle('_M0FP15myapp3zipGisE')).toBe('@myapp.zip[Int, String]');
    expect(demangle('_M0FP15myapp8try__mapGiEHRP15myapp7MyError')).toBe(
      '@myapp.try_map[Int] raise @myapp.MyError',
    );
    expect(demangle('_M0FP15myapp5applyGWiEsE')).toBe('@myapp.apply[(Int) -> String]');
    expect(demangle('_M0FP15myapp3runGVWiEsE')).toBe('@myapp.run[async (Int) -> String]');
    expect(demangle('_M0FP15myapp8try__runGWiEsQRP15myapp7MyErrorE')).toBe(
      '@myapp.try_run[(Int) -> String raise @myapp.MyError]',
    );
    expect(demangle('_M0FP15myapp7complexGARP311moonbitlang4core4list4ListGiEE')).toBe(
      '@myapp.complex[FixedArray[@moonbitlang/core/list.List[Int]]]',
    );
    expect(demangle('_M0EP311moonbitlang4core7builtin3IntP15myapp6double')).toBe(
      '@myapp.Int::double',
    );
    expect(demangle('_M0FP28my_2dorg8my_2dlib3foo')).toBe('@my-org/my-lib.foo');
  });

  it('demangle generated native symbol samples', () => {
    expect(demangle('_M0FP29moonbuild20demangle__standalone8demangle')).toBe(
      '@moonbuild/demangle_standalone.demangle',
    );
    expect(
      demangle(
        '_M0FP29moonbuild36demangle__standalone__blackbox__test57____test__64656d616e676c655f746573742e6d6274__4_2edyncall$closure.data',
      ),
    ).toBe(
      '@moonbuild/demangle_standalone_blackbox_test.__test_64656d616e676c655f746573742e6d6274_4.dyncall',
    );
    expect(
      demangle(
        '_M0FP0119moonbitlang_2fcore_2fbuiltin_2fStringBuilder_2eas___40moonbitlang_2fcore_2fbuiltin_2eLogger_2estatic__method__table__id$object.data',
      ),
    ).toBe(
      'moonbitlang/core/builtin/StringBuilder.as_@moonbitlang/core/builtin.Logger.static_method_table_id',
    );
    expect(demangle('_M0IPB13StringBuilderPB6Logger13write__string')).toBe(
      'impl @moonbitlang/core/builtin.Logger for @moonbitlang/core/builtin.StringBuilder with write_string',
    );
    expect(demangle('_M0L10local__endS895.$1')).toBe('local_end/895');
    expect(demangle('_M0L10_2ax__5464S11.$0')).toBe('*x_5464/11');
    expect(
      demangle('_M0L61_24username_2fhello_2fmain_2eabort__via__closure_2einner_2efnS271'),
    ).toBe('@username/hello/main.abort_via_closure.inner/271');
    expect(demangle('_M0FPB30output_2eflush__segment_7c4024')).toBe(
      '@moonbitlang/core/builtin.output.flush_segment|4024',
    );
  });

  it('demangle additional edge cases', () => {
    expect(demangle('_M0FP15myapp3fooHRP15myapp7MyError')).toBe('@myapp.foo raise @myapp.MyError');
    expect(demangle('_M0MP04Type3bar')).toBe('Type::bar');
    expect(demangle('_M0MP04Type3barN5innerS7')).toBe('Type::bar.inner[stamp=7]');
    expect(demangle('_M0FP13pkg3fooN5innerS1GiEC2')).toBe(
      '@pkg.foo.inner[stamp=1][Int].anonymous[uuid=2]',
    );
    expect(demangle('_M0FP13pkg3foo$closure.data')).toBe('@pkg.foo');
    expect(demangle('_M0FP13pkg3foo@123')).toBe('@pkg.foo');
    expect(demangle('_M0FP13pkg3foo.')).toBe('@pkg.foo');
  });

  it('demangle empty packages', () => {
    expect(demangle('_M0FP03foo')).toBe('foo');
    expect(demangle('_M0MP04Type3run')).toBe('Type::run');
    expect(demangle('_M0IP04ImplP05Trait3run')).toBe('impl Trait for Impl with run');
    expect(demangle('_M0EPB3IntP06double')).toBe('Int::double');
    expect(demangle('_M0FP03fooGRP04TypeE')).toBe('foo[Type]');
  });

  it('demangle all type argument forms', () => {
    expect(demangle('_M0FP03fooGvE')).toBe('foo[V128]');
    expect(demangle('_M0FP03fooGNiE')).toBe('foo[ReadOnlyArray[Int]]');
    expect(demangle('_M0FP03fooGXWiEsE')).toBe('foo[FuncRef[(Int) -> String]]');
    expect(demangle('_M0FP03fooGVXWiEsE')).toBe('foo[FuncRef[async (Int) -> String]]');
    expect(demangle('_M0FP03fooGVNWiEsQiE')).toBe(
      'foo[async (Int) -> String raise Int + nocancel]',
    );
    expect(demangle('_M0FP03fooGVNXWiEsE')).toBe('foo[FuncRef[async (Int) -> String nocancel]]');
  });

  it('demangle utf8 identifier', () => {
    expect(demangle('_M0FP09_e4_b8_ad')).toBe('\u4e2d');
  });

  it('demangle generated receiver type', () => {
    expect(demangle('_M0MP05outerL5Local3run')).toBe('outer.Local::run');
    expect(demangle('_M0EP05outerL5LocalP03run')).toBe('outer.Local::run');
  });

  it('keeps original for non or invalid mangled names', () => {
    expect(demangle('plain')).toBe('plain');
    expect(demangle('_M0FP13pkg3foox')).toBe('_M0FP13pkg3foox');
    expect(demangle('_M0X13pkg3foo')).toBe('_M0X13pkg3foo');
    expect(demangle('_M0TP13pkg4Type')).toBe('_M0TP13pkg4Type');
    expect(demangle('$_M0FP13pkg3foo')).toBe('@pkg.foo');
    expect(demangle('_M0FP15myapp7try_mapGiE')).toBe('_M0FP15myapp7try_mapGiE');
    expect(demangle('_M0FP15myapp5outerCu245')).toBe('_M0FP15myapp5outerCu245');
    expect(demangle('_M0FP15myapp5outerC245l10c1_l10c2')).toBe('_M0FP15myapp5outerC245l10c1_l10c2');
    expect(
      demangle(
        '_M0FP314d_2dh24moonbit_2dscatter_2dplot14scatter_2dplot28gen__scatter__plot__graphics',
      ),
    ).toBe('_M0FP314d_2dh24moonbit_2dscatter_2dplot14scatter_2dplot28gen__scatter__plot__graphics');
  });

  it('handles non-ASCII input by UTF-8 byte length', () => {
    // identifier length is counted in bytes: "中" is 3 bytes
    expect(demangle('_M0FP03中')).toBe('中');
    // a length that cuts a multi-byte character in half is invalid UTF-8
    expect(demangle('_M0FP02中')).toBe('_M0FP02中');
    // non-ASCII trailing bytes are not an accepted terminator
    expect(demangle('_M0FP03foo中')).toBe('_M0FP03foo中');
    expect(demangle('plain中')).toBe('plain中');
  });

  it('rejects invalid UTF-8 produced by escapes', () => {
    expect(demangle('_M0FP02_e4')).toBe('_M0FP02_e4');
    expect(demangle('_M0FP06_e4_b8')).toBe('_M0FP06_e4_b8');
  });

  it('rejects truncated or non-hex escapes and oversized lengths', () => {
    expect(demangle('_M0FP02a_')).toBe('_M0FP02a_');
    expect(demangle('_M0FP03a_g')).toBe('_M0FP03a_g');
    expect(demangle('_M0FP04294967296x')).toBe('_M0FP04294967296x');
    expect(demangle('')).toBe('');
  });
});
