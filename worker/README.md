# Release webhook

A Cloudflare Worker that starts the deploy of the catalog as soon as a listed
plugin publishes, edits or deletes a GitHub Release. Without it the hourly
deploy picks the release up within the hour.

```
plugin repository --release event--> catalog GitHub App --webhook--> this Worker
this Worker --workflow_dispatch of deploy.yml--> nginxui/plugins
```

The Worker checks the webhook signature, ignores drafts and repositories the
published catalog does not list, and runs `.github/workflows/deploy.yml`. The
deploy reads every release from GitHub itself and verifies the packages, so a
delivery only decides when the deploy runs.

## Two GitHub Apps

The permissions are split so that installing the public App on a plugin
repository grants nothing beyond reading its releases.

| App | Visibility | Permissions | Webhook | Installed on |
| --- | --- | --- | --- | --- |
| Catalog, for example "NGINX UI Plugin Catalog" | Public | Repository: Contents read | Release events to `https://plugin-hooks.nginxui.com/github`, with a secret | The `nginxui` organization, and the repository of any plugin whose author wants releases listed at once |
| Deploy, for example "NGINX UI Catalog Deploy" | Private | Repository: Actions read and write | None | `nginxui/plugins` only |

To create them, in the settings of the `nginxui` organization, go to
Developer settings, GitHub Apps, New GitHub App:

1. Catalog App: set the webhook URL to `https://plugin-hooks.nginxui.com/github`,
   generate a random webhook secret, give Repository permissions, Contents,
   Read-only, subscribe to the Release event, and allow installation on any
   account. Install it on the organization.
2. Deploy App: turn the webhook off, give Repository permissions, Actions,
   Read and write, allow installation only on this account, generate a
   private key, and install it on `nginxui/plugins` only.

## Settings of the Worker

`wrangler.toml` holds the plain settings. Set the secrets once from this
directory:

```sh
npx wrangler secret put WEBHOOK_SECRET          # webhook secret of the Catalog App
npx wrangler secret put DEPLOY_APP_ID           # App ID of the Deploy App
npx wrangler secret put DEPLOY_APP_PRIVATE_KEY  # contents of its .pem file
```

GitHub hands out the private key as PKCS#1 (`BEGIN RSA PRIVATE KEY`). The
Worker converts it, there is no need to run openssl.

`.github/workflows/worker.yml` tests the Worker on every change and deploys
it from `main` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
secrets of the `cloudflare` environment. The token needs Workers edit next to
the Pages edit the catalog deploy needs, and Workers Routes edit and DNS edit
on the `nginxui.com` zone for the custom domain `plugin-hooks.nginxui.com`
that `wrangler.toml` binds. The `workers.dev` address is turned off.

## Local test

```sh
node --test src/*.test.mjs
```
