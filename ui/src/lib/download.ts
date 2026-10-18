export function downloadBlob(filename: string, content: BlobPart, type = 'text/plain'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  downloadUrl(filename, url);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadUrl(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export interface ExportGraph {
  nodes: { id: string; label: string; group?: string }[];
  edges: { source: string; target: string; label?: string; dashed?: boolean }[];
}

function mermaidId(id: string, index: Map<string, string>): string {
  let v = index.get(id);
  if (!v) {
    v = `n${index.size}`;
    index.set(id, v);
  }
  return v;
}

export function toMermaid(graph: ExportGraph, direction: 'LR' | 'TD' = 'LR'): string {
  const index = new Map<string, string>();
  const lines = [`flowchart ${direction}`];
  for (const n of graph.nodes) lines.push(`  ${mermaidId(n.id, index)}["${n.label.replace(/"/g, "'")}"]`);
  for (const e of graph.edges) {
    const arrow = e.dashed ? '-.->' : '-->';
    const label = e.label ? `|${e.label.replace(/\|/g, '/')}|` : '';
    lines.push(`  ${mermaidId(e.source, index)} ${arrow}${label} ${mermaidId(e.target, index)}`);
  }
  return lines.join('\n');
}

export function toDot(graph: ExportGraph, name = 'codebase'): string {
  const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
  const lines = [`digraph ${q(name)} {`, '  rankdir=LR;', '  node [shape=box, style="rounded,filled", fillcolor="#eef2ff", fontname="Helvetica"];'];
  for (const n of graph.nodes) lines.push(`  ${q(n.id)} [label=${q(n.label)}];`);
  for (const e of graph.edges) lines.push(`  ${q(e.source)} -> ${q(e.target)}${e.dashed ? ' [style=dashed]' : ''};`);
  lines.push('}');
  return lines.join('\n');
}
