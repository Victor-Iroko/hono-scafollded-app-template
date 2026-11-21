# Local development

Add the services from `assets/docker-compose.additions.yml`:

- **serverless-redis-http:** serves the local Redis over the Upstash REST
  protocol on port 8079 (token `local_token`).
- **qstash:** Upstash's in-memory dev server on 8080. It prints its token and
  signing keys on start (`docker compose logs qstash`); put them in `.env`.
  Its callbacks reach the API through `host.docker.internal`.

Then remove the `redis-jobs` service and its volume from `docker-compose.yml`.

`.env.example` additions:

```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=local_token
QSTASH_URL=http://localhost:8080
QSTASH_TOKEN=            # from `docker compose logs qstash`
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
# Public base URL QStash calls back, e.g. http://host.docker.internal:3000 locally.
QSTASH_DESTINATION_URL=http://host.docker.internal:3000
```

Do not set `devMode` in the QStash SDK while the dev server runs in Docker; it
would start a second server on the same port.

Run the API locally with `bun run dev` (the long-running entry) or serve
`src/serverless.ts` with `bun --watch` and `Bun.serve({ fetch })`, then sign up
and confirm the welcome email reaches Mailpit through the QStash callback.
