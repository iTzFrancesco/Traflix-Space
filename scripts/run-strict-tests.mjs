import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const cargoCommand = isWindows ? "cargo.exe" : "cargo";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
    shell: isWindows && command.toLowerCase().startsWith("npm"),
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(npmCommand, ["exec", "tsc", "--", "--noEmit"]);
run(npmCommand, ["run", "test:jarvis"]);
run(cargoCommand, ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--check"]);
run(cargoCommand, ["check", "--manifest-path", "src-tauri/Cargo.toml", "--release"]);
run(cargoCommand, [
  "clippy",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--all-targets",
  "--all-features",
  "--",
  "-D",
  "warnings",
  "-A",
  "clippy::derivable_impls",
  "-A",
  "clippy::field_reassign_with_default",
  "-A",
  "clippy::if_same_then_else",
  "-A",
  "clippy::items_after_test_module",
  "-A",
  "clippy::large_enum_variant",
  "-A",
  "clippy::manual_flatten",
  "-A",
  "clippy::manual_pattern_char_comparison",
  "-A",
  "clippy::manual_range_contains",
  "-A",
  "clippy::needless_as_bytes",
  "-A",
  "clippy::needless_borrow",
  "-A",
  "clippy::needless_borrows_for_generic_args",
  "-A",
  "clippy::needless_return",
  "-A",
  "clippy::question_mark",
  "-A",
  "clippy::result_large_err",
  "-A",
  "clippy::too_many_arguments",
  "-A",
  "clippy::unnecessary_map_or",
  "-A",
  "clippy::unnecessary_to_owned",
  "-A",
  "clippy::while_let_loop",
  "-A",
  "clippy::match_result_ok",
]);
const rustFlags = [process.env.RUSTFLAGS, "-D warnings"].filter(Boolean).join(" ");
run(cargoCommand, ["test", "--manifest-path", "src-tauri/Cargo.toml"], {
  env: { ...process.env, RUSTFLAGS: rustFlags },
});

console.log("Strict regression suite passed: TypeScript, frontend tests, rustfmt, release check, explicit Clippy baseline, and warning-free Rust tests.");
