# Release Traflix Space on GitHub

Use this guide before changing application versions, creating release tags, or
publishing Windows builds. A release is built and published by
GitHub Actions. Do not build a release locally.

## Choose a normal push or a release

A request to push changes to GitHub means a normal code push. Do not bump a
version, create release tags, or start a local build unless the user asks for
an updated release.

The normal CI workflow in `.github/workflows/ci.yml` still runs automatically
for pushes to `main` and pull requests targeting `main`. It checks the code
and builds a Windows MSI as a workflow artifact. That CI artifact is not a
GitHub Release and does not update installed applications.

Treat a request for an updated build as a Windows release request unless the
user says otherwise. Prepare small, focused commits, push the approved changes,
and let the tagged GitHub Actions workflow build and publish the installable
release. Do not run the release build on the developer's computer.

## Version numbers

Traflix Space has a single Windows release channel.

| Platform | Version files | Release tag | Published artifact |
| --- | --- | --- | --- |
| Windows | `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` | `vX.Y.Z` | Signed MSI and `latest.json` |

Use semantic versioning for the `X.Y.Z` version. Increase the major
number for an incompatible release, the minor number for compatible features,
and the patch number for compatible fixes.

For a version bump, run the repository script with the new version:

```powershell
npm run bump -- 1.9.3
```

The script updates the version files in the table. Review all of those changes
before committing them. The `version:patch`, `version:minor`, `version:major`,
and `version:set` scripts remain available as alternatives.

## Publish a Windows release

The Windows release workflow in `.github/workflows/release.yml` runs when you
push a tag matching `v*`. It checks the Rust and frontend code, rebuilds the
Edge TTS sidecar through `src-tauri/tauri.windows.conf.json`, builds and signs
the MSI, generates the updater manifest, and creates a GitHub Release. The
release tag must exactly match the version in `src-tauri/tauri.conf.json`
(and in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`).

The updater manifest is `latest.json`, not `release.json`. The release workflow
generates it with `scripts/generate-updater-manifest.mjs` and uploads it with
the MSI and its `.sig` signature. The Windows app reads the stable manifest
from the `latest` release. Keep the manifest name, URL, signature, and platform
keys compatible with the Tauri updater.

The Windows workflow needs the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions
secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the signing key is
password-protected). Never commit the key or print it in logs.

There is no Android release channel. Unlike Traflix Voice, Traflix Space does
not publish an `android-v*` tag family or an APK asset. Do not create
`android-v*` tags in this repository.

## Release a new version

1. Read this guide and the repository's `AGENTS.md` instructions.
2. Finish the changes on the approved release target. Keep each commit focused
   so reviewers can see the work in small steps. Do not combine unrelated work
   into a single commit or squash the release history into one commit.
3. Update the version with `npm run bump -- X.Y.Z`.
4. Push the commits to the existing target branch. Do not create a secondary
   branch unless the user asks for one.
5. Confirm that the release source is the approved commit on `main` and that
   the required GitHub Actions secrets exist.
6. Create the release tag at that same commit. Replace the example
   version with the version in the configuration files:

    ```powershell
    git tag -a v1.9.3 -m "Traflix Space 1.9.3"
    git push origin v1.9.3
    ```

7. Follow the tagged workflow in GitHub Actions. Resolve failures before
   calling the release complete. Rerun a failed workflow when its tag and
   source are correct; use a new version and tag if the release contents must
   change.
8. Check the Windows Release for the MSI, `.sig`, and `latest.json`.

Do not move or reuse a published tag. Choose a new version for corrected
release contents.

## Preserve the update contracts

- Keep the Windows updater endpoint and `latest.json` schema compatible with
  `src-tauri/tauri.conf.json` and Tauri's updater plugin.
- Keep the Windows sidecar build (`src-tauri/tauri.windows.conf.json` and
  `scripts/tauri-before-build.ps1`) compatible with the release workflow:
  every Windows MSI build regenerates the Edge TTS sidecar before bundling.
- Do not change signing, updater endpoints, release visibility, or tag rules
  without reviewing the affected client update code and GitHub Actions
  workflow.
- Never include credentials, keystores, local build output, or user data in a
  commit or release asset.
