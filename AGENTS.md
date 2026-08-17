# AGENTS.md

## Stack

- Use the Node.js and pnpm versions declared in `package.json`.
- TypeScript package built with Rslib.
- Rsbuild APIs power build-context observation.
- Rstest runs tests and coverage.
- Rslint performs lint and type-aware checks.

## Commands

```bash
corepack enable
pnpm install
pnpm check
pnpm build
pnpm test
pnpm test:coverage
```

## Architecture

- Keep the context runtime independent of the `rstack` CLI package.
- Keep Rstack-specific command and configuration adapters in `rstackjs/rstack-cli`.
- Keep Codex and Claude plugin packaging and skills in `rstackjs/agent-skills`.
- Preserve freshness, completeness, provenance, and evidence axes independently.
- Missing Rstack producers must degrade to unavailable evidence rather than prevent other tools from
  working.

## Changes

- Add tests for public API, store-schema, MCP-schema, or evidence-semantic changes.
- Keep the package API and MCP tool schemas backward compatible unless a breaking change is explicit.
- Use pkg.pr.new previews for cross-repository Rstack CLI validation.
