# Signing procedure

A plugin package carries its signature inside the archive, as two files at
the package root:

- `plugin.sums` lists every regular file of the package except these two,
  one `<sha256>  <path>` line each: the lowercase hex digest, two spaces, and
  the slash separated path relative to the package root, the layout
  `sha256sum` writes. Lines are sorted bytewise by path (`LC_ALL=C sort`) and
  end with LF. Directories are not listed.
- `plugin.sums.minisig` is the minisign signature over `plugin.sums` in text
  form, exactly what `minisign -S -m plugin.sums -x plugin.sums.minisig`
  writes.

A package without both files is unsigned. A release publishes no `.minisig`
file next to its archives, and a catalog entry has no signature field. The
`sha256` of an entry is only a download integrity check.

## Which key gives which trust level

nginx-ui derives the trust level of a package from the key that signed its
`plugin.sums`, whatever `trust` the catalog entry claims:

| Key that signed `plugin.sums` | Trust |
| --- | --- |
| The nginx-ui project's release key, pinned in every build (`internal/releasesign`) | `official` |
| A partner key, certified by the release key in the package (`plugin.partner`) or listed in the signed partner keyring (`v1/partners.json`) | `verified` |
| The `author_public_key` of the catalog entry | `community` |
| No signature, or a key none of the rows above match | unsigned |

A key id listed under `revoked` in the partner keyring is never a partner
key, whatever certificate the package carries. Unsigned packages install
only when developer mode is on. `verified` makes no claim that anyone
reviewed the source, see CONTRIBUTING.md's "Partner plugins".

## Signing a package

Stage the package directory exactly as it will be archived, then run this
from its root:

```sh
find . -type f ! -path ./plugin.sums ! -path ./plugin.sums.minisig \
  | sed 's|^\./||' | LC_ALL=C sort \
  | while IFS= read -r file; do
      printf '%s  %s\n' "$(sha256sum <"${file}" | cut -d ' ' -f 1)" "${file}"
    done >plugin.sums

minisign -S -m plugin.sums -x plugin.sums.minisig -s /path/to/plugin.key \
  -t "<plugin id> <version>"
```

Archive the directory with `plugin.json` as the first entry and both files
at the root. Running `sha256sum -c plugin.sums` inside an extracted package
checks it. `build.sh` in plugin-dns01 is a complete example: it
writes `plugin.sums` for every platform package and signs it when
`MINISIGN_KEY` names a minisign secret key file.

A partner copies its certificate, `plugin.partner` and
`plugin.partner.minisig`, into the staged directory before writing
`plugin.sums`, so both are listed like any other file.

Sign after every other change to the staged files. Any later edit, even to
a documentation file, makes `sha256sum -c` fail on the host.

## Community keys

A community author generates a key pair on a machine they trust:

```sh
minisign -G -p plugin.pub -s plugin.key
```

`plugin.pub` goes into the entry's `author_public_key`, either whole or as
its single key line. `.github/workflows/validate.yml` verifies every
package of a community entry against that key. When an author replaces the
key, packages signed with the old one no longer match the entry and count
as unsigned, so the author signs new releases with the new key and updates
`author_public_key` in the same pull request that lists the first of them.

## The project release key and partner keys

The key that makes a package `official` is the nginx-ui project's release
key. It also signs partner certificates and the partner keyring. A partner
organization generates its own key pair the same way and sends the public
half to the maintainers. This repository never signs a package: packages
are signed where they are built, before their archive and its `sha256`
exist. The one thing signed here is `v1/partners.json`, by CI, see
[Publishing the partner keyring](#publishing-the-partner-keyring).

minisign asks for the key password on every signature, once per package.
A CI job that signs uses a key created without a password
(`minisign -G -W`) or answers the prompt with an expect wrapper, and keeps
the key in a secret of the repository that builds the plugin:

1. Write the secret to a file inside the job and point the build at it,
   e.g. `MINISIGN_KEY` for plugin-dns01's `build.sh`. Delete the
   file when the job ends.
2. Sign only from a trusted context such as a tag push or a manual
   `workflow_dispatch`, never from a pull request of a fork.
3. Never print the key to a workflow log. Treat a leaked key like any
   compromised production credential: rotate it (below) and yank every
   release signed after the suspected leak that cannot be independently
   re-verified.

## Issuing a partner certificate

A partner certificate lets a package show by itself that the project
vouches for the key that signed it. The maintainers issue it once per
partner key, and the partner ships it unchanged in every package:

- `plugin.partner`: the partner's minisign public key in text form, the
  file `minisign -G` wrote.
- `plugin.partner.minisig`: a release key signature over the exact bytes of
  `plugin.partner`, whose trusted comment is `partner:<name>`, or
  `partner:<name>;expires:<YYYY-MM-DD>` with an expiry.

The partner generates a key pair and sends only the public half:

```sh
minisign -G -p partner.pub -s partner.key
```

A maintainer, on the machine that holds the release secret key, issues the
certificate. `;expires:<YYYY-MM-DD>` is optional:

```sh
cp partner.pub plugin.partner
minisign -S -m plugin.partner -x plugin.partner.minisig \
  -s /path/to/release.key -t "partner:<name>[;expires:<YYYY-MM-DD>]"
```

or with the nginx-ui CLI, where `--expires` is optional:

```sh
nginx-ui plugin certify partner.pub --key /path/to/release.key \
  --name <name> [--expires <YYYY-MM-DD>]
```

- `<name>` is the partner's name in `partners/<name>.json`. Every certified
  partner has that file, even when all its packages carry a certificate,
  because it is where the key gets revoked.
- Revocation through the keyring is the primary way to withdraw a partner
  key. The expiry is a backstop for hosts that never refresh the keyring:
  without one, such a host trusts a leaked key forever. Set a long expiry,
  a few years for example, and issue a new certificate before it passes.
- The certificate only vouches for the key it contains: `plugin.sums.minisig`
  must be made by that key.

The maintainers send both files back to the partner, who puts them at the
package root as described in [Signing a package](#signing-a-package).
`.github/workflows/validate.yml` checks the certificate of a `verified`
entry's newest release: the trusted comment, the expiry if it has one, that
the key is not revoked, that `plugin.sums` is signed by the certified key
and, when the `PLUGIN_SIGNING_PUBLIC_KEY` repository variable holds the
release public key, the release key signature.

## Publishing the partner keyring

`v1/partners.json` is the partner keyring, and `v1/partners.json.minisig`
is the release key signature over its exact bytes:

```jsonc
{
  "schema_version": 1,
  "updated_at": "2026-09-26T00:00:00Z",
  "partners": [
    { "name": "example", "public_key": "<minisign public key>", "expires": "2027-12-31" }
  ],
  "revoked": ["<16 hex key id>"]
}
```

Hosts fetch it together with the catalog and only trust it when the
signature verifies. They refuse a keyring whose `updated_at` is older than
the one they cached. A key listed under `partners` makes the packages it
signed `verified`, with or without a certificate. A key id under `revoked`
stops being a partner key on every host, certificate or not.

The source is one file per partner, `partners/<name>.json`, described by
`schema/partner.schema.json`:

```json
{
  "name": "example",
  "public_key": "untrusted comment: minisign public key 0123456789ABCDEF\nRW...",
  "expires": "2027-12-31"
}
```

`public_key` takes the whole `.pub` file or its key line, and `expires` is
optional. `scripts/build-partners.mjs` assembles the files into
`v1/partners.json`: partners sorted by name, the key ids of revoked
partners sorted under `revoked`, and an `updated_at` that only moves when
the content does.

To add or change a partner:

1. Add or edit `partners/<name>.json` in a pull request and run
   `node scripts/build-partners.mjs`. `node scripts/validate.mjs` checks
   both the file and the rebuilt keyring.
2. Once merged, `.github/workflows/build-index.yml` rebuilds
   `v1/partners.json`, signs it into `v1/partners.json.minisig` and commits
   both. Hosts pick it up on their next catalog refresh.

The workflow reads these repository settings:

| Name | Kind | Content |
| --- | --- | --- |
| `PLUGIN_SIGNING_KEY` | secret | The release secret key file, as `minisign -G` wrote it. |
| `PLUGIN_SIGNING_KEY_PASSWORD` | secret | Its password, piped to minisign's prompt. Empty for a key made with `-W`. |
| `PLUGIN_SIGNING_PUBLIC_KEY` | variable | The release public key. `build-index.yml` checks the new signature against it and `validate.yml` checks partner certificates against it. |

Without `PLUGIN_SIGNING_KEY` the workflow still builds and commits the
keyring, leaves it unsigned and says so in a notice. Hosts ignore a keyring
without a valid signature. After adding or changing the secret, run the
*Build index* workflow by hand to sign the current keyring.

### Revoking a partner key

1. Set `"revoked": true` and a `"reason"` in `partners/<name>.json`, then
   run `node scripts/build-partners.mjs`. The partner leaves `partners` and
   its key id joins `revoked`.
2. Merge. CI signs the new keyring, and hosts pick it up on their next
   catalog refresh. From then on the key is not a partner key on those
   hosts, whatever certificate a package carries.
3. For a leaked key, yank the affected releases as described in
   CONTRIBUTING.md.

Keep the revoked file in `partners/`: deleting it drops the key id from
`revoked`. To revoke a key the partner has replaced, keep the old key in a
file of its own, for example `partners/<name>-2026.json`, marked revoked.

A host that never refreshes never sees the revocation. There only an expiry
bounds the damage: after the certificate's expiry date the host stops
accepting the certificate, and after a listing's `expires` it stops
accepting that listing. A certificate without an expiry stays valid on such
a host for good, which is why certificates should carry a long one.

## Rotation procedure

Rotate a signing key if it may have been exposed, on a routine schedule the
maintainers set, or when moving signing to new infrastructure.

1. Generate a new key pair as above. Call it `plugin-2.pub` /
   `plugin-2.key` locally to keep it apart from the outgoing one during the
   overlap.
2. Make hosts trust `plugin-2.pub` **before** signing anything with it.
   - The project release key: pin it in nginx-ui (`internal/releasesign`)
     and keep the old key pinned too, so everything the old key signed
     keeps verifying. The change ships with the next nginx-ui release.
   - A partner key: issue a certificate for the new key and switch
     `public_key` in `partners/<name>.json` to it. No nginx-ui release is
     needed. Packages signed with the old key keep verifying through their
     own certificate until it expires, or until the old key is revoked.
3. Once that release is out, or the new keyring is published, switch the
   signing secret of the build pipelines to the new key and sign every new
   package with it. Keep signing partner certificates and
   `v1/partners.json` with the old release key until step 5, so hosts that
   have not upgraded still accept them.
4. Existing `plugins/<id>.json` entries need no change. An official or
   partner entry does not name its key.
5. After a deprecation window long enough that essentially every running
   nginx-ui node has upgraded past the release that pinned the new key,
   remove the old key in a later nginx-ui release. From then on, packages
   signed only by the old key count as unsigned on upgraded hosts, so
   republish any that must stay installable before that. For the release
   key, first switch `PLUGIN_SIGNING_KEY` to the new key, run *Build index*
   by hand, and issue new certificates to every partner.
6. Document the rotation (old key id, new key id, effective date) in the
   pull requests from steps 2 and 3, so there is a record independent of
   who ran it.

## Security contact

Report a suspected key compromise or a vulnerability in the signing pipeline
itself through a private GitHub security advisory on this repository, not a
public Issue.
