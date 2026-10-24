# Local development and Docker Compose

The local stack still needs Postgres, Redis, S3, and Mailpit. Two things change:

- Redis is reached over the Upstash HTTP protocol, so a small proxy sits in front of the local Redis.
- Jobs need a QStash endpoint. Run Upstash's dev server locally instead of a BullMQ worker.

## `docker-compose.yml`

### Add `serverless-redis-http`

Place it after the `redis` service:

```yaml
serverless-redis-http:
  image: hiett/serverless-redis-http:latest
  container_name: hono-app-redis-http
  restart: unless-stopped
  environment:
    SRH_MODE: env
    SRH_TOKEN: ${UPSTASH_REDIS_REST_TOKEN:-local_token}
    SRH_CONNECTION_STRING: "redis://:${REDIS_PASSWORD:-redis}@redis:6379"
  ports:
    - "${REDIS_HTTP_PORT:-8079}:80"
  depends_on:
    redis:
      condition: service_healthy
```

`SRH_MODE=env` means one upstream. `SRH_CONNECTION_STRING` uses the Compose service name and the password the `redis` service already requires. SRH connects lazily on the first command, so it does not race Redis startup, but `depends_on` keeps the logs clean.

### Add the QStash dev server

```yaml
qstash:
  image: public.ecr.aws/upstash/qstash:latest
  container_name: hono-app-qstash
  restart: unless-stopped
  command: ["qstash", "dev"]
  ports:
    - "${QSTASH_PORT:-8080}:8080"
    - "${QSTASH_LOG_PORT:-8081}:8081"
  extra_hosts:
    - "host.docker.internal:host-gateway"
```

The dev server is in-memory; restarting it drops schedules and message history. It is licensed for development only.

`extra_hosts` lets the container call an app running on the host as `host.docker.internal:3000`. Docker Desktop already provides that name; the mapping also makes it work on Linux.

### Remove `redis-jobs`

Delete the `redis-jobs` service and the `redisjobsdata` volume. It exists only for BullMQ, which QStash replaces. Keep the cache `redis` service, because SRH needs a real Redis upstream.

The final `docker-compose.yml` service order:

```
postgres
redis
serverless-redis-http
qstash
rustfs-perms
rustfs
mailpit
```

## `.env.example`

Replace the two Redis URLs and the queue block:

```sh
# Upstash Redis over HTTP. docker compose provisions SRH on 8079.
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=local_token

# Optional, defaults shown
# RATE_LIMIT_POINTS=100
# RATE_LIMIT_DURATION_S=60

# QStash. docker compose provisions the dev server on 8080.
# The token and signing keys below are the public QStash dev-server test user.
QSTASH_URL=http://localhost:8080
QSTASH_TOKEN=eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=
QSTASH_CURRENT_SIGNING_KEY=sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r
QSTASH_NEXT_SIGNING_KEY=sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs
# URL QStash calls back. Use host.docker.internal when the API runs on the host.
QSTASH_DESTINATION_URL=http://host.docker.internal:3000

# Optional, defaults shown
# JOB_MAX_RETRIES=2
# EMAIL_RATE_MAX=10
```

Remove:

- `REDIS_URL`
- `REDIS_JOBS_URL`
- `QUEUE_PREFIX`
- `JOB_MAX_ATTEMPTS`
- `SMTP_URL`, `SMTP_USER`, `SMTP_PASSWORD` when using an HTTP email provider
- `REDIS_JOBS_PORT`

Add the Compose-only ports:

```sh
REDIS_HTTP_PORT=8079
QSTASH_PORT=8080
QSTASH_LOG_PORT=8081
```

If the API also runs in Compose, change `QSTASH_URL` to `http://qstash:8080` and `QSTASH_DESTINATION_URL` to `http://api:3000`, where `api` is the service name.

## `docker-compose.test.yml`

Add the same proxy in front of `redis-test`:

```yaml
serverless-redis-http-test:
  image: hiett/serverless-redis-http:latest
  container_name: hono-app-redis-http-test
  environment:
    SRH_MODE: env
    SRH_TOKEN: ${UPSTASH_REDIS_REST_TOKEN_TEST:-test_token}
    SRH_CONNECTION_STRING: "redis://:${REDIS_PASSWORD:-redis}@redis-test:6379"
  ports:
    - "${REDIS_HTTP_PORT_TEST:-8078}:80"
  depends_on:
    redis-test:
      condition: service_healthy
```

`.env.test`:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/app_db_test
UPSTASH_REDIS_REST_URL=http://localhost:8078
UPSTASH_REDIS_REST_TOKEN=test_token
```

Tests no longer need `REDIS_URL`, `REDIS_JOBS_URL`, or `REDIS_JOBS_PORT`.

## Commands

```sh
docker compose up -d
bun install
bun add @upstash/redis @upstash/ratelimit @upstash/qstash
bun run db:push
bun run dev
```

The app is on `http://localhost:3000`. SRH is on `8079`. QStash is on `8080`, with its log server on `8081`.

## Publish a test job

With the app on the host and QStash in Docker:

```sh
curl -XPOST "http://localhost:8080/v2/publish/${QSTASH_DESTINATION_URL}/api/jobs/default" \
  -H "Authorization: Bearer ${QSTASH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"example","data":{"message":"hello"}}'
```

The callback logs `example job ran`. If it returns 401, the signing keys or `QSTASH_DESTINATION_URL` are wrong. The URL used to publish and the URL used to verify must be identical: it is the JWT `sub` claim.

## Alternative without Docker QStash

Set `QSTASH_DEV=true` and the SDK spawns its own dev server:

```sh
QSTASH_DEV=true
```

Do not combine it with the Compose QStash service; both bind port 8080. This option is not available on edge runtimes.

## What still runs in Docker

- Postgres — local database.
- Redis — upstream for SRH, cache only.
- SRH — Upstash-compatible HTTP API.
- QStash — jobs.
- RustFS — S3-compatible storage.
- Mailpit — SMTP capture, only if SMTP is kept.

Production replaces SRH with Upstash, QStash dev with Upstash QStash, and RustFS with real S3 or R2.
