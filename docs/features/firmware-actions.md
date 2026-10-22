---
title: Firmware actions — feedback to the IDE
area: build
status: done
---

# Firmware actions — feedback to the IDE

PinBench configures and simulates hardware. It **never edits firmware source**:
code lives in the external IDE (VS Code, or any editor with a coding agent).
PinBench still opens the PlatformIO folder, builds it and boots it, but it only
reads the folder.

When the simulated hardware needs something from the code, PinBench reports it
as a **firmware action**. A human or a coding agent makes the change in the IDE,
rebuilds, and the list updates.

## What is reported

`src/shared/actions.ts` holds a pure `collectActions(inputs) → FirmwareAction[]`.
Errors come first.

| Kind                   | When                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build-error`          | The last build produced an `error` diagnostic. `file` is project-relative and carries `line`/`column`.                                                                         |
| `pin-header-missing`   | Firmware source mentions `<boardId>_pins.h` but `include/<boardId>_pins.h` does not exist. `fix` carries the whole `generatePinHeader()` text.                                 |
| `pin-header-drift`     | The header exists and is included, but a `#define` differs from the canvas, is missing, or is not on the canvas. One action per define, with `symbol` / `expected` / `actual`. |
| `emulated-net-missing` | The profile sets `emulator.network: "user"` but no source mentions `PINBENCH_EMULATED_NET` ([[emulated-network]]).                                                             |

A header that no firmware source includes produces no actions: drift in it
changes nothing on the device. The canvas is the spec, and the header follows it
([[pin-map-verify-and-codegen]]).

## Where it shows up

The main process recomputes the list when a folder is opened, when a build ends,
when canvas edits or the env are saved, and when the window regains focus (you
have probably just come back from the IDE). It then mirrors the list three ways:

- **The Firmware actions dock tab** (`⌘3`). Rows with a file open it in the
  external editor.
- **The `firmware_actions` MCP tool** ([[agent-control-plane]]). It is read-only
  and recomputes on every call, so an agent can loop: call it, edit, `build_start`,
  call it again until `count` is 0.
- **`<project>/.pinbench/actions.md`**, for agents and people without MCP. This is
  the only file PinBench writes into a firmware folder. The directory ignores
  itself with a `.gitignore` containing `*`, so the project's own ignore file is
  never touched. The file is deleted when the list is empty and is not rewritten
  when its content has not changed.

## Opening files in the editor

Compiler diagnostics, firmware actions and the Inspector's firmware-hook card
call `project.openInEditor(file, line, column)`. The main process accepts only
paths inside the open project and opens a URL built from a template with
`{path}`, `{line}` and `{column}`. The template comes from `editorUrl` in
`session.json`, else `PINBENCH_EDITOR_URL`, else
`vscode://file{path}:{line}:{column}`. For Cursor, use
`cursor://file{path}:{line}:{column}`.

## What was removed

These were removed for this split:

- the Source tab, its file tree and highlighter;
- the recursive project watcher;
- `project_tree`, `project_read_file` and `pinmap_write`;
- the pin-header write on Build & run;
- the in-app agent's `fs/write_text_file`. Its `fs/read_text_file` stays, read-only
  and confined to the project.

**Export / Import pin header…** remain. Export saves to a path you choose, and
Import only reads.
