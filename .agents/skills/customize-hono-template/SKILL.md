---
name: Customize Hono Template
description: Rename this Bun/Effect starter for a product. Use when changing its package name, docs hostname, or branding.
---

# Rename this template

Ask for the product name, package slug, and public domain if they were not given. Then update every location below.

## Name locations

- `package.json` `name` and `bun.lock` workspace name. Update the lockfile with `bun install`, never by hand.
- `docker-compose.yml`, `docker-compose.test.yml`: `hono-app-` container names; use the product prefix or drop the fixed names.
- `src/integrations/email/templates.ts`: `APP_NAME` ("Acme"), used in the welcome subject.
- `src/http/api.ts`: the OpenAPI title (`Hono Scaffolded App API`); then run `bun run openapi:generate`.
- `.env.example`: `support@acme.test` sample reply-to address.
- `fern/docs.yml`: `your-org.docs.buildwithfern.com` hostname.
- `fern/fern.config.json`: `YOUR_FERN_ORGANIZATION`.
- `README.md`: title and intro description.
- Optional: the `SERVICE_NAME` default (`"api"`) in `src/config.ts`, used as the OpenTelemetry service name.

Search the repo for leftovers: `hono-app`, `Hono Scaffolded`, `Acme`, `acme.test`, `hono-scafollded`, `your-org`, `YOUR_FERN_ORGANIZATION`.

Then report the files changed.
