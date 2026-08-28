# Contributing to PinBench

PinBench is meant to be worked on by more than one person, and by people who
were not there when a decision was made. That means the conventions below are
part of the code, not paperwork around it.

## Ground rules

**The renderer is sandboxed, and stays that way.** `contextIsolation` is on,
`nodeIntegration` is off, `sandbox` is on, and the renderer's only way out is
the preload bridge. Adding a capability means adding a channel to
`src/shared/ipc.ts`, exposing it in `src/preload/index.ts`, and handling it in
the main process — in that order. Nothing in `src/renderer/` may import Node
built-ins or Electron.

**Shared code is the contract.** Anything both processes need — types, pure
logic, tables — lives in `src/shared/` and imports neither Electron nor the DOM.
Keeping the workspace reducer, the command table and the board schema there is
what lets them be unit-tested without a window.

**One source of truth per fact.** The menus, their accelerators and their
enabled state come from `src/shared/commands.ts`: the native menu and the
in-window menu bar are both built from it, so they cannot drift. The canvas
footer's counts are computed from the board definition by `boardTotals`, never
written down.

**Fixture data never leaks into component signatures.** M1's board is a fixture
(`src/renderer/src/fixtures/m9.ts`), but it implements the real
`BoardDefinition` types from `src/shared/board.ts`. When M5 loads a definition
from disk, the fixture is deleted and nothing else changes. If a component needs
a new field, add it to the schema first.

**Draw what the design shows; disable what does not work.** A control whose
milestone has not landed is rendered and disabled, not omitted and not faked. A
disabled Build & flash button is honest; one that pretends to compile is not.

**Every colour, size and duration is a token.** `src/renderer/src/styles/tokens.css`
is the Nocturne design system: neutral, accent and accent-2 ramps from 100 to
900, semantic surfaces and text, layout metrics, motion. A hardcoded hex value
in a component is a bug.

**Fonts are bundled, never fetched.** Inter and JetBrains Mono ship as npm
dependencies and are inlined at build time. The renderer's Content-Security
Policy allows no network at all in a build; do not relax it to reach a CDN.

## Before you push

```sh
npm run check
```

That is exactly what CI runs — typecheck, lint, format, tests, build — on macOS,
Linux and Windows.

Keep every path, binary lookup and device-naming assumption platform-agnostic
even while developing on macOS. Windows and Linux support is a milestone of its
own (M15), but it is not a rewrite unless we make it one.

## Tests

Vitest, with jsdom for anything that renders. `test/setup.ts` installs a fake
preload bridge, so the whole shell can be driven in tests exactly as it is in
the app; main-process modules take their collaborators (file paths, windows) as
arguments so they can be tested against a temp directory rather than a running
Electron.

What is worth testing:

- Pure logic in `src/shared/` — thoroughly, including the "someone hand-edited
  the settings file" paths.
- Behaviour a user would notice: a panel toggling, a tab switching, a layout
  surviving a restart, the canvas panning.
- Not the styling. That is what the design and your eyes are for.

## Decisions

Anything that would be expensive to reverse gets an ADR in `docs/adr/`. Number
it, state the context, the decision, and the consequences — including the
measurements, if there were any. [ADR 0001](docs/adr/0001-device-model-boundary.md)
is the shape to follow.
