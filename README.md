# visual-code

**Understand your project visually when coding with AI.**

AI writes code fast, and you lose track of what it built. visual-code gives you:

1. **A live diagram of your code.** Folders are machines, files are parts, and lines are values passing between them.
2. **Rules a linter checks.** They keep the code in a shape the diagram can show.

![The UI's jobs calling the engine's two operations](showcase/14-two-operations.jpg)

## The idea

- A folder with a `main.py` is a machine. `main.py` only wires its parts: `scene = reconstruct(corridor, settings)`.
- A file is a part with one job.
- One machine using another is a dashed call to its endpoint.

Full rules: [`RULES.md`](RULES.md). They borrow from [flow-based programming](https://jpaulm.github.io/fbp/), dependency injection and [ports and adapters](https://alistair.cockburn.us/hexagonal-architecture/).

## Before and after

| Before | After |
|---|---|
| ![](showcase/02-panoramic-first-wires-15-inputs.jpg) | ![](showcase/06-panoramic-after-2-in-2-out.jpg) |

## Install

Needs Node 20+.

```bash
git clone https://github.com/YellowO2/visual-code.git
cd visual-code && npm link
```

## Use

```bash
visual-code <project>          # live diagram at localhost:4400
visual-code check <project>    # rule breaks as path:line
visual-code rules              # print the rules
```

## With an AI agent

Install the [skill](skill/visual-code/SKILL.md) for Claude Code:

```bash
ln -s "$PWD/skill/visual-code" ~/.claude/skills/visual-code
```

Then ask: *"Use the visual-code skill to restructure this project."*

Python projects only, for now.

## Develop

```bash
npm install && npm run build
```

## License

MIT
