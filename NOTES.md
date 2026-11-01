# Notes for later work

## Upgrades of the pi packages

The pi packages (`@earendil-works/pi-ai`, `pi-durable`, `chord`) are pinned to 1.4.0.

- **JSON Schema (breaking change expected):** the pi maintainer announced pi-schema (2026-10-31, https://x.com/badlogicgames/status/2116653884362097081), a JSON Schema builder and validator that works without `eval()`. pi-durable is expected to change its JSON validator, so the TypeBox schemas (`Type.Object`, `Type.String`, `Type.Union`, …) of the tool parameters can break. They are in `web/src/extensions/figma.ts`, `skills.ts` and `subagent.ts`. Before an upgrade, read the changelog, migrate the schemas, and run the tests and the Chrome runs.
