---
name: visual-code
description: Restructure a Python codebase so its folders and files read as a block diagram of the system, using the visual-code rules and checker. Use when asked to clean up or restructure a project with visual-code, or after changing code in a project that already follows these rules.
---

# visual-code

A project is a machine. Folders are machines, files are parts, and each
machine's `main.py` only wires its parts together. The visual-code tool draws
the machine from the code and checks the code against the rules.

## Tools

- Rules: `/Users/huangyuxuan/projects/visual_code/RULES.md`. Read them first.
- Check: `visual-code check <project>` prints each rule break as
  `path:line  message` and exits 0 when there are none.
- Diagram: `visual-code <project>` serves it at http://localhost:4400 (pick
  another with `--port`). Show it to the user after a change: they judge the
  structure by looking at it.
- If `visual-code` is not found (it is linked into one Node version), use
  `node /Users/huangyuxuan/projects/visual_code/src/cli.js` in its place.

## Workflow

1. Read the rules, then the project. Work out its pipeline: what goes in,
   what comes out, and which parts it passes through on the way.
2. Before changing anything, record how the code behaves: run its tests, or
   write a small script that runs the parts you will touch on real inputs and
   saves the outputs. You will compare against this at the end.
3. Run the check. Fix warnings a small step at a time, re-running the check
   after each step.
4. The check counts; it cannot judge. Also look for these, which it misses:
   - Data passed between parts through the disk (one part writes a file, the
     next reads it back). Pass it in memory; read and write files only at the
     edges, in a loader and a saver. A library's main function may leave
     loading and saving to its caller; the loader and saver are still parts.
     Watch for one hidden inside a cache: a part keeps a file for itself, and
     a later step goes looking for it (by name pattern or newest date). In the
     diagram it shows as a model or part wired past the step that made the
     data; pass the data along instead, and drop any "make it again" fallback.
   - Values that always travel together, the same data passed twice, or data,
     settings and verdicts mixed together (rule 14), in inputs and outputs alike.
   - A part with two jobs: split it. Code nothing calls: delete it.
   - A class that holds nothing between calls: make it a function.
   - A dict whose keys are always the same is a type: give it a dataclass
     with a name saying what it is, and name the wires carrying it after it.
5. Compare behaviour against step 2. Anything that changed must be a change
   you meant, and you must say what it is and why. Moving a disk handoff into
   memory removes the rounding the file format did, which can shift results
   through thresholds; put that rounding back in your comparison to show it
   is the only cause.
6. Report: what you changed and why, the check's final output, how you
   verified behaviour, and every caller outside the project that now needs
   updating.

## Shapes the rules lead to

- **A button only triggers.** A control in a user interface is a switch: it
  wires its event to a check, then its job. The check holds the decisions (is
  the input complete? a click or a drag?) and stops quietly when there is
  nothing to do; the job is a machine whose `main.py` is a straight line of
  steps. In Gradio: `event(check).success(job).failure(failed)`.
- **A part handed in keeps its name.** When one part is handed to another
  (`ui(build=streetview_to_3d)`), call it by that name all the way to where it
  runs, so the tool can tell which part it is.
- **Two faces.** A package is used by others only through what its
  `__init__.py` offers. A user interface calling an engine calls its
  endpoints; it does not reach into its helpers or types. When the check
  flags it, decide with the user whether the thing belongs in the engine's
  face or in a small shared package.
- **One place to start.** The project's top `main.py` both wires the system and,
  in its `if __name__ == "__main__":` block, starts it. Each machine that can
  run on its own does the same; developer scripts go in `scripts/`.

## Conventions the rules leave open

- A part's name matches its file exactly; the case is the project's choice
  (`backproject.py` with `def backproject`, or `Saver.py` with `def Saver`).
  Keep one style across the project.
- Helpers several parts use inside themselves go in a `tools/` folder, as one
  file per family of related functions (`tools/geo.py`). They are not wired.
- Types that are not steps (`Settings`, `View`, `PointCloud`) are one-class
  files beside the `main.py` that uses them. The diagram shows them apart.
- A model or connection passed in rather than built: declare it with its
  type (`da3: DA3Model`) so the diagram knows which part it is.
- An opening line may be a one-line docstring: `"""Does one thing."""`.
- A name fixed from outside (imported by another project, or turned into an
  API by a framework, like Gradio endpoints named after handlers) keeps its
  name even where a rule says otherwise. Say so in the report.
- Logging and timing in a `main.py` go through a part (a `Stopwatch`, a `log`
  passed in) rather than direct calls.
- A big subsystem you cannot verify yet: change only how it receives and
  returns data, leave its insides, and list it as unfinished.

## Cautions

- On macOS, file names ignore capitals: `ground.py` and `Ground.py` are the
  same file. Rename with `git mv`, never by copying and deleting, and never
  create a file whose name differs from an existing one only in case.
- Change only the project you were given. List outside callers; do not edit them.
