# Contributing a plugin

This document is the step-by-step submission and review process for
`nginxui/plugins`. Read `README.md` first for the catalog's shape and the
trust levels referenced below.

## Prerequisites

Before you submit, your plugin should have:

- A public GitHub repository with at least one **GitHub Release** whose tag
  looks like `v1.0.0` (SemVer) and whose assets include the packaged
  `.tar.gz` your plugin builds: either the portable `<id>-<version>.tar.gz`,
  or one `<id>-<version>-<goos>-<goarch>.tar.gz` per platform, or both (see
  [Packaging](https://nginxui.com/plugin/packaging) for the archive layout).
- A `plugin.json` that passes `nginx-ui plugin lint` and, for a plugin with a
  `server` block, `nginx-ui plugin conformance` — the same two commands
  `.github/workflows/validate.yml` runs against your release.
- A plugin `id` that follows the naming rule in `README.md`
  (`io.github.<owner>.<name>` if you have no domain of your own). `id` must
  never start with `com.nginxui.`, which is reserved for plugins the
  nginx-ui project maintains itself.
- A minisign key pair (`minisign -G`), required for `community` trust. Every
  package carries `plugin.sums` and its signature `plugin.sums.minisig` at
  its root, see `docs/signing.md`. A package without them is unsigned and
  installs only on a host in developer mode.

## Submission path 1: the Issue form

Open a new Issue and pick **Submit a plugin**
(`.github/ISSUE_TEMPLATE/submit-plugin.yml`). Fill in your repository URL,
the plugin id, and a contact (GitHub handle is fine), then apply the
`submission` label if it was not applied automatically.

`.github/workflows/submit-issue.yml` then:

1. Parses the form fields from the issue body.
2. Fetches your repository's latest release.
3. Generates a draft `plugins/<id>.json` from the release and your
   `plugin.json`.
4. Opens a pull request adding that file, and links it back to your issue.

From there, the pull request goes through the same checks as path 2.

## Submission path 2: a pull request

Fork this repository and add `plugins/<id>.json` yourself — copy the shape of
an existing entry such as `plugins/com.nginxui.dns01.json`, or validate
against `schema/entry.schema.json` directly. Open a pull request. The entry
lists no releases: they are read from your GitHub Releases (see below).

Required fields and what they mean are documented in
`schema/entry.schema.json`; in particular:

- `name` and `description` are locale maps; `en` is required, additional
  locales are welcome. They can come straight from your `plugin.json`: its
  top level `name` and `description` are the `en` text, and its optional
  `i18n` block (see [Manifest](https://nginxui.com/plugin/manifest), e.g.
  `"i18n": { "zh_CN": { "name": "...", "description": "..." } }`) holds the
  other locales. The Issue form path fills both maps for the entry it
  drafts, leaving out empty translations, and the manifest snapshot of each
  release in the catalog keeps the `i18n` block. Later releases never
  rewrite the maps, so copy changed translations into your entry by hand.
- `trust` for a submission is always `"community"`. `verified` is reserved
  for partner organizations, see [Partner plugins](#partner-plugins).
- `repository_url` is the GitHub repository whose Releases publish the
  plugin. Each release carries its packages, the portable
  `<id>-<version>.tar.gz` or one `<id>-<version>-<goos>-<goarch>.tar.gz` per
  platform with a `.sha256` file next to each, see
  [Packaging](https://nginxui.com/plugin/packaging). The signature lives
  inside each package.
- `author_public_key` is required for a `community` entry. It is the minisign
  public key that signs `plugin.sums` in your packages.
- `categories` is optional: one to three ids from the `category` list of
  `schema/entry.schema.json`, such as `certificates` or `logs`. The
  marketplace and the catalog site translate them and filter by them.
- `screenshots` is optional: up to eight images of the plugin in use, each an
  `https` `url` of a PNG, JPEG or WebP file and an optional `caption` locale
  map. About 16:10 at 1280 to 1920 pixels wide shows well. Add `dark_url`, the
  same view in the dark theme at the same size, and NGINX UI shows it while
  its interface is dark; without one the `url` image shows in both themes. NGINX UI shows only
  images served from your repository's GitHub host, the catalog or the host of
  your packages, so keep them in your repository and link the raw file of a
  release tag.

## What `.github/workflows/validate.yml` checks

On every pull request touching `plugins/*.json`, for each changed or added
entry:

1. **Schema**: `node scripts/validate.mjs`. The entry matches
   `schema/entry.schema.json`, the file is named `<id>.json`, the id is
   unique catalog-wide, `repository_url` is a GitHub repository (for an
   `io.github.<owner>.<name>` id, owned by `<owner>`), and a `community`
   entry has an `author_public_key`.
2. **Releases**: `scripts/build-catalog.mjs` builds the entry from your
   GitHub Releases. For every release the published catalog does not list
   yet, and for the newest one, it downloads every package, checks it
   against the sha256 GitHub records for the asset and extracts it. Both
   `plugin.sums` and `plugin.sums.minisig` must sit at the package root,
   every regular file besides them must be listed in `plugin.sums` with a
   matching digest, and `plugin.sums.minisig` must verify against the key of
   the entry's trust level: your `author_public_key` for a `community` entry,
   the partner certificate or `partners/` for a `verified` one (see
   [Partner plugins](#partner-plugins)), the official plugin key for an
   `official` one.
3. **Lint and conformance**: runs `nginx-ui plugin lint` and
   `nginx-ui plugin conformance` against the package a linux-amd64 host would
   install (`downloads["linux-amd64"]`, `downloads["any"]`, or the portable
   package, in that order) inside the `uozicoder/nginx-ui` container image.

A release that does not verify is left out of the catalog, and the pull
request is not mergeable until the newest release verifies.

## Review and merge

A maintainer reviews the PR: the plugin's stated permissions and
capabilities against what it plausibly needs, its README, and the CI
results above. Once merged, `.github/workflows/deploy.yml` builds the
catalog and deploys it, and your plugin is live at the default catalog URL
within the cache time of nginx-ui hosts (`internal/plugin.Marketplace`
caches a source for up to one hour, or refreshes at once for a user who hits
"refresh").

## Keeping your listing up to date

Nothing to do: the deploy reads your GitHub Releases every hour and lists a
new one as soon as its packages verify. Prereleases are listed too, on the
channel their version names, see the channel rules in the README. A draft
release is ignored until it is published.

To have a release listed within minutes of publishing it instead, install the
[NGINX UI Plugin Catalog](https://github.com/apps/nginx-ui-plugin-catalog)
GitHub App: choose the account that owns the plugin repository, select only
that repository, and install. Publishing a release then starts the deploy of
the catalog at once. The App only receives release events and holds no
private key, so it cannot read your repository, and it does nothing for a
repository the catalog does not list yet. See
[`worker/README.md`](worker/README.md).

A listed release is pinned: replacing a package of it on GitHub fails the
deploy instead of changing what hosts download. Publish a new version
instead.

## Partner plugins

`verified` trust is reserved for partner organizations the maintainers
vouch for. It says who published a package and makes no claim that anyone
reviewed its source.

1. The partner contacts the nginx-ui maintainers. Once agreed, it generates
   a minisign key pair (`minisign -G -p partner.pub -s partner.key`) and
   sends only its public key, `partner.pub`.
2. The maintainers add `partners/<name>.json` with that key, which lists it
   in the signed partner keyring `v1/partners.json`, and send back a
   partner certificate: `plugin.partner` (the partner's public key) and
   `plugin.partner.minisig` (an official plugin key signature over it that names the
   partner and, optionally, an expiry date). See "Issuing a partner
   certificate" in `docs/signing.md`.
3. The partner puts both files, unchanged, at the root of every package
   before writing `plugin.sums`, so `plugin.sums` lists them like any other
   file, and signs `plugin.sums` with its own key as usual.
4. Its catalog entries use `"trust": "verified"` and need no
   `author_public_key`.

Hosts install such a package as `verified` when the certificate verifies
against the official plugin key they pin, or when their copy of the keyring lists
the key. No nginx-ui release is involved. If the key may have leaked, tell
the maintainers through a private security advisory: they revoke it in
`partners/`, and hosts stop treating it as a partner key on their next
catalog refresh, certificate or not. Revocation is the main safeguard. The
maintainers still recommend a long expiry on the certificate, because a
host that never refreshes the keyring would otherwise trust a leaked key
forever. A certificate with an expiry stops working after that date, so ask
the maintainers for a new one before then.

## Yank procedure

Yanking withdraws a specific release, not the whole plugin: its version goes
into the `yanked` list of `plugins/<id>.json`, and the catalog keeps the
release marked `"yanked": true`. A yanked release:

- Is never offered as the `installable_release` to a node that has not
  already installed it.
- Is still reported to a node that already has it installed, as
  `installed_yanked: true`, so the UI can prompt the user to update or
  remove it.

To yank a release:

1. Open an Issue or a security advisory describing the problem (a
   vulnerability, a broken build, a credential leak, a license violation,
   etc.). Do not put exploit details in a public Issue, use a private
   security advisory instead for anything actively exploitable.
2. A maintainer (or the plugin author, for their own plugin) opens a PR
   adding the version to `"yanked"`. Do not delete the GitHub Release: a
   node that already installed it still needs to see it in the catalog to
   know it should update.
3. Merge fast-tracks past the normal release cadence for security issues;
   the deploy republishes the catalog on merge.
4. If every listed release of a plugin ends up yanked, consider whether the
   plugin should be removed from `plugins/` entirely instead (a separate PR,
   discussed with maintainers first).

A yank does not require the author's consent when the issue is a security
one; maintainers may yank unilaterally and notify the author afterward.
