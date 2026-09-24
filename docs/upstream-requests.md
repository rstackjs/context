# Upstream and cross-repository follow-ups

This file lists only gaps that remain after Context moved out of Rstack CLI.

## Rstack shared configuration

[RFC #504](https://github.com/rstackjs/rstack-cli/discussions/504) is the only required Rstack
integration. Internal layer primitives and shared-config normalization have landed, while public
`define.extends()`, shared-layer loading, and the remaining merge paths are still incomplete.

Context's `@rstackjs/context/shared-config` export must remain draft-gated until a released Rstack
package provides the complete public contract and an App/Lib integration fixture passes.

## Rsbuild stats

`src/build.ts` serializes the `Stats` object synchronously in
`onAfterEnvironmentCompile`, then stores bounded assets, chunks, and the compilation hash. Rsbuild
has richer internal helpers for multi-compiler stats, but they are not public.

**Request:** export a supported thin stats-normalization helper from `@rsbuild/core`.

**Payoff:** Context could inherit Rsbuild's multi-compiler child merging instead of keeping a
conservative direct `toJson()` projection.

## Rsdoctor Agent CLI

Context still validates tool input against each catalog entry's JSON schema before calling the
in-process executor.

**Request:** validate catalog tool input inside `createInProcessRsdoctorCliToolExecutor()`, or expose
a supported validation helper.

**Payoff:** delete Context's small JSON-schema matcher and keep catalog validation in one package.

## Rstest configuration provenance

Rstest 0.12.1 resolved the former related-test API gap with public `createRstest()`,
`listTests({ related: true })`, and `run({ related: true })`. No CLI subprocess or injected relation
resolver is required in production.

The remaining opportunity is richer provenance. `loadConfig()` returns the config file and
dependencies, but Context does not yet include all imported config files in test snapshot freshness.

**Request:** keep the current `LoadedRstestConfig` metadata stable while the reusable instance API is
experimental.

**Payoff:** Context can record the complete native config dependency set without depending on
private Rstest internals.
