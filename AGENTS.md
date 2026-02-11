# Repository Guidelines

## Project Structure & Module Organization

Main runtime lives in `src/index.ts`, a TypeScript entry that connects to Chrome DevTools Protocol and normalizes Slack events. Long-form design notes sit in `docs/spec.md` and should be kept in sync with any architecture shifts. Operational helpers for CDP proxies and Slack launchers reside under `hack/`, while temporary data or build artefacts must stay outside the tracked tree.

## Build, Test, and Development Commands

Use `pnpm install` to refresh dependencies when package manifests change. `pnpm start` (alias for `npm run start`) executes `tsx src/index.ts` and expects a Slack desktop session exposing CDP at `CDP_HOST` and `CDP_PORT`. Quality gates bundle into `pnpm run qa`, which now chains `typecheck`, `lint`, `format`, `test`, `svelte-kit sync`, `tsc --noEmit` for the browser workspace, and `vitest` for the SvelteKit app; run it before every push. Spot fixes are available via `pnpm run lint:fix` and `pnpm run format:write`.

## Coding Style & Naming Conventions

Code is TypeScript-first with ESM modules; prefer explicit exports from `src/index.ts` helpers over default exports. Prettier enforces two-space indentation and double-quoted strings, so avoid manual formatting and let the formatter run. Follow camelCase for variables and functions, PascalCase for types and classes, and uppercase snake case for constants like `CDP_PORT`. ESLint is configured with `@typescript-eslint`—treat warnings (e.g., `_`-prefixed unused args) as issues to clean up, not to suppress.

## Testing Guidelines

There is no unit-test harness yet; rely on `pnpm run typecheck` for static safety and ESLint to catch control-flow mistakes. When adding modules, introduce focused integration tests under `tests/` (create the folder if absent) using Vitest or Jest and document setup in the PR. Capture manual verification steps in the PR description, including Slack workspace identifiers and relevant timestamps, so reviewers can reproduce the scenario.

## Commit & Pull Request Guidelines

Recent history favors Conventional Commits (`feat:`, `fix:`, `chore:`) with imperative summaries—continue that pattern and keep messages under 72 characters. Group related changes into a single commit; avoid mixing feature work with formatter noise by running formatters in a separate commit if needed. Pull requests must describe intent, outline verification commands (`pnpm run qa`), and link tracking issues; attach screenshots or logs for Slack interactions when behaviour changes. Request review once the branch has no lint or format diffs (`git status` should be clean after `pnpm run qa`).

## CDP & Slack Environment Notes

Slack automation depends on a reachable Chrome DevTools endpoint; confirm availability with `chrome-remote-interface` before running the collector. The scripts in `hack/` help bridge WSL and Windows Slack sessions—update them when port numbers or launch paths change, and document environment variables inside the scripts. Protect workspace tokens by using `.env.local` or shell exports; never commit credentials or raw Slack payloads to the repository.
