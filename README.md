# nginxui/plugins

The official plugin catalog for [nginx-ui](https://github.com/0xJacky/nginx-ui).
This repository is data and tooling, not code that runs inside nginx-ui
itself: it publishes the JSON document nginx-ui's plugin marketplace fetches
to show available plugins, resolve versions, and verify what it downloads.

## What is in here

```
plugins/<id>.json     One JSON file per plugin: what it is, where it is
                       released, and the versions that are yanked. Written by
                       hand or drafted by the submission workflow.
partners/<name>.json  One JSON file per partner organization: its minisign
                       public key, an optional expiry, and whether it is
                       revoked. The source of the partner keyring.
schema/               JSON Schema (draft 2020-12) for every file shape.
assets/, _headers     Served as they are: the catalog icon and the cache and
                       content type headers of Cloudflare Pages.
worker/               The release webhook, a Cloudflare Worker that starts
                       the deploy when a listed plugin releases.
scripts/              No-dependency Node.js scripts: build, validate, and the
                       small pieces of automation the GitHub Actions in
                       .github/workflows/ call into.
docs/signing.md        How plugin packages are signed with minisign.
```

Nothing generated is committed. `.github/workflows/deploy.yml` builds the
site with `scripts/build-catalog.mjs` and deploys it to Cloudflare Pages:

```
v1/index.json         The catalog: plugins/*.json with the releases read from
                       the GitHub Releases of every plugin repository.
v1/partners.json      The partner keyring built from partners/*.json, signed
                       with the official plugin key into
                       v1/partners.json.minisig.
schema/, assets/      Copied from the repository.
```

## How nginx-ui hosts consume this

nginx-ui's plugin marketplace (`internal/plugin.Marketplace` in the main
repository) fetches one or more catalog URLs, merges them by plugin `id`
(first source wins on a collision), and uses the result to list plugins,
resolve installable releases, and verify downloads before installing them.

The default source, baked into every nginx-ui build
(`settings.DefaultPluginMarketplaceSource`), is the catalog this repository
builds:

```
https://plugins.nginxui.com/v1/index.json
```

The site is plain files on Cloudflare Pages and needs no server of its own.
`_headers` sets the cache lifetime (five minutes for `v1/`, so a revocation
reaches hosts quickly) and the content types. The packages themselves stay on
the GitHub Releases of each plugin repository.

## How the releases get into the catalog

`scripts/build-catalog.mjs` reads every GitHub Release of the
`repository_url` of each entry, drafts skipped, and builds its release record:
the packages with the sha256 GitHub records for each asset (the `.sha256`
asset next to it for an asset older than those records), the `plugin.json`
snapshot of the tag, the release notes and the channel. Then:

- A release the published catalog does not list yet is listed only after
  every one of its packages is downloaded and verified: its `sha256`, the
  `plugin.sums` inside it and the `plugin.sums.minisig` signature against the
  key the entry's trust level calls for. A release that does not verify is
  left out, and downloaded again only once its packages or that key change.
  This is the only time a build downloads packages.
- A release the published catalog lists keeps its packages and digests. When
  GitHub serves other digests for it, the build fails instead of following
  the change. Its notes and channel follow the GitHub Release.
- A release deleted on GitHub leaves the catalog. A version listed in the
  entry's `yanked` stays in the catalog marked yanked, and hosts no longer
  offer it.

The deploy runs on every change of `main`, every hour and by hand, so a
plugin release reaches the catalog within the hour without anyone touching
this repository. When the plugin repository has the catalog GitHub App
installed, the release webhook in `worker/` starts the deploy right away, see
[`worker/README.md`](worker/README.md).

`v1/index.json` is a `CatalogDocument`:

```jsonc
{
  "schema_version": 1,
  "updated_at": "2026-09-22T00:00:00Z",
  "plugins": [ /* CatalogEntry, see schema/entry.schema.json */ ]
}
```

For each entry, nginx-ui picks the newest release whose `api_version` it
speaks, whose `platforms` list (or `"any"`) covers the host, and whose
`min_nginx_ui_version` the running version satisfies. A release may publish a
single portable package (`download_url`), one package per platform
(`downloads`, keyed by `"<goos>-<goarch>"` or `"any"`), or both, see
[Packaging](https://nginxui.com/plugin/packaging). The host picks `downloads[<its platform>]`, then
`downloads["any"]`, then falls back to the portable package. Before
installing the selected package, the host:

1. Downloads its `url` (`download_url` for the portable package) and checks
   it against its `sha256`.
2. Checks every file of the package against the `plugin.sums` list at its
   root, verifies the `plugin.sums.minisig` signature over that list, and
   derives the trust level from the key that made it. See
   [Trust levels](#trust-levels) and `docs/signing.md`.
3. Confirms the downloaded package's own `plugin.json` reports the same `id`
   and `version` the catalog promised, so a compromised mirror cannot swap a
   well-known id for something else.
4. Shows the user the `manifest` snapshot's `permissions` and `capabilities`
   before the install is confirmed.

### Adding another source in nginx-ui

A node is not limited to this catalog. In nginx-ui, go to **Plugins →
Marketplace → Sources** (backed by `GET/POST /plugins/marketplace/sources`)
and add another `index.json` URL — for example a private catalog for
internally built plugins. Sources are merged in the order listed; the first
source that lists a given plugin `id` wins. A custom source may list any
trust level, but the host still derives the effective trust from the package
signature, whatever `trust` the entry claims. A package is `official` only
when the official plugin key signed it, `verified` only when a partner key
signed it that the project vouches for (a partner certificate in the package,
or a listing in this repository's signed partner keyring), and `community`
only when it verifies against the `author_public_key` of its entry or
against a key the operator added to the host's trusted key list
(`plugin.trusted_public_keys`). Anything else is unsigned, and unsigned
packages install only when developer mode is on.

## Trust levels

| Trust | Meaning | Key that signs `plugin.sums` |
| --- | --- | --- |
| `official` | Published by the nginx-ui project. Reserved for `com.nginxui.*` plugins. | The official plugin key, pinned in every nginx-ui build (`internal/releasesign`). It is apart from the key that signs nginx-ui releases. |
| `verified` | Published by a partner organization the maintainers vouch for, with a certificate in the package or a listing in the keyring. It makes no claim that anyone reviewed the source. | The partner's own key, certified by the official plugin key (`plugin.partner` and `plugin.partner.minisig` in the package) or listed in `v1/partners.json`. |
| `community` | Signed by the author. Not reviewed; installing one requires the community switch (`plugin.allow_community_plugins`) and a confirmation in the UI. | The author's own minisign key, published in the entry's `author_public_key`. |

The host derives the level from the key that signed `plugin.sums` inside the
package, not from the entry's `trust`. A package without `plugin.sums` and
`plugin.sums.minisig`, or signed by a key none of the rows above match, is
unsigned. Unsigned packages install only when developer mode is on.

The partner keyring, `v1/partners.json`, is only trusted when its signature
`v1/partners.json.minisig` verifies against the official plugin key. It lists the
partner keys and the revoked key ids: a revoked key is not a partner key on
any host, whatever certificate a package carries. Hosts pick up a new
keyring on their next catalog refresh. See `docs/signing.md` for issuing a
certificate, publishing the keyring and revoking a key.

`stage` is independent of trust: `production` or `beta`, signaling how much
real-world use a release has had, not who vetted it.

Every release belongs to a release channel: `stable`, `beta` or `dev`, from
the most to the least stable. Without a `channel` on the release, the version
decides: no prerelease part (`1.0.0`) is stable, a prerelease that starts with
`alpha`, `dev`, `nightly`, `snapshot`, `canary` or `preview`
(`1.0.0-nightly.20260930`) is dev, and any other prerelease (`1.0.0-beta.1`,
`1.0.0-rc.1`) is beta. A release with a plain version can set `"channel"` to
be put on a less stable channel. Each installed plugin follows the channel its
user picked, stable by default, and is offered the newest release on that
channel or a more stable one, so a beta follower also gets the stable release
that ends a beta series and you keep one line of releases. Number prereleases
with dot separated numeric identifiers, `1.1.0-beta.10` and not
`1.1.0-beta10`: releases are ordered by semantic versioning precedence, where
`beta.10` follows `beta.9` and `beta10` sorts before `beta9`. A host installs
any older release that is not yanked when asked to.

The build sets `"channel": "beta"` on a release that GitHub marks as a
prerelease when its version would otherwise read as stable.

## How to submit a plugin

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full step-by-step process
(Issue form or pull request, what the validation workflow checks, what
happens after merge, and the yank procedure for a release that turns out to
be broken or unsafe). In short:

1. Open an Issue with the *Submit a plugin* form, or send a pull request that
   adds `plugins/<id>.json`.
2. `.github/workflows/validate.yml` builds your entry from your GitHub
   Releases, checks the `sha256` of every package, the `plugin.sums` list
   inside it and its `plugin.sums.minisig` signature against your
   `author_public_key`, and runs `nginx-ui plugin lint` and
   `nginx-ui plugin conformance` in a container.
3. A maintainer reviews and merges. Your plugin is listed with `trust:
   "community"`.
4. Every later GitHub Release of your repository reaches the catalog on its
   own, you do not need to touch this repository again for routine releases.

## Plugin and provider naming

- A plugin `id` is reverse-DNS style: `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 64
  characters. `com.nginxui.*` is reserved for plugins maintained by the
  nginx-ui project itself. An author without a domain of their own should use
  `io.github.<owner>.<name>`, where `<owner>` matches the GitHub account that
  submits it.
- A `dns01` provider `code` (`^[a-z0-9-]{2,32}$`) names the DNS vendor, not
  the plugin. Which plugin answers a code is settled on each host by the
  plugins enabled there, the catalog keeps no registry of codes.

These rules follow [Naming](https://nginxui.com/plugin/naming) in the developer guide.

## Local development

Requires Node.js >= 20, no dependencies to install.

```sh
node scripts/validate.mjs                    # schema and structural checks
GITHUB_TOKEN=$(gh auth token) \
  node scripts/build-catalog.mjs --out dist  # build the site into dist/
```

`scripts/validate.mjs` checks that every `plugins/<id>.json` matches
`schema/entry.schema.json`, that plugin ids are unique, that the naming
policy above holds, that every entry is released on GitHub, that every
`community` entry has an `author_public_key`, that every
`partners/<name>.json` matches `schema/partner.schema.json` with a key no
other partner uses and a reason on every revocation, and that the keyring
builds. `scripts/build-catalog.mjs` checks the releases and the built
documents against `schema/catalog.schema.json` and
`schema/partners.schema.json`; `--published none` builds without the
published catalog, and `--published <dir>` compares with a site built
before.

## License

The catalog infrastructure (this repository, excluding the plugins it lists)
is [MIT licensed](LICENSE). Each listed plugin is distributed under the
license its own repository declares.
