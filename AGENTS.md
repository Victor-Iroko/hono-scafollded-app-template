# AGENTS.md

## Code style

- Keep it simple. Don't make the code more complex than it needs to be; prefer the plain, readable solution over the clever or over-abstracted one.
- Write self-describing code. Names and structure should make the intent clear on their own.
- Keep comments short and useful. Add them only for non-obvious rationale, behavior, constraints, or public API contracts; remove comments that restate the code. Preserve required directives and legal notices.

## Naming

- Name functions for the action they perform and the domain they act on. Prefer specific names like `mapDbErrorToHttp` over vague names like `describeError`.
- Use consistent domain terms throughout a module; don't switch between near-synonyms like `server`, `database`, and `Postgres` for the same thing.
- Keep names concise, but make their purpose clear without relying on comments. Avoid generic names like `data`, `result`, or `mapped` when a more specific name improves understanding.

## API modules

- Organize the `api` folder into domain modules. Each module has a `<module>.api.ts`, `<module>.handlers.ts`, `<module>.schema.ts`, and `<module>.service.ts` file. Add a `<module>.error.ts` file when the module needs custom errors specific to that domain.
- Declare the module's endpoints as an `HttpApiGroup` in `<module>.api.ts` and add the group to `src/http/api.ts`.
- Keep `<module>.handlers.ts` thin: map each endpoint to a service call with `HttpApiBuilder.group`.
- Define the module's request/response schemas with `effect/Schema` in `<module>.schema.ts`.
- Put the module's business logic and data operations in `<module>.service.ts`; keep that logic out of the handlers.

## Services and layers

- Define services with `Context.Service` and give each one a `static readonly layer` that already provides the service's own dependencies, so callers never wire them.
- Use `Effect.fn("<Service>.<method>")` for service methods, `Schema.TaggedError` for failures, and `Effect.acquireRelease` for resources. No `globalThis` caches or module-level singletons.
- Read environment variables only through the `Config` groups in `src/config.ts`.

## Tests

- Run only the tests that cover the change. Use Bun's test runner and scope the run to the relevant test file or test name, for example `bun test tests/unit/<path>` or `bun test -t "<name>"`.
- Skip unrelated tests and the full suite unless the change is broad enough that the relevant coverage is unclear, or the user asks for a full run.

## Commits

- Keep commit messages to one concise subject line describing the change.
- Add a commit body only when it provides useful context beyond the subject.
