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
| A partner organization's key, pinned by the project in an nginx-ui release | `verified` |
| The `author_public_key` of the catalog entry | `community` |
| No signature, or a key none of the rows above match | unsigned |

Unsigned packages install only when developer mode is on. `verified` makes
no claim that anyone reviewed the source, see CONTRIBUTING.md's "Partner
plugins".

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
checks it. `build.sh` in nginx-ui-plugin-dns01 is a complete example: it
writes `plugin.sums` for every platform package and signs it when
`MINISIGN_KEY` names a minisign secret key file.

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
key. A partner organization generates its own key pair the same way and
sends the public half to the maintainers. This repository holds neither
secret half and never signs anything: packages are signed where they are
built, before their archive and its `sha256` exist.

minisign asks for the key password on every signature, once per package.
A CI job that signs uses a key created without a password
(`minisign -G -W`) or answers the prompt with an expect wrapper, and keeps
the key in a secret of the repository that builds the plugin:

1. Write the secret to a file inside the job and point the build at it,
   e.g. `MINISIGN_KEY` for nginx-ui-plugin-dns01's `build.sh`. Delete the
   file when the job ends.
2. Sign only from a trusted context such as a tag push or a manual
   `workflow_dispatch`, never from a pull request of a fork.
3. Never print the key to a workflow log. Treat a leaked key like any
   compromised production credential: rotate it (below) and yank every
   release signed after the suspected leak that cannot be independently
   re-verified.

## Rotation procedure

Rotate a signing key if it may have been exposed, on a routine schedule the
maintainers set, or when moving signing to new infrastructure.

1. Generate a new key pair as above. Call it `plugin-2.pub` /
   `plugin-2.key` locally to keep it apart from the outgoing one during the
   overlap.
2. Pin `plugin-2.pub` in nginx-ui **before** signing anything with it:
   `internal/releasesign` for the project release key, the partner key list
   for a partner key. Keep the old key pinned too, so packages it already
   signed keep verifying. The change ships with the next nginx-ui release.
3. Once that release is out, switch the signing secret of the build
   pipelines to the new key and sign every new package with it.
4. Existing `plugins/<id>.json` entries need no change. An official or
   partner entry does not name its key.
5. After a deprecation window long enough that essentially every running
   nginx-ui node has upgraded past the release that pinned the new key,
   remove the old key in a later nginx-ui release. From then on, packages
   signed only by the old key count as unsigned on upgraded hosts, so
   republish any that must stay installable before that.
6. Document the rotation (old key id, new key id, effective date) in the
   pull requests from steps 2 and 3, so there is a record independent of
   who ran it.

## Security contact

Report a suspected key compromise or a vulnerability in the signing pipeline
itself through a private GitHub security advisory on this repository, not a
public Issue.
