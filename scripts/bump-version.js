import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const files = {
  package: join(root, "package.json"),
  cargo: join(root, "src-tauri", "Cargo.toml"),
  tauri: join(root, "src-tauri", "tauri.conf.json"),
};

function read(path) {
  return readFileSync(path, "utf-8");
}
function write(path, content) {
  writeFileSync(path, content, "utf-8");
}

function bumpSemver(version, type) {
  const parts = version.split(".").map(Number);
  if (type === "major") {
    parts[0]++; parts[1] = 0; parts[2] = 0;
  } else if (type === "minor") {
    parts[1]++; parts[2] = 0;
  } else {
    parts[2]++;
  }
  return parts.join(".");
}

const type = process.argv[2];
const explicitVersion = process.argv[3];

if (!type) {
  console.error("Uso: node scripts/bump-version.js <patch|minor|major|set> [versione]");
  process.exit(1);
}

// Read current version from package.json
const pkg = JSON.parse(read(files.package));
let newVersion;

if (type === "set") {
  if (!explicitVersion) {
    console.error("Specifica una versione: node scripts/bump-version.js set 1.2.3");
    process.exit(1);
  }
  newVersion = explicitVersion;
} else {
  newVersion = bumpSemver(pkg.version, type);
}

// Update package.json
pkg.version = newVersion;
write(files.package, JSON.stringify(pkg, null, 2) + "\n");
console.log(`[package.json] → ${newVersion}`);

// Update Cargo.toml
let cargo = read(files.cargo);
cargo = cargo.replace(/^version = ".*"/m, `version = "${newVersion}"`);
write(files.cargo, cargo);
console.log(`[Cargo.toml]  → ${newVersion}`);

// Update tauri.conf.json
let tauri = read(files.tauri);
tauri = tauri.replace(/"version": ".*"/, `"version": "${newVersion}"`);
write(files.tauri, tauri);
console.log(`[tauri.conf.json] → ${newVersion}`);

console.log(`\nVersione aggiornata a ${newVersion}. Ora puoi fare 'npm run tauri build'.`);
