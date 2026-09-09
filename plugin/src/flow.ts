// Pure prototype-flow walker, free of Figma globals.

export type FlowNode = {
  id: string;
  name: string;
  width: number;
  height: number;
  reactions: readonly { trigger: { type: string } | null; actions?: readonly any[]; action?: any }[];
  descendants: FlowNode[];
};

export type Transition = { from: string; to: string; via: string; trigger: string; navigation: string };
export type Flow = {
  screens: { id: string; name: string; width: number; height: number }[];
  transitions: Transition[];
};

/** Breadth-first walk from the starting points over NODE reactions, collecting reachable screens. */
export async function walkFlow(startIds: string[], getNode: (id: string) => Promise<FlowNode | null>): Promise<Flow> {
  const flow: Flow = { screens: [], transitions: [] };
  const seen = new Set<string>();
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = await getNode(id);
    if (!node) continue;
    flow.screens.push({ id: node.id, name: node.name, width: node.width, height: node.height });
    for (const n of [node, ...node.descendants]) {
      for (const r of n.reactions) {
        for (const a of r.actions ?? (r.action ? [r.action] : [])) {
          if (a?.type !== "NODE" || !a.destinationId) continue;
          flow.transitions.push({
            from: node.id,
            to: a.destinationId,
            via: n === node ? "(screen)" : n.name,
            trigger: r.trigger?.type ?? "UNKNOWN",
            navigation: a.navigation ?? "NAVIGATE",
          });
          queue.push(a.destinationId);
        }
      }
    }
  }
  return flow;
}
