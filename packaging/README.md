# Packaging — Homebrew tap, Scoop bucket, signing

How `bn` reaches the secondary install channels. The **primary** channel is
`curl -fsSL https://bunsen.dev/install.sh | sh` (see `apps/web/public/install.sh`);
everything here is additive. GitHub Releases is the artifact host for all of them.

| File | Purpose |
|---|---|
| `generate-packages.mjs` | Emits the Homebrew cask + Scoop manifest for a version, filled from the binaries' `SHA256SUMS`. Single source of truth. |
| `macos-entitlements.plist` | Hardened-runtime entitlements for codesigning (`allow-jit` — required for the embedded Bun JIT). |

## One-time setup (owner)

### Homebrew tap
1. Create a public repo **`bunsen-dev/homebrew-tap`**.
2. The release workflow writes the cask to `Casks/bunsen.rb` on each release (see
   "Auto-bump" below). Users then install with:
   ```
   brew install bunsen-dev/tap/bunsen
   ```
   The cask install strips the macOS quarantine bit — less Gatekeeper friction than raw `curl`.

### Scoop bucket (Windows)
1. Create a public repo **`bunsen-dev/scoop-bucket`** with a `bucket/` dir.
2. The release workflow writes `bucket/bunsen.json`. Users install with:
   ```
   scoop bucket add bunsen https://github.com/bunsen-dev/scoop-bucket
   scoop install bunsen
   ```
   `checkver`/`autoupdate` in the manifest let `scoop` track future releases.

### Signing secrets (GitHub repo → Settings → Secrets → Actions)
macOS notarization and Windows Authenticode are **guarded** in `release.yaml` — the
release still succeeds without them (unsigned), and turns on automatically once set:

| Secret | For |
|---|---|
| `MACOS_CERT_P12_BASE64` | base64 of your "Developer ID Application" cert `.p12` |
| `MACOS_CERT_PASSWORD` | password for that `.p12` |
| `MACOS_SIGN_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `MACOS_NOTARY_APPLE_ID` / `MACOS_NOTARY_PASSWORD` / `MACOS_NOTARY_TEAM_ID` | `notarytool` credentials (app-specific password) |
| `WINDOWS_CERT_PFX_BASE64` / `WINDOWS_CERT_PASSWORD` | Authenticode cert (or use Azure Trusted Signing) |
| `HOMEBREW_TAP_TOKEN` | a PAT with `contents:write` on the tap + bucket repos (for auto-bump) |

## Auto-bump (per release)

`release.yaml`'s `packages` job runs `generate-packages.mjs <version>` against the
built `SHA256SUMS`, then commits `Casks/bunsen.rb` to `homebrew-tap` and
`bucket/bunsen.json` to `scoop-bucket` using `HOMEBREW_TAP_TOKEN`. So a single
GitHub Release fans out to install.sh assets + the tap + the bucket. If
`HOMEBREW_TAP_TOKEN` is unset, the job is skipped (do it manually: run the
generator and copy the two files into the repos).

## Manual generation

```
# after binaries + SHA256SUMS exist in packages/cli/dist/binaries/
node packaging/generate-packages.mjs 0.2.0
# → packaging/out/bunsen.rb  + packaging/out/bunsen.json
```
