# Rules

1. A project is a machine made of parts. A part is a file or a folder, named after what it is.
2. A folder with a `main.py` is a machine. Its `main.py` uses the folder's other parts and does no work itself.
3. A folder without a `main.py` is a shelf: it has no walls, and its parts belong to the machine above.
4. The project's own `main.py` is the whole system, and where it starts: its `if __name__ == "__main__":` block sets up the program (logging, a server) and runs it. That block is not wiring.
5. A part has one job. Its file offers one function or class for it, named after the file; a folder's `main.py` names it after the folder. Helpers start with `_`.
6. A part is a function, unless it holds something across calls (a loaded model, a connection, a cache); then it is a class.
7. A wire is a named value passed from one part to another.
8. Wires never cross walls. The parameters of a `main.py` function are its machine's input ports, and what it returns are its output ports. A wire from outside stops at the port of the same name.
9. Every part's file opens with one short sentence saying what it does. A part's box shows it on hover; a machine shows it under its name. Machines inside machines start closed, and open to show what is inside.
10. Anything `main.py` does not use is not a part, and is shown apart.
11. The diagram comes only from folders, files and `main.py` files, updates live, and never changes code.
12. Mess shows: loose logic in a `main.py` is not drawn, and unconnected parts float.
13. Clicking a box copies its path.
14. A part takes and gives few values. Values that always travel together are one value, a named type rather than a dict (settings in one `settings`, points with their colours); the same data is not passed twice; data, settings and verdicts are not mixed.
15. Wires are named in full words saying what the value is (`corridor`, `settings`), never abbreviations (`prep`, `cfg`).
16. Only loaders and savers touch the disk, at the start and end of the line; a part may also keep a private cache. A file or folder location is never a wire between parts. Loaders and savers are drawn dashed.
17. Logging, timing and caches are not wires. Each part logs through Python's `logging`, configured once where the program starts.
18. A file lives in the closest folder holding everything that uses it. Shelves in between are fine. A type on a machine's ports (declared in its `main.py` signature, like `settings: Settings`) belongs to that machine, and anyone calling the machine may use it; hovering a port shows its type. A file nothing uses, and that is not run on its own, is deleted. Hovering a file lights up the files that use it.
19. Shared helpers that parts use inside themselves (coordinate conversions, a file format) live in a `tools/` folder. A tool is shared: one used by a single file belongs with it. A tool file may offer a family of related functions; it still says what it is. Tools are not wires: they show in a toolbox strip, and hovering one lights up its users.
20. Parts don't run parts. Only a `main.py` runs parts, whether it imports them or is handed them; a part that needs to run others, imported or handed to it, is a machine: give it a folder with a `main.py`. A button only triggers its job; the job is a machine. Other functions passed around as values are not parts.
21. A machine has two faces. Inside is how it is made: its parts, joined by wires, which never cross walls and enter and leave by ports. Outside is what it offers: its endpoints, the names its `__init__.py` offers (and its `main.py`'s function). Others reach it only by calling an endpoint: a call runs from the caller to the endpoint on the machine's wall, dashed. Handing a part to another is how the other gets hold of it, so what shows is the call it makes, not the hand-over. Pipelines pass values; services answer calls. Ports and endpoints show whether a machine is open or closed, so opening one only shows what is inside.

## Checks

`visual-code check <project>` prints every place a project breaks these rules, with file and line, and exits non-zero if there are any. The page lists the same warnings. Tests (`tests/` folders, `test_*` files), scripts (`scripts/`, for developers) and private folders (`_vendor/`) are left out, and a machine's parts are only the files in its `main` file's language.

- A project with no `main.py` anywhere.
- A `main.py` line that calls something other than its parts: work instead of wiring.
- A function taking more than 5 inputs, or returning more than 3 values: see rule 14.
- A `main.py` input or output named with an abbreviation (`cfg`, `prep`, `res`, `tmp`, ...) or fewer than 3 letters: see rule 15.
- A wire between two parts named like a location (`path`, `dir`, `folder`, `file`): see rule 16.
- A `main.py` input such as `log` or `verbose`: see rule 17.
- A tool used by only one file: a tool is shared (rule 19).
- A part that imports another part (not a tool or a type), or runs a part handed to it (followed through the `main.py` files from where it is handed over): see rule 20.
- Code that uses another package past its endpoints, anything its `__init__.py` does not offer: see rule 21. The project's own top files, which put the packages together, may reach anywhere.
- A file inside a machine that is not a part (no wire reaches it), a tool or a type. What a package's top `__init__.py` offers is its public face, for callers, and is fine.
- A file living away from the files that use it, or that nothing uses: see rule 18. Tests and scripts outside the package do not count as users.
- A `main.py` with more than one function: it has one main function.
- A part offering more than one public function or class, or one not named after its file (or folder, for `main.py`).
- A folder holding a single file: a part with nothing inside is a file.
- A folder whose file is named after it: that file should be `main.py`.
- A file named `utils`, `helpers`, `misc` and the like: name it after what it is.
- A part whose opening line is missing, longer than one short sentence (72 characters), or starts with its own name.
