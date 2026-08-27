# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@pedrolamas/plugin-vue2` — a maintained fork of `vite-plugin-vue2` providing Vue 2.7 SFC support for **Vite 8** (`peerDependencies: vite ^8.0.0`, `vue ^2.7.0-0`). Vue 2 is EOL; this repo tracks Vite releases rather than adding features. It mirrors `@vitejs/plugin-vue` (the Vue 3 plugin) closely — **when in doubt about an approach, check what upstream `vitejs/vite-plugin-vue` does**, since most of this code is a Vue 2 port of it.

## Commands

```sh
pnpm install
pnpm build        # unbuild → dist/{index.mjs,index.cjs,index.d.ts}, then scripts/patchCJS.ts
pnpm test         # vitest run — the full e2e suite
pnpm dev          # unbuild --stub (watch-less stub build)
pnpm release      # interactive: version bump → test → build → changelog → publish → tag
```

There is **no typecheck or lint script**. `pnpm build` is the de-facto typecheck (unbuild emits declarations). Formatting is Prettier **2.x** (`.prettierrc`: no semicolons, single quotes, no trailing commas, `arrowParens: avoid`) — match surrounding style manually.

Run a single test by name (test names are in `test/test.spec.ts`):

```sh
pnpm vitest run -t "css v-bind"
pnpm vitest run -t "SFC <style scoped>"
```

The e2e suite needs Chrome: `pnpm exec puppeteer browsers install chrome`. If that fails mid-download with a zip error, `rm -rf ~/.cache/puppeteer` and retry.

## Architecture

### The two-pass request model

This is the core thing to understand. A `.vue` file is compiled in two passes:

1. **Main request** (`/src/App.vue`) → `src/main.ts` `transformMain()` generates a JS module that *imports* its own sub-blocks as separate requests: `/src/App.vue?vue&type=style&index=0&scoped=<id>&lang.css`, `?vue&type=template`, etc.
2. **Sub-requests** come back through `resolveId` → `load` → `transform` in `src/index.ts`, which dispatches on `query.type` to `src/style.ts`, `src/template.ts`, or the script cache.

`src/utils/query.ts` (`parseVueRequest`) parses these ids; `src/utils/descriptorCache.ts` is the shared state that lets pass 2 find the parsed SFC from pass 1 — keyed by filename, plus a *previous* descriptor cache used only by HMR to diff blocks.

`descriptor.id` is the first 8 hex chars of a sha256 of the **root-relative** path (plus source in production). It becomes the `data-v-<id>` scope attribute, so anything changing root resolution changes scope ids.

### Files

| File | Role |
|---|---|
| `src/index.ts` | Plugin factory, all Vite hooks, request dispatch |
| `src/main.ts` | `transformMain` — assembles script + template + styles + custom blocks + normalizer + HMR |
| `src/script.ts` | `compileScript` (handles `<script setup>`), WeakMap caches per descriptor |
| `src/template.ts` | Template compile; asset-URL base injection; rewrites Vue 2's `require()` output to hoisted imports |
| `src/style.ts` | `compileStyleAsync` — **only** scoped mode + `v-bind()` CSS vars |
| `src/handleHotUpdate.ts` | Narrows which modules Vite reloads; block-diff helpers |
| `src/compiler.ts` | Resolves the consumer's `vue/compiler-sfc` via `createRequire` |
| `src/utils/{hmrRuntime,componentNormalizer}.ts` | Virtual modules, source inlined as strings |

### Conventions that are easy to break

- **Styles must end in `&lang.<ext>`.** That suffix is what makes the id match Vite's `CSS_LANGS_RE` and flow into Vite's CSS pipeline. Preprocessors and CSS Modules are **Vite's job, not ours** — `style.ts` deliberately does not handle them. CSS Modules work by injecting `.module.` before the extension so Vite's `cssModuleRE` matches.
- **Virtual modules** use `\0plugin-vue2:` prefixes (`\0plugin-vue2:normalizer`, `\0plugin-vue2:hmr-runtime`) and are returned as-is from `resolveId`.
- **HMR is self-contained.** `__VUE_HMR_RUNTIME__` here is a *virtual module default export*, not Vue's global. `main.ts` emits an `import.meta.hot.accept` that picks rerender vs. full reload via an exported `_rerender_only` flag.
- **Hook filters:** `resolveId`/`load`/`transform` use object form with `filter.id` (via `@rolldown/pluginutils`). These are a coarse pre-pass over *raw ids* — the in-handler guards (`createFilter`, `query.raw`, `!filter(filename) && !query.vue`) still operate on parsed filenames and must be kept.
- Scoped styles emit `meta.vite.cssScopeTo: [descriptor.filename, 'default']` so Vite can treeshake unused SFC CSS. `'default'` is correct because `transformMain` emits `export default __component__.exports`. Upstream also guards this with `&& !descriptor.isTemp`; that's omitted here because `getSrcDescriptor` (`src/utils/descriptorCache.ts`) has no temp-descriptor fallback and always resolves the real owning file — if that ever changes, `cssScopeTo` needs the same guard added back.

### Vite API surface / compat notes

Deliberately uses only public `vite` exports — **no deep imports** (`vite/dist/...`), no `_`-prefixed fields. Keep it that way.

HMR still uses the **legacy** `handleHotUpdate` + `ModuleNode` compat layer (matching `mainModule.importers`, matching module `url` by regex) rather than the newer `hotUpdate` + `EnvironmentModuleNode` environment API. Same for `load`/`transform` reading `opt.ssr` instead of `this.environment`. This is intentional — upstream `@vitejs/plugin-vue` hasn't migrated either — but it's the first thing that will need attention if Vite 9 drops the compat `ModuleGraph`.

The `vue` → `vue/dist/vue.runtime.esm.js` alias must live in the **`config()`** hook. It was previously pushed onto `config.resolve.alias` in `configResolved`, which is a silent no-op: Vite snapshots alias entries during `resolvePlugins`, before `configResolved` runs. It's built with Vite's own exported `mergeAlias(ours, config.resolve?.alias)` — reuse this for any alias-injecting plugin code rather than hand-rolling array/object detection; `mergeAlias`'s array form puts its *second* argument first, so passing the incoming config as the second arg is what makes a user-supplied `vue` alias win.

SSR is a `// TODO` stub — `transformMain` has an `if (ssr)` block that does nothing.

## Testing

One spec (`test/test.spec.ts`) runs the same `declareTests()` body twice, as `describe('dev')` and `describe('build')`. `test/util.ts` copies `playground/` → `temp/`, runs a real `vite build`, then spawns the Vite binary and drives it with puppeteer.

Gotchas:

- Tests assert `buildOutput.stderr === ''`, so **any new Vite warning breaks the suite**. Vite 8.2 added a native-config-loader warning; `test/util.ts` sets `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` on spawned processes to suppress it.
- The dev server URL is hardcoded to `http://localhost:5173`.
- `playground/vite.config.ts` imports the plugin from `../src/index` (source, not `dist`), so tests exercise your edits without rebuilding.
- **`test/vitest.config.ts` is orphaned.** There is no root vitest config, so its `testTimeout: 100000` never applies and the e2e suite runs on the 5s default. It passes today but is flake-prone.

## Build

`unbuild` with `inlineDependencies: true` — runtime deps (`slash`, `hash-sum`, `debug`, `@rolldown/pluginutils`) are **devDependencies** and get bundled into `dist/`. Only `vite` and `vue/compiler-sfc` stay external. Add new runtime deps as devDependencies to match.

`scripts/patchCJS.ts` then regex-rewrites `dist/index.cjs` so `require(...)` returns the function directly. It's brittle to unbuild/rollup codegen changes and `process.exit(1)`s if its pattern stops matching — if `pnpm build` fails there after a toolchain bump, that's why.

## Repo conventions

- Branches must be prefixed `pedrolamas/`.
- Conventional commits (`fix:`, `ci:`, `chore:`, `feat:`, `release:`) — the changelog is generated from them.
- `playground/` is a pnpm workspace package; `pnpm-workspace.yaml` pins its `vue` to the root devDependency.
- Node is pinned by `.node-version` (v24.12.0); CI runs a single OS/Node combo with no Vite version matrix.
