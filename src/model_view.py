"""Reads a PyTorch model as blocks for visual-code's model view, as JSON.

  python model_view.py <project root> <file>

The file offers `_example()`, returning (model, inputs): a built model and a
tuple of example inputs, at the sizes the model really runs at. The model runs
once on them with fake tensors, which carry shapes and no numbers, so a real
size costs nothing; each block records when
it was first used and what went in and came out, by name. Repeated blocks fold into one
with a count, a repeating pattern of blocks into one pass marked with how
many times it repeats, plain layers get their sizes, dropout and activations are left
out, and each block carries the comment written next to it in the code.
"""
import importlib
import inspect
import json
import os
import re
import sys

import torch
import torch.nn as nn
from torch._subclasses.fake_tensor import FakeTensorMode

SKIP = (nn.Dropout, nn.GELU, nn.ReLU, nn.SiLU, nn.Tanh, nn.Sigmoid, nn.Identity, nn.Upsample)
MAIN = ('TransformerBlock', 'TransformerEncoderLayer', 'TransformerDecoderLayer', 'Block', 'GRU', 'LSTM', 'RNN')


def load(root, path):
    """The file as a module, imported inside its package so relative imports work."""
    full = os.path.abspath(os.path.join(root, path))
    parts = [os.path.splitext(os.path.basename(full))[0]]
    folder = os.path.dirname(full)
    while os.path.exists(os.path.join(folder, '__init__.py')):
        parts.insert(0, os.path.basename(folder))
        folder = os.path.dirname(folder)
    # Inside a package, only the folder above it, so the package's own file
    # names do not shadow other modules of the same name.
    for p in ([folder] if len(parts) > 1 else [os.path.dirname(full), os.path.abspath(root)]):
        if p not in sys.path:
            sys.path.insert(0, p)
    return importlib.import_module('.'.join(parts))


def layer(m):
    """One line for a plain layer, or None."""
    if isinstance(m, nn.Linear):
        return f'{m.in_features}→{m.out_features}'
    if isinstance(m, (nn.Conv1d, nn.Conv2d)):
        k = m.kernel_size[0]
        s = f', stride {m.stride[0]}' if m.stride[0] > 1 else ''
        return f'{m.in_channels}→{m.out_channels}, width {k}{s}'
    if isinstance(m, nn.Embedding):
        return f'{m.num_embeddings} × {m.embedding_dim}'
    if isinstance(m, (nn.GRU, nn.LSTM, nn.RNN)):
        return f'{m.input_size}→{m.hidden_size}' + (f', {m.num_layers} layers' if m.num_layers > 1 else '')
    if isinstance(m, nn.LayerNorm):
        return f'{m.normalized_shape[0]}'
    if isinstance(m, nn.MultiheadAttention):
        return f'{m.embed_dim}, {m.num_heads} heads'
    return None


def params(m):
    return sum(p.numel() for p in m.parameters())


def shapes(x):
    if torch.is_tensor(x):
        return [list(x.shape[1:]) if x.dim() > 1 and x.shape[0] == 1 else list(x.shape)]
    if isinstance(x, (tuple, list)):
        return [s for v in x for s in shapes(v)]
    return []


def record(model, inputs):
    """Runs the model once; each module's first use: order, inputs and outputs."""
    seen, hooks = {}, []
    for mod in model.modules():
        def hook(mod, args, kwargs, out):
            if mod not in seen:
                seen[mod] = (len(seen), named(mod, args, kwargs), returned(mod, out))
        hooks.append(mod.register_forward_hook(hook, with_kwargs=True))
    with torch.no_grad():
        model(*inputs)
    for h in hooks:
        h.remove()
    return seen


def named(mod, args, kwargs):
    """The tensors a module was called with, each with its argument's name and
    what the forward's docstring says it is."""
    try:
        bound = inspect.signature(mod.forward).bind(*args, **kwargs).arguments
    except (TypeError, ValueError):
        bound = {f'input {i + 1}': a for i, a in enumerate(args)}
    return [{'name': n, 'shape': s, 'about': described(mod, n)}
            for n, v in bound.items() for s in shapes(v)]


def returned(mod, out):
    return [{'name': 'out', 'shape': s, 'about': described(mod, 'returns')} for s in shapes(out)]


def described(mod, name):
    """The rest of the forward docstring's line that starts with this name, past its shape."""
    lines = (inspect.getdoc(type(mod).forward) or '').splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf'(\s*){re.escape(name)}:?\s+(\([^)]*\))?\s*(.*)', line)
        if m:
            # A one-line docstring listing several inputs describes none of them.
            if m.group(3).startswith((',', '->')):
                return ''
            # Lines indented past the name carry on its description.
            more = []
            for nxt in lines[i + 1:]:
                if len(nxt) - len(nxt.lstrip()) <= len(m.group(1)) + len(name) or not nxt.strip():
                    break
                more.append(nxt.strip())
            return ' '.join([m.group(3).strip(), *more]).strip()
    return ''


def comment(owner, attr, child):
    """The comment next to `self.<attr> =` in the owner's code, else the child class's first docstring line."""
    for cls in type(owner).__mro__:
        try:
            lines = inspect.getsource(cls).splitlines()
        except (OSError, TypeError):
            continue
        for i, line in enumerate(lines):
            if re.search(rf'self\.{re.escape(attr)}\s*=', line):
                if '#' in line:
                    return line.split('#', 1)[1].strip()
                above, j = [], i - 1
                while j >= 0 and lines[j].strip().startswith('#'):
                    above.insert(0, lines[j].strip()[1:].strip())
                    j -= 1
                if above:
                    return ' '.join(above)
    # The block class's own docstring, not one it inherits.
    own = type(child).__dict__.get('__doc__') if child is not None else None
    if own and not type(child).__module__.startswith('torch'):
        return inspect.cleandoc(own).splitlines()[0]
    return ''


def children(m):
    """Named children, list and sequence wrappers opened up."""
    out = []
    for n, c in m.named_children():
        if isinstance(c, SKIP):
            continue
        if isinstance(c, (nn.ModuleList, nn.Sequential)):
            out += [(f'{n}.{k}', g) for k, g in children(c)]
        else:
            out.append((n, c))
    return out


def inside(m):
    counts = {}
    for c in m.modules():
        if c is not m and layer(c) is not None:
            counts[type(c).__name__] = counts.get(type(c).__name__, 0) + 1
    return ', '.join(f'{v} × {k}' if v > 1 else k for k, v in counts.items())


def signature(m):
    return type(m).__name__, tuple(sorted((n, tuple(p.shape)) for n, p in m.named_parameters()))


def blocks(model, seen):
    """The model's top-level blocks in order of use, runs of identical ones folded."""
    kids = sorted(children(model), key=lambda kc: seen.get(kc[1], (1e9,))[0])
    out, i = [], 0
    while i < len(kids):
        n, c = kids[i]
        j = i + 1
        same = (lambda d: type(d) is type(c) and layer(d) is not None) if layer(c) is not None else (lambda d: signature(d) == signature(c))
        while j < len(kids) and same(kids[j][1]):
            j += 1
        group = [g for _, g in kids[i:j]]
        names = [k for k, _ in kids[i:j]]
        used = [g for g in group if g in seen or any(x in seen for x in g.modules())]
        first = seen.get(c)
        lines = sorted({layer(g) for g in group if layer(g)}) or [inside(c)]
        out.append({
            'kind': type(c).__name__, 'count': j - i, 'names': names,
            'line': '; '.join(l for l in lines if l), 'params': sum(params(g) for g in group),
            'io': {'in': first[1], 'out': first[2]} if first else None,  # of the first, for a folded run
            'note': comment(model, names[0].split('.')[0], c), 'used': bool(used),
        })
        i = j
    return cycles(out)


def cycles(out):
    """A pattern of blocks repeated back to back, folded into its first pass;
    each block in it is marked with the times and which pattern it is in."""
    key = lambda b: (b['kind'], b['count'], b['params'], b['line'], b['used'])
    folded, i = [], 0
    while i < len(out):
        best = (1, 1)
        for p in range(2, (len(out) - i) // 2 + 1):
            k = 1
            while i + (k + 1) * p <= len(out) and all(key(out[i + k * p + q]) == key(out[i + q]) for q in range(p)):
                k += 1
            if k > 1 and k * p > best[0] * best[1]:
                best = (k, p)
        k, p = best
        for q in range(p):
            runs = [out[i + r * p + q] for r in range(k)]
            b = dict(runs[0], names=[n for r in runs for n in r['names']], params=sum(r['params'] for r in runs))
            folded.append(dict(b, times=k, cycle=i) if k > 1 else b)
        i += k * p
    return folded


def main(root, path):
    module = load(root, path)
    with FakeTensorMode(allow_non_fake_inputs=True):
        model, inputs = module._example()
        model.eval()
        seen = record(model, inputs)
    # A wrapper holding one model: show the model it holds.
    while len(children(model)) == 1 and layer(children(model)[0][1]) is None:
        model = children(model)[0][1]
    own = type(model).__dict__.get('__doc__')
    out = {'name': type(model).__name__, 'about': inspect.cleandoc(own).splitlines()[0] if own else '',
           'params': params(model), 'blocks': blocks(model, seen), 'main': list(MAIN)}
    print(json.dumps(out))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
