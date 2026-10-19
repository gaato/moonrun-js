///|
fn[T : Show] show(label : String, f : () -> T raise) -> Unit {
  try println("\{label}: ok \{f()}") catch {
    @fs.IOError(m) => println("\{label}: err \{m}")
    _ => println("\{label}: other error")
  }
}

///|
fn sorted_dir(label : String, path : String) -> Unit {
  try {
    let names = @fs.read_dir(path).to_array()
    names.sort()
    println("\{label}: \{names}")
  } catch {
    @fs.IOError(m) => println("\{label}: err \{m}")
    _ => println("\{label}: other error")
  }
}

///|
fn scenario_args() -> Unit {
  println("args: \{@env.args()}")
  println("cwd-is-some: \{@env.current_dir() is Some(_)}")
}

///|
fn scenario_env() -> Unit {
  println("missing: \{@env.get_env_var("FSU_NO_SUCH_VAR")}")
  @env.set_env_var("FSU_A", "value-a")
  @env.set_env_var("FSU_EMPTY", "")
  @env.set_env_var("FSU_UNI", "héllo 世界 😀")
  println("a: \{@env.get_env_var("FSU_A")}")
  println("empty: \{@env.get_env_var("FSU_EMPTY")}")
  println("uni: \{@env.get_env_var("FSU_UNI")}")
  @env.set_env_var("FSU_A", "replaced")
  println("a2: \{@env.get_env_var("FSU_A")}")
  @env.unset_env_var("FSU_A")
  println("a3: \{@env.get_env_var("FSU_A")}")
  // invalid names are silently ignored by the legacy ABI
  @env.set_env_var("", "x")
  @env.set_env_var("A=B", "x")
  println("eq: \{@env.get_env_var("A=B")}")
  println("blank: \{@env.get_env_var("")}")
  let all = @env.get_env_vars()
  println("has-FSU_EMPTY: \{all.get("FSU_EMPTY")}")
  println("has-FSU_UNI: \{all.get("FSU_UNI")}")
  println("has-HOME: \{all.get("HOME") is Some(_)}")
  println("preset: \{@env.get_env_var("FSU_PRESET")}")
}

///|
fn scenario_fs() -> Unit {
  show("mkdir", () => @fs.create_dir("work/sub/deep"))
  show("mkdir-again", () => @fs.create_dir("work/sub/deep"))
  show("write-str", () => @fs.write_string_to_file("work/a.txt", "héllo 世界 😀\nline2\n"))
  show("read-str", () => @fs.read_file_to_string("work/a.txt"))
  show("write-bytes", () => @fs.write_bytes_to_file("work/b.bin", b"\x00\x01\xff\xfe\x80"))
  show("read-bytes", () => @fs.read_file_to_bytes("work/b.bin"))
  show("write-empty", () => @fs.write_bytes_to_file("work/empty", b""))
  show("read-empty", () => @fs.read_file_to_bytes("work/empty"))
  show("write-str2", () => @fs.write_string_to_file("work/sub/c.txt", "c"))
  sorted_dir("read-dir", "work")
  show("is-file-a", () => @fs.is_file("work/a.txt"))
  show("is-dir-a", () => @fs.is_dir("work/a.txt"))
  show("is-file-sub", () => @fs.is_file("work/sub"))
  show("is-dir-sub", () => @fs.is_dir("work/sub"))
  println("exists-a: \{@fs.path_exists("work/a.txt")}")
  println("exists-nope: \{@fs.path_exists("work/nope")}")
  println("exists-empty: \{@fs.path_exists("")}")
  show("rm-file", () => @fs.remove_file("work/a.txt"))
  println("exists-a-after: \{@fs.path_exists("work/a.txt")}")
  show("rm-dir", () => @fs.remove_dir("work/sub"))
  println("exists-sub-after: \{@fs.path_exists("work/sub")}")
}

///|
fn scenario_errors() -> Unit {
  show("read-missing", () => @fs.read_file_to_bytes("nope/missing.txt"))
  show("read-str-missing", () => @fs.read_file_to_string("missing.txt"))
  show("read-dir-as-file", () => @fs.read_file_to_bytes("."))
  show("read-through-file", () => @fs.read_file_to_bytes("afile/x"))
  show("read-noperm", () => @fs.read_file_to_bytes("noperm.txt"))
  show("write-missing-dir", () => @fs.write_bytes_to_file("nodir/x", b"x"))
  show("write-into-dir", () => @fs.write_bytes_to_file("adir", b"x"))
  show("write-noperm", () => @fs.write_bytes_to_file("noperm.txt", b"x"))
  show("write-noperm-dir", () => @fs.write_bytes_to_file("rodir/x", b"x"))
  show("mkdir-over-file", () => @fs.create_dir("afile"))
  show("mkdir-under-file", () => @fs.create_dir("afile/sub"))
  show("mkdir-noperm", () => @fs.create_dir("rodir/sub"))
  show("mkdir-empty", () => @fs.create_dir(""))
  show("read-dir-missing", () => @fs.read_dir("nodir"))
  show("read-dir-file", () => @fs.read_dir("afile"))
  show("read-dir-empty-path", () => @fs.read_dir(""))
  show("is-file-missing", () => @fs.is_file("nodir"))
  show("is-dir-missing", () => @fs.is_dir("nodir"))
  show("is-dir-through-file", () => @fs.is_dir("afile/x"))
  show("is-file-empty", () => @fs.is_file(""))
  show("rm-file-missing", () => @fs.remove_file("nodir"))
  show("rm-file-dir", () => @fs.remove_file("adir"))
  show("rm-dir-missing", () => @fs.remove_dir("nodir"))
  show("rm-dir-file", () => @fs.remove_dir("afile"))
  show("rm-dir-noperm", () => @fs.remove_dir("rodir"))
  show("read-str-bad-utf8", () => @fs.read_file_to_string("badutf8.bin"))
  show("write-bad-enc", () => @fs.write_string_to_file("x", "y", encoding="latin1"))
  show("dangling", () => @fs.is_file("dangling"))
  show("link-to-dir", () => @fs.is_dir("linkdir"))
  show("rm-dir-link", () => @fs.remove_dir("linkdir"))
  println("link-target-still: \{@fs.path_exists("adir")}")
  show("read-dir-after-errors", () => @fs.read_dir("adir"))
}

///|
fn scenario_unicode() -> Unit {
  show("mkdir", () => @fs.create_dir("work"))
  let name = "work/ünï 世界 😀.txt"
  show("write", () => @fs.write_string_to_file(name, "x"))
  show("read", () => @fs.read_file_to_string(name))
  sorted_dir("read-dir", "work")
  show("missing-unicode", () => @fs.read_file_to_bytes("nö 世界/x"))
  let big = Bytes::make(300000, b'z')
  show("write-big", () => @fs.write_bytes_to_file("work/big", big))
  show("big-len", () => {
    let b = @fs.read_file_to_bytes("work/big")
    (b.length(), b == big)
  })
}

///|
fn main {
  let args = @env.args()
  let scenario = if args.length() > 1 { args[1] } else { "args" }
  match scenario {
    "args" => scenario_args()
    "env" => scenario_env()
    "fs" => scenario_fs()
    "errors" => scenario_errors()
    "unicode" => scenario_unicode()
    other => println("unknown scenario \{other}")
  }
}
