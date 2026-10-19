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

- Organize the `api` folder into domain modules. Each module should have a `<module>.router.ts`, `<module>.schema.ts`, and `<module>.service.ts` file.
- Keep HTTP routes and request/response handling in `<module>.router.ts`.
- Define the module's validation schemas and related input/output types in `<module>.schema.ts`.
- Put the module's business logic and data operations in `<module>.service.ts`; keep that logic out of the router.

## Tests

- Run only the tests that cover the change. Use Bun's test runner and scope the run to the relevant test file or test name, for example `bun test tests/unit/<path>` or `bun test -t "<name>"`.
- Skip unrelated tests and the full suite unless the change is broad enough that the relevant coverage is unclear, or the user asks for a full run.

## Commits

- Keep commit messages to one concise subject line describing the change.
- Add a commit body only when it provides useful context beyond the subject.
