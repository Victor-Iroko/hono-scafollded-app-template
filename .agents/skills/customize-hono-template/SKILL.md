---
name: Customize Hono Template
description: Rename this Hono/Bun starter for a product. Use when changing its package name, docs hostname, or branding.
---

# Rename this template

Ask for the product name, package slug, and public domain if they were not given. Then update every location below.

## Name locations

- `package.json` `name` and `bun.lock` workspace name. Update the lockfile with `bun install`, never by hand.
- `docker-compose.yml`, `docker-compose.test.yml`: `hono-app-` container names; use the product prefix or drop the fixed names.
- `src/integrations/email/registry.ts`: `Acme` in the welcome subject.
- `.env.example`: `support@acme.test` sample reply-to address.
- `fern/docs.yml`: `your-org.docs.buildwithfern.com` hostname.
- `fern/fern.config.json`: `YOUR_FERN_ORGANIZATION`.
- `README.md`: title and intro description.
- Optional observability names: `hono-api` in `observability/prometheus.yml` and the `"api"` default service name in `src/core/instrumentation.ts`.

Search the repo for leftovers, ignoring `hono` package/dependency names: `hono-app`, `Acme`, `acme.test`, `hono-scafollded`, `your-org`, `YOUR_FERN_ORGANIZATION`.

Then report the files changed.
