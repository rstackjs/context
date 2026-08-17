# Rstack context

`@rstackjs/context` is the runtime behind the Rstack project-context MCP. It records and queries
checkout-local build, lint, test, coverage, and Rsdoctor evidence while keeping freshness,
completeness, and provenance explicit.

Most users install and invoke it through the `rstack` package:

```bash
rs mcp
```

The `rstack/context` export re-exports this package for programmatic consumers. Codex and Claude
Code workflow guidance is distributed separately by
[`rstackjs/agent-skills`](https://github.com/rstackjs/agent-skills).

## Development

```bash
corepack enable
pnpm install
pnpm check
pnpm build
pnpm test
```

The package uses Rslib for builds, Rstest for tests, and Rslint for lint and type-aware checks.
Rsbuild remains a public integration surface for build-context observers. See the
[context engine RFC](./docs/rfc.md) for the runtime architecture and evidence semantics.

Execution coverage evidence is optional and resolved against the package under test, not against
`@rstackjs/context` itself: install `@rstest/coverage-istanbul` (or another supported Rstest
coverage provider) as a dependency of the checkout being analyzed for coverage evidence to be
captured. `@rstackjs/context` does not declare that provider as a peer dependency.
