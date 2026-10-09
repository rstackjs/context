# Rstack Context

`@rstackjs/context` records and queries checkout-local build, lint, test, coverage, and Rsdoctor
evidence while keeping freshness, completeness, and provenance explicit. The package is independent
of Rstack CLI. Its MCP server runs directly, while passive build capture integrates through ordinary
Rstack shared configuration.

## Add build context

> [!IMPORTANT]
> This integration requires the public `define.extends()` API proposed in
> [Rstack RFC #504](https://github.com/rstackjs/rstack-cli/discussions/504). The lower-level
> implementation is still landing in Rstack, so keep this setup gated until a released Rstack
> version exports that API.

After that API is released, install `@rstackjs/context` and add its shared configuration to
`rstack.config.ts`:

```ts
import { createRstackContextConfig } from '@rstackjs/context/shared-config';
import { define } from 'rstack';

define.extends([
  createRstackContextConfig({
    products: 'application',
  }),
]);

define.app({
  // Project-specific settings have the normal highest precedence.
});
```

Use `products: 'library'` for a library-only project, or
`products: ['application', 'library']` when the same Rstack configuration intentionally defines
both. Product selection is explicit so adding Context does not change Rstack's automatic Rstest
App-versus-Lib inheritance.

The factory enables metadata capture by default. Set `capture: 'off'`, or set
`RSTACK_CONTEXT=0`, to disable it. `RSTACK_CONTEXT=1` enables metadata capture for an invocation.

## Run the MCP server

The package exports a programmatic stdio entry point.

For an MCP host configuration:

```json
{
  "mcpServers": {
    "rstack-context": {
      "command": "node",
      "args": [
        "--input-type=module",
        "--eval",
        "import('@rstackjs/context/mcp').then(({ runContextMcpServer }) => runContextMcpServer())"
      ]
    }
  }
}
```

The server reads completed build observations from `.rstack/cache/context-v1`. Explicit
`lint_snapshot` and `test_snapshot` requests use the selected package's native
`rslint.config.*` and `rstest.config.*` files. `related_tests` lists the Rstest files related to
one or more source files without executing test cases or writing a snapshot. Both Rstest tools
reject a package that has no native `rstest.config.*` instead of falling back to default workspace
discovery. None of these tools requires a custom command, a Rstack CLI plugin SPI, or generated
wrapper configs.

Codex and Claude Code workflow guidance is distributed separately by
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
Build-context observers use Rsbuild's public APIs. See the
[context engine RFC](./docs/rfc.md) for the evidence model.

Execution coverage evidence is optional and resolved against the package under test, not against
`@rstackjs/context` itself. Install `@rstest/coverage-istanbul` or another supported Rstest
coverage provider in the checkout being analyzed.
