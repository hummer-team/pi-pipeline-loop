# AGENTS.md

## Commands

- Build: `bun run build` (runs `tsc`, outputs CommonJS to `dist/`)
- Typecheck: `bun run typecheck` (runs `tsc --noEmit`)
- Test: `bun run test` (runs `bun test`, 1964 tests across 80 files)

## Architecture

This is `@earendil-works/pi-pipeline`, a plugin for the **pi agent** SDK. It exports a `createPipeline(config)` factory that returns a `PipelinePlugin` (`{ hooks, tools, commands }`). The plugin enforces a 7-stage pipeline: `clarify → plan → develop → review → fix → awaiting_human → completed`.

### Modules (all phases implemented)

| Module | Files | Count |
|--------|-------|-------|
| **Hooks** (6) | `session-starter`, `prompt-injector`, `tool-guard`, `loop-breaker`, `agent-settled`, `session-shutdown` | All in `src/core/` |
| **Tools** (6+1) | `stage-advancer`, `loop-checker`, `pipeline-state` (core) + `generate-summary`, `validate-summary`, `pipeline-handoff` (tools) + `pipeline-verify` (conditional) | Mixed `src/core/` + `src/tools/` |
| **Commands** (5) | `pipeline-status`, `pipeline-start`, `pipeline-init`, `pipeline-quit`, `pipeline-resume` | `src/commands/` |


## Gotchas

- **Peer dep not installed locally**: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are `peerDependencies`. They do NOT exist in `node_modules/` here. The plugin compiles against stub interfaces (`Hook`, `Tool`, `Command`) that use `any` for ctx/return types because the pi SDK types aren't available.
- **Never edit `dist/` directly** — it's build output from `src/`.
- **All implementation phases are complete**: no stubs remain.
- **Tests**: `bun test` (native Bun runner), `@types/bun` in devDependencies. Tests in `src/__tests__/` are excluded from `tsc` via `tsconfig.json`.
- **No CI** configured.
- **Version**: `0.1.0` — all code implemented, ready for integration testing with pi SDK.

## Style

- TypeScript strict mode (`tsconfig.json`: `"strict": true`)
- Target ES2022, output CommonJS
- Explicit type re-exports via `export type { ... } from "./types"`
- Hook handlers follow a factory pattern (`createSessionStarter(config)`, `createPromptInjector(config)`)
- Tool handlers use `PipelineConfig` closure pattern with `ctx.session` for state access
- Audit logs are JSON Lines, appended to `{auditDir}/YYYYMMDD_audit.log` (date-rotated daily)
- Test helpers in `src/__tests__/helpers.ts` (factories: `makeTestConfig`, `makeTestMeta`, `createMockCtx`)
- **Code Standards**:
    - All code comments and logs must be written in English
    - The overall code shall follow TypeScript best‑practices with clear comments
- **Naming Standards**: New directories or files must use business‑meaningful names and comply with naming conventions. Meaningless names such as `temp.typescript`, `test2.typescript` are forbidden.

## 🛡️ Scope Boundaries
The following files/directories are **protected assets**. Modification is prohibited without explicit instructions:
- `package.json` — Core project file, any change requires separate build verification