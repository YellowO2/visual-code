# visual-code

**Understand your project visually when coding with AI.**

When an AI writes most of your code, the hard part stops being typing and becomes
*knowing what you have*. You can't steer a project you can't see: you notice too late that
a step quietly does three jobs, that data takes a detour through the disk, or that the UI
reaches into the engine's insides. visual-code gives you two things to keep that knowledge:

1. **A live diagram drawn from the code itself.** Folders are machines, files are parts,
   and lines show how values flow between them. It updates as the AI edits, so you watch
   the shape of the project change while it works.
2. **A small set of rules, checked by a linter,** that keep the code in a shape the diagram
   can show honestly. When the code breaks one, you get a warning with the file and line,
   and the agent gets an exact thing to fix.

![A project drawn as machines: the UI's jobs calling the engine's two operations](showcase/14-two-operations.jpg)

## The idea

A project is a **machine** made of **parts**:

- **A folder with a `main.py` is a machine.** Its `main.py` only wires its parts together,
  one line per step: `scene = reconstruct(corridor, settings)`. That wiring *is* the diagram.
- **A file is a part,** with one job, named after what it does.
- **Values pass along wires** between parts, and enter and leave a machine through **ports**
  on its wall. Open a machine to see its inside; close it to see only its wall.
- **Machines that serve others offer endpoints.** A user interface calling an engine is drawn
  as a dashed *call* to the engine's endpoint, such as `build_scene(corridor, settings)`.
- **Mess shows.** A step doing work it should hand off, a value passed under two names, a
  helper used by one file only: each one looks wrong on the diagram, and the checker names it.

The rules are in [`RULES.md`](RULES.md). Most of them are old, well-tested ideas, made
visible and checkable: dataflow and [flow-based programming](https://jpaulm.github.io/fbp/)
(boxes and wires), a single composition root (wire everything in one place), dependency
injection (parts are handed what they use), [ports and adapters](https://alistair.cockburn.us/hexagonal-architecture/)
and Parnas's information hiding (a machine's inside versus what it offers), and the
[C4 model](https://c4model.com/)'s zoom levels. What is different here is that the folder
layout *is* the diagram, and the rules are strict enough for a linter to enforce, so you
can rely on the tool rather than on the AI remembering.

## Before and after

panoramic-da3, a small library, before and after following the rules: 15 inputs and files
passed through the disk, then 2 inputs, 2 outputs, everything in memory.

| Before | After |
|---|---|
| ![](showcase/02-panoramic-first-wires-15-inputs.jpg) | ![](showcase/06-panoramic-after-2-in-2-out.jpg) |

## Install

Needs Node 20 or later.

```bash
git clone https://github.com/YellowO2/visual-code.git
cd visual-code
npm link            # puts the `visual-code` command on your PATH
```

## Use

```bash
visual-code <project>          # the diagram at http://localhost:4400, live; --port to change
visual-code check <project>    # every rule break as path:line, exits non-zero if any
visual-code rules              # print the rules
```

In the diagram: click a machine to open it, click its heading to close it, click a file
to copy its path (handy for pointing your AI at it), hover a box to see what it does and
who uses it. The strips at the bottom hold the tools, types and public API that no wire
reaches.

## With an AI agent

[`skill/visual-code/`](skill/visual-code/SKILL.md) is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills):
it teaches an agent to restructure a project against the rules, step by step, proving
behaviour unchanged, and to show you the diagram before and after. Install it for every
project with:

```bash
ln -s "$PWD/skill/visual-code" ~/.claude/skills/visual-code
```

Then ask, in any project: *"Use the visual-code skill to restructure this project. Show me
the diagram before and after, and keep behaviour identical."*

The checker reads Python projects today (folders, imports and `main.py` wiring). The
diagram's ideas aren't Python-specific; other languages need their own reader.

## Develop

```bash
npm install
npm run build        # bundles the viewer (src/view/app.jsx) into src/view/app.js
```

`src/tree.js` reads a project (with `imports.js` and `wiring.js`), `src/checks.js` holds the
checks, `src/server.js` serves the page and pushes changes to it, and `src/view/` is the
page, drawn with [React Flow](https://reactflow.dev) over an [ELK](https://eclipse.dev/elk/)
layout. [`showcase/`](showcase/) has more screenshots and the story behind them.

## License

MIT
