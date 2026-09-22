# Signing procedure

Every `official` and `verified` release listed in this catalog is signed
with one minisign key pair controlled by the catalog maintainers (the
"production plugin signing key"). This key is separate from the key that
signs nginx-ui's own core binaries (`internal/releasesign` in the main
repository) — a plugin package and a core release are different trust
domains and are verified independently by `internal/pkgsign`.

This document does not itself contain the key. It was intentionally not
generated as part of setting up this repository; the repository owner
generates it out of band and stores only the public half here (in the
knowledge of anyone reading this file) and the private half in GitHub
Actions secrets.

## Generating the key (repository owner only, once)

Run this on a machine you trust, not in CI:

```sh
minisign -G -p plugin.pub -s plugin.key
```

You will be asked for a password protecting `plugin.key`. Do not skip it —
treat `plugin.key` like any other production signing key: it is the one
thing standing between a compromised CI runner and every user who trusts an
`official` or `verified` plugin release.

`plugin.pub` looks like:

```
untrusted comment: minisign public key ...
RW....................................
```

`plugin.key` (encrypted) looks like:

```
untrusted comment: minisign encrypted secret key
RW....................................
```

## Storing the private key in GitHub Actions

1. In this repository's settings, add two **Actions secrets** (Settings →
   Secrets and variables → Actions):
   - `PLUGIN_SIGNING_KEY` — the full contents of `plugin.key`.
   - `PLUGIN_SIGNING_KEY_PASSWORD` — the password chosen above.
2. `.github/workflows/validate.yml` and any future release-signing workflow
   read these secrets to run `minisign -S` against a fetched release asset,
   never to sign anything from an untrusted pull request context (a fork's
   PR runs without secret access under GitHub's default `pull_request`
   permissions; only workflows triggered from this repository's own context,
   e.g. `pull_request_target` for a maintainer-approved run or a manual
   `workflow_dispatch`, ever see these secrets).
3. Never print `PLUGIN_SIGNING_KEY` or the password to a workflow log. Treat
   a leaked private key the same as a compromised production credential:
   rotate immediately (below) and yank every release signed after the
   suspected leak that cannot be independently re-verified.

## Pinning the public key in nginx-ui

The public key half needs to be pinned in two independent places so a node
can verify a package even if the catalog itself were compromised:

1. **Compiled into the host** — `internal/releasesign` in the main
   `nginx-ui` repository lists the trusted release-signing keys, and
   `internal/pkgsign.Marketplace.trustedKeys` includes them for every
   catalog source, official or not (`internal/plugin/marketplace.go`,
   `trustedKeys`). Adding the production plugin signing key there requires a
   PR to the main repository and ships with the next nginx-ui release —
   coordinate this before the first `official` release depends on it.
2. **Runtime setting** — an operator can additionally add a public key to
   `plugin.trusted_public_keys` (`settings.PluginSettings.TrustedPublicKeys`)
   without upgrading nginx-ui, which is how a self-hosted or `community`
   source's key gets trusted, and how a new production key can be rolled out
   ahead of the next release during rotation (see below).

A release's own `signed_by` field records which of these key sets applies:
`"official"` means the catalog's production key (compiled in, or the
setting above); `"author"` means the entry's own `author_public_key`, only
accepted when that entry's `trust` is `"community"`.

## Rotation procedure

Rotate the production plugin signing key if it may have been exposed, on a
routine schedule the maintainers set, or when moving signing to new
infrastructure (e.g. a new CI runner identity).

1. Generate a new key pair as above; call it `plugin-2.pub` / `plugin-2.key`
   locally to avoid confusing it with the outgoing one during the overlap
   period.
2. Add `plugin-2.pub` to the trusted key sets **before** using it to sign
   anything:
   - Add it to `plugin.trusted_public_keys` on any node that needs to keep
     working immediately (or ask users to, via a release announcement).
   - Open a PR to the main `nginx-ui` repository adding it to
     `internal/releasesign`'s trusted keys, so it ships compiled into a
     future release. Keep the old key in that list too, so already-released
     packages the old key signed keep verifying.
3. Update `PLUGIN_SIGNING_KEY` / `PLUGIN_SIGNING_KEY_PASSWORD` in GitHub
   Actions secrets to the new key pair.
4. Sign all new releases with the new key going forward. Existing
   `plugins/<id>.json` entries do not need to be touched — a release's
   `signed_by` field says which key set to check against, not which specific
   key, and old releases keep verifying against the old key as long as it
   stays in the trusted set.
5. After a deprecation window long enough that essentially every running
   nginx-ui node has upgraded past the release that added the new key
   (`internal/releasesign`), remove the old key from `internal/releasesign`
   in a later nginx-ui release. Do not remove it from `internal/releasesign`
   and the runtime setting at the same time as introducing the new key —
   that would leave nodes that have not yet upgraded unable to verify
   anything until they do.
6. Document the rotation (old key id, new key id, effective date) in the
   pull requests from steps 2–3 so there is a paper trail independent of who
   ran it.

## Security contact

Report a suspected key compromise or a vulnerability in the signing pipeline
itself through a private GitHub security advisory on this repository, not a
public Issue.
