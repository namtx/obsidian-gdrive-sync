Status: resolved
Type: task
Blocked by: none

# Scaffold plugin and toolchain

Create the TypeScript Obsidian plugin skeleton (manifest, esbuild, Vitest), with folders `core/`, `drive/`, `obsidian/`. Builds `main.js` and runs an empty test suite.

Done when: `npm run build` and `npm test` pass, and the plugin loads in Obsidian desktop showing a no-op command.

Spec: ../spec.md

## Answer

Scaffolded: package.json, manifest.json (id gdrive-sync), versions.json, tsconfig.json, esbuild.config.mjs, vitest.config.ts, src/main.ts (no-op "Sync now" command), src/{core,drive,obsidian}/. `npm run build` and `npm test` pass. Node 24 is installed via mise; put ~/.local/share/mise/shims on PATH. Not verified: loading in Obsidian desktop (Obsidian is not installed on this Mac). That check moves to ticket 15. Note: tsconfig must not set baseUrl to src, or `import "obsidian"` resolves to src/obsidian/.
