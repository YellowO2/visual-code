// Which part, and which of its functions, each part handed into a machine
// really is, followed up through the main files: a job is handed to a switch,
// the switch is given the part by a name, and that name came in through its
// machine's wall from further up. The diagram calls it; the checks flag one
// nobody can trace.
export function handedParts(machines) {
  const parentOf = (path) => machines.filter((m) => path !== m.path && (m.path === '.' || path.startsWith(m.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const arrivedAt = (machine, name) => {
    const parent = parentOf(machine.path)
    if (!parent) return undefined
    const wire = parent.wires.find((w) => w.to === machine.path && w.names.includes(name))
    if (!wire) return undefined
    if (wire.kind === 'uses') return handedBy(wire, name)
    return wire.from === `${parent.path}#in:${name}` ? arrivedAt(parent, name) : undefined
  }
  // The part a 'uses' wire hands over under a name, and which of its functions that is.
  const handedBy = (wire, name) => ({ part: wire.from, endpoint: wire.handed?.[name] ?? name })
  const found = new Map()
  for (const job of machines) {
    for (const end of ends(job)) {
      if (!end.startsWith(`${job.path}#use:`)) continue
      const name = end.split(':').pop()
      const parent = parentOf(job.path)
      const switchWire = parent?.wires.find((w) => w.kind === 'uses' && w.from === job.path)
      const given = switchWire && parent.wires.find((w) => w.to === switchWire.to && w.names.includes(name))
      const handed = !given ? undefined : given.kind === 'uses' ? handedBy(given, name)
        : given.from === `${parent.path}#in:${name}` ? arrivedAt(parent, name) : undefined
      if (handed) found.set(end, handed)
    }
  }
  return found
}

// Every end a machine's wires touch.
function ends(machine) {
  return new Set(machine.wires.flatMap(({ from, to }) => [from, to]))
}
