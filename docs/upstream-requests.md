# Upstream and cross-repo follow-ups

This document tracks gaps in upstream (`rstest`, `rsbuild`, `rsdoctor`) public
APIs that this package currently works around locally, plus open
cross-repo coordination items with `rstack-cli`. Each entry cites the exact
local code the request would let us delete or simplify, and the upstream
surface (or lack of one) that motivates it.

## Upstream API requests

### 1. rstest (`web-infra-dev/rstest`): expose related-test selection publicly

`src/testRun.ts` injects a `resolveRelatedTests: ResolveRelatedTests`
dependency (`TestCaptureDependencies.resolveRelatedTests`, `src/testRun.ts:111`)
so that `captureTestSnapshot` can turn a set of changed source files into the
test files that cover them (`request.related`, validated in
`validateRelatedSelection`, `src/testRun.ts:280`-`292`, and consumed at
`src/testRun.ts:380`-`399`). This selection logic is not something this
package implements itself — it delegates to Rstest's own related-file
resolver, which is bundled but not exported.

Verified against the installed `@rstest/core@0.11.6`:

- `resolveRelatedTestFiles` (upstream source: `packages/core/src/core/related.ts`)
  ships only inside the bundled implementation chunks
  (`dist/related~0.js`, `dist/3374~0.js`); it does not appear in any of the
  package's public `.d.ts` entry points (`dist/index.d.ts`, `dist/api/index.d.ts`,
  `dist/browser.d.ts`).
- The public programmatic API's `RunRstestOptions`
  (`dist/api/index.d.ts:1193`-`1212`) has no `related` field — only `cwd`,
  `config`, `inlineConfig`, `files`, and `testNamePattern`.
- The CLI does expose `--related` / `--findRelatedTests` (see the
  `relatedFilters?: string[]` field on the CLI-facing result type at
  `dist/index.d.ts:3388`), so the capability exists, but only inside the CLI
  entry point that dynamically imports `related.ts` internally — not through
  any package export a library consumer can import.

**Request:** add `related?: string[]` to `RunRstestOptions` (mirroring
`--related`/`--findRelatedTests`), or export `resolveRelatedTestFiles` (or an
equivalent) from `@rstest/core/internal/browser` alongside the already-exported
`loadCoverageProvider`.

**Payoff:** this package's own `resolveRelatedTests` dependency-injection
seam (`ResolveRelatedTests` type, `src/testRun.ts:96`-`102`) and the caller
that has to supply it become unnecessary — related-test resolution could call
straight into Rstest.

### 2. rsbuild (`web-infra-dev/rsbuild`): export the internal thin stats contract

`src/build.ts`'s `buildMetadataFacet` (`src/build.ts:52`-`140`) calls
`stats.toJson({ all: false, hash: true, assets: true, chunks: true, errors:
false, warnings: false })` directly against the Rspack `Stats` instance handed
to `onAfterEnvironmentCompile`, then walks `assets`/`chunks`/`hash` by hand
with defensive `typeof` guards.

Verified against the installed `@rsbuild/core@2.1.11`: it has its own internal
helper, `helpers/stats.ts`, that is not part of the public entry
(`dist/index.d.ts`'s export list has no `RsbuildStats`, `getRsbuildStats`,
`getStatsErrors`, or `getStatsWarnings` — confirmed by grepping the full
public type-export list). The internal module (`dist/helpers/stats.d.ts`)
exports:

```ts
export declare const getStatsErrors: ({ errors, children }: RsbuildStats) => Rspack.StatsError[];
export declare const getStatsWarnings: ({
  warnings,
  children,
}: RsbuildStats) => Rspack.StatsError[];
export declare function getRsbuildStats(
  statsInstance: Rspack.Stats | Rspack.MultiStats,
  compiler: Rspack.Compiler | Rspack.MultiCompiler,
  logger: Logger,
  action?: ActionType,
): RsbuildStats;
```

Its bundled implementation (`dist/626.js`) builds the `toJson` options from
the _actual_ compiler (single vs. multi-compiler, via
`compiler_isMultiCompiler(compiler)`), and `getStatsErrors`/`getStatsWarnings`
walk `stats.children` to merge per-child errors/warnings when the top-level
`errors`/`warnings` are absent. `src/build.ts` does none of this today — it
only reads `json.assets`, `json.chunks`, and `json.hash` off the single
`stats.toJson(...)` result, so a multi-compiler environment's per-child
assets/chunks are silently dropped from the metadata facet.

**Request:** re-export `RsbuildStats`, `getRsbuildStats`, `getStatsErrors`,
and `getStatsWarnings` from `@rsbuild/core`'s public entry (`dist/index.d.ts`),
the same way `Rspack` itself is already re-exported as a type.

**Payoff:** `buildMetadataFacet` could call `getRsbuildStats` instead of a
raw `stats.toJson(...)`, inheriting correct multi-compiler `children`
merging for free instead of this package reimplementing it.

### 3. rsdoctor (`web-infra-dev/rsdoctor`) `agent-cli`

**(a) Validate tool input against each catalog tool's own `inputSchema`
inside the executor.**

`src/rsdoctor.ts` maintains a hand-rolled JSON Schema subset matcher,
`matchesJsonSchema` (`src/rsdoctor.ts:186`-`232`, with `matchesSchemaType` at
`src/rsdoctor.ts:161`-`184`), that duplicates a slice of JSON Schema
(`type`, `minimum`/`maximum`, `items`, `properties`/`required`,
`additionalProperties`) purely to validate a tool call's input against the
`inputSchema` that `getToolCatalog()` already publishes per tool
(`tool.inputSchema`, loaded at `src/rsdoctor.ts:146`, checked at
`src/rsdoctor.ts:236` via `getInput`). `createInProcessRsdoctorCliToolExecutor()`
(also from `@rsdoctor/agent-cli`, used at `src/rsdoctor.ts:153`) does not
perform this validation itself before executing a tool.

**Request:** have the executor returned by
`createInProcessRsdoctorCliToolExecutor()` validate the caller's input
against the tool's own `inputSchema` before running it (or expose a
`validateToolInput(tool, input)` helper alongside `getToolCatalog()`).

**Payoff:** deletes `matchesJsonSchema`/`matchesSchemaType` and the
`getInput` validation branch entirely — the package would only need to catch
and translate the executor's own validation error.

**(b) Document (and converge) a behavioral divergence between the published
package and the pkg.pr.new preview build this repo's CI depends on.**

`package.json` declares `"@rsdoctor/agent-cli": "0.1.1"` (`package.json:67`),
but `pnpm-workspace.yaml` overrides that resolution to a preview build:

```yaml
overrides:
  '@rsdoctor/agent-cli': 'https://pkg.pr.new/@rsdoctor/agent-cli@1903'
```

The two builds disagree on how an _omitted_ artifact section (one whose
`metadata.summary.status === 'omitted'`, e.g. because the Rsdoctor run used an
output mode that skips that section) is reported for output-mode-omitted
data. Published `@rsdoctor/agent-cli@0.1.1` returns `{ ok: true, data: null
}`. The pkg.pr.new preview build returns a structured failure instead:
`{ ok: false, error: { code: 'RSDOCTOR_SECTION_UNAVAILABLE', ... } }`. This
repo's own test, `tests/rsdoctor.test.ts` ("distinguishes collected empty
data from an omitted artifact section", asserting the `RSDOCTOR_SECTION_UNAVAILABLE`
shape), only passes against the preview build's new semantics — this
package's CI cannot ship against the published `0.1.1` release as-is.

**Request:** cut a release of `@rsdoctor/agent-cli` that includes the
`RSDOCTOR_SECTION_UNAVAILABLE` semantics from the pkg.pr.new preview (PR/build
`1903`), and once it ships, drop the `pnpm-workspace.yaml` override and bump
`package.json`'s `@rsdoctor/agent-cli` dependency to that release.

## Cross-repo follow-ups (rstack-cli coordination)

### 1. Wrapper-config elimination

Both capture paths in this package write to disk a generated "wrapper"
config file and pass its path to the underlying tool, rather than passing
config in memory:

- `src/testRun.ts`: `wrapperConfigPath` (default resolved via
  `resolveInternalConfigPath(import.meta.dirname, 'rstestConfig.js')`,
  `src/testRun.ts:338`-`340`) is passed as `runRstest({ config:
wrapperConfigPath, ... })` (`src/testRun.ts:407`-`416`).
- `src/lint.ts`: `wrapperConfigPath` (defaulted the same way, resolving
  `rslintConfig.js`, `src/lint.ts:251`-`252`) is passed as
  `overrideConfigFile: wrapperConfigPath` (`src/lint.ts:264`-`268`).

Both underlying tools already support passing config without a file on disk:

- `@rstest/core@0.11.6`'s `RunRstestOptions.inlineConfig?: RstestUserConfig`
  is shallow-merged with any on-disk config, and `config` itself is optional
  (`dist/api/index.d.ts:1193`-`1212`) — a run can be driven purely by
  `inlineConfig`. The package also exports `loadConfig` (`dist/index.d.ts:1959`)
  and `mergeRstestConfig` (`dist/index.d.ts:2145`) for merging config values
  programmatically.
- `@rslint/core@0.8.0`'s `RslintOptions.overrideConfigFile?: string | true |
null` accepts `true` to mean "use only `overrideConfig`, no file, no
  discovery" (`dist/index.d.ts:301`), paired with `overrideConfig?:
RslintConfigEntry | RslintConfig | null` (`dist/index.d.ts:295`) for the
  in-memory config value itself.

In principle this means `rstestConfig.js`/`rslintConfig.js` and the whole
`resolveInternalConfigPath` file-resolution mechanism
(`src/source.ts:63`-`71`) could be deleted in favor of passing
`inlineConfig`/`overrideConfig` directly. The blocker is that the translation
from a project's `rstack.config.*` file into the producer-specific config
those wrapper files currently encode is not owned by this package — it lives
in `rstack-cli`'s `packages/rstack/src/mcp.ts`, which is the caller that
injects `wrapperConfigPath` into this package's `LintCaptureAdapter`
(`src/lint.ts:70`-`73`, `{ wrapperConfigPath: string; withConfigTarget:
ConfigTargetRunner }`) and `TestCaptureDependencies`
(`src/testRun.ts:104`-`117`, `wrapperConfigPath?: string`).

Concrete migration steps, to be coordinated with `rstack-cli`:

1. In `rstack-cli`, change the `rstack.config.*` → producer-config
   translation in `packages/rstack/src/mcp.ts` so it produces an in-memory
   config _value_ (an `RstestUserConfig` for tests, an `RslintConfigEntry`/
   `RslintConfig` for lint) instead of writing a wrapper `.js` file to disk.
2. Extend `LintCaptureAdapter` and `TestCaptureDependencies` in this package
   to accept that value directly — e.g. `overrideConfig?: RslintConfigEntry |
RslintConfig` alongside (or replacing) `wrapperConfigPath`, and
   `inlineConfig?: RstestUserConfig` alongside (or replacing) the
   `TestCaptureDependencies.wrapperConfigPath` equivalent.
3. In `src/lint.ts`, switch `captureLintSnapshot`'s options construction
   (`src/lint.ts:264`-`268`) to `overrideConfigFile: true, overrideConfig:
adapter.overrideConfig` when an in-memory config is supplied, keeping the
   file-path branch as a fallback for callers that still pass
   `wrapperConfigPath`.
4. In `src/testRun.ts`, switch the `runRstest(...)` call
   (`src/testRun.ts:406`-`416`) to omit `config` and pass
   `inlineConfig: dependencies.inlineConfig` (merged with the existing
   coverage `inlineConfig` block at `src/testRun.ts:345`-`360`, via
   `mergeRstestConfig` if both are present) when supplied.
5. Once every `rstack-cli` caller passes the in-memory form, delete
   `resolveInternalConfigPath` (`src/source.ts:63`-`71`) and the bundled
   `rstestConfig.js`/`rslintConfig.js` wrapper files.

This is sequenced as a joint change: this package's public
`LintCaptureAdapter`/`TestCaptureDependencies` contract and `rstack-cli`'s
`mcp.ts` config translation must land together, since neither side can drop
the file-path form until the other stops relying on it.

### 2. `artifactProducts.ts`: synthesized roots for `product: 'unknown'` — open design question

`resolveArtifactProductRoots` (`src/artifactProducts.ts:5`-`24`) is the entry
point that `loadAnalysis` (`src/queries.ts:207`-`233`) uses to compute the
product roots feeding `findUnusedCandidates` and `explainDeadCodeCandidate`
(`src/queries.ts:410`, `581`) verdicts. For a context whose `product` is
neither `'application'` nor `'library'` (i.e. `'unknown'`, per
`ContextDescriptor.product`), it does not skip root resolution — it calls
`resolveProductRoots` a second time with `product` forced to `'application'`
and tags the result:

```ts
const artifactRoots = await resolveProductRoots(
  workspaceRoot,
  { ...context, product: 'application' },
  graph,
);
return {
  ...artifactRoots,
  product: 'unknown',
  bounds: ['product-context-unavailable', ...artifactRoots.bounds],
};
```

Two consequences follow directly from `resolveProductRoots`
(`src/products.ts:89`, `105`-`128`):

- The synthesized roots are _application_-shaped: entrypoint/production
  roots are computed, but the `context.product === 'library'` branch that
  computes `published-contract` roots (`src/products.ts:106`-`128`) is
  skipped entirely, because the forced context is `'application'`, never
  `'library'`.
- The only signal that this happened is the `'product-context-unavailable'`
  string prepended to `bounds` — callers that don't inspect `bounds` see a
  normal-looking root set for a context whose real product is unknown.

This is an unresolved design question, not a bug fix — pending an owner
decision, the two options are:

- **Option A — keep annotated synthesis (current behavior).** Continue
  computing application-shaped roots for `'unknown'` contexts and rely on the
  `'product-context-unavailable'` `bounds` entry for downstream consumers to
  decide how much to trust the verdict. Simple, but silently wrong for
  library-shaped code under an unknown context, since it never considers
  `published-contract` roots.
- **Option B — degrade to insufficient-evidence.** When `context.product` is
  `'unknown'`, have `resolveArtifactProductRoots` return an explicit
  insufficient-evidence result (no synthesized roots) instead of a
  best-effort application-shaped one, and have `findUnusedCandidates`/
  `explainDeadCodeCandidate` surface that as a distinct "product context
  unavailable" outcome rather than a normal verdict annotated with a bounds
  string. More conservative and legible, but a behavior change for every
  existing caller in an unknown-product context.
