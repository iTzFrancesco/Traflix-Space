import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "src-tauri/tauri.conf.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const version = config.version;
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? "";
const repository = process.env.GITHUB_REPOSITORY ?? "iTzFrancesco/Traflix-Space";

if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}`) {
  throw new Error(`Desktop release tag ${tag || "(missing)"} must match v${version}.`);
}

// The release workflow sets CARGO_TARGET_DIR to a runner-local directory, so
// the MSI bundle may live outside src-tauri/target. Prefer the configured
// target directory and fall back to the repository defaults.
const candidates = [];
if (process.env.CARGO_TARGET_DIR) {
  candidates.push(path.join(process.env.CARGO_TARGET_DIR, "release/bundle/msi/"));
}
candidates.push(path.join(repoRoot, ".cargo-target/release/bundle/msi/"));
candidates.push(path.join(repoRoot, "src-tauri/target/release/bundle/msi/"));

let bundleDirectory = "";
for (const candidate of candidates) {
  try {
    if ((await stat(candidate)).isDirectory()) {
      bundleDirectory = candidate;
      break;
    }
  } catch {
    // Candidate directory does not exist on this machine; try the next one.
  }
}
if (!bundleDirectory) {
  throw new Error(
    `No MSI bundle directory found. Checked: ${candidates.join(", ")}.`,
  );
}

const updateBundles = (await readdir(bundleDirectory)).filter((name) =>
  name.toLowerCase().endsWith(".msi"),
);
if (updateBundles.length !== 1) {
  throw new Error(`Expected one signed MSI updater bundle, found ${updateBundles.length}.`);
}

const bundleName = updateBundles[0];
const signature = (
  await readFile(path.join(bundleDirectory, `${bundleName}.sig`), "utf8")
).trim();
if (!signature) throw new Error(`The updater signature for ${bundleName} is empty.`);

const releaseAssetName = bundleName.replaceAll(" ", ".");
const windowsMsi = {
  signature,
  url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(releaseAssetName)}`,
};
const manifest = {
  version,
  notes: "Aggiornamento automatico di Traflix Space per Windows.",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": windowsMsi,
    "windows-x86_64-msi": windowsMsi,
  },
};

await writeFile(
  path.join(bundleDirectory, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(`Generated Windows updater manifest for ${tag}.`);
