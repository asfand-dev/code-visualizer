import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import { cssVar } from '../lib/colors';

let registered = false;

export function ensureCytoscape(): typeof cytoscape {
  if (!registered) {
    cytoscape.use(fcose);
    cytoscape.use(dagre);
    registered = true;
  }
  return cytoscape;
}

export interface ThemeColors {
  bg: string;
  text: string;
  textDim: string;
  edge: string;
  border: string;
  accent: string;
  danger: string;
  warning: string;
  info: string;
  surface: string;
}

export function themeColors(): ThemeColors {
  return {
    bg: cssVar('--graph-bg') || '#0c0f15',
    text: cssVar('--text') || '#e7e9f0',
    textDim: cssVar('--text-dim') || '#8a93a8',
    edge: cssVar('--edge') || 'rgba(148,163,184,0.35)',
    border: cssVar('--border-strong') || '#2f3650',
    accent: cssVar('--accent') || '#8b6dff',
    danger: cssVar('--danger') || '#f87171',
    warning: cssVar('--warning') || '#fbbf24',
    info: cssVar('--info') || '#60a5fa',
    surface: cssVar('--surface') || '#10131a',
  };
}

/** Shared stylesheet for all node-link diagrams in the report. */
export function baseStyle(t: ThemeColors, opts: { labels?: boolean; curve?: 'bezier' | 'straight' | 'taxi' | 'unbundled-bezier'; fontSize?: number } = {}): StylesheetJson {
  const curve = opts.curve ?? 'bezier';
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        width: 'data(size)',
        height: 'data(size)',
        shape: 'data(shape)' as never,
        label: opts.labels === false ? '' : 'data(label)',
        'font-size': opts.fontSize ?? 11,
        'font-family': 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        'font-weight': 500,
        color: t.text,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 5,
        'text-outline-color': t.bg,
        'text-outline-width': 2.5,
        'text-outline-opacity': 0.92,
        'min-zoomed-font-size': 6,
        'border-width': 0,
        'border-color': t.accent,
        'overlay-opacity': 0,
        'transition-property': 'opacity, border-width',
        'transition-duration': 150,
      } as never,
    },
    {
      selector: 'node[type="folder"]',
      style: {
        shape: 'round-rectangle',
        'background-opacity': 0.16,
        'border-width': 2,
        'border-color': 'data(color)',
        'font-size': 13,
        'font-weight': 650,
        'text-valign': 'center',
        'text-margin-y': 0,
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        width: 'data(w)',
        height: 'data(size)',
      } as never,
    },
    {
      selector: 'node[type="package"]',
      style: {
        shape: 'round-rectangle',
        'background-opacity': 0.9,
        'font-size': 10,
        color: t.text,
      } as never,
    },
    {
      selector: 'node[type="card"]',
      style: {
        shape: 'round-rectangle',
        width: 'data(w)',
        height: 'data(size)',
        'background-color': t.surface,
        'background-opacity': 1,
        'border-width': 1.5,
        'border-color': 'data(color)',
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-margin-y': 0,
        'text-wrap': 'wrap',
        'text-max-width': 'data(tw)',
        'font-size': 11,
        'font-weight': 600,
        'text-outline-width': 0,
        color: t.text,
      } as never,
    },
    {
      selector: ':parent',
      style: {
        'background-color': t.text,
        'background-opacity': 0.035,
        'border-width': 1.2,
        'border-style': 'dashed',
        'border-color': t.border,
        shape: 'round-rectangle',
        padding: '16px',
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'font-size': 12,
        'font-weight': 650,
        color: t.textDim,
        'text-outline-width': 0,
        'min-zoomed-font-size': 4,
      } as never,
    },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'line-color': t.edge,
        'target-arrow-color': t.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.75,
        'curve-style': curve,
        'control-point-step-size': 30,
        'taxi-direction': 'rightward',
        'overlay-opacity': 0,
        'transition-property': 'opacity, line-color',
        'transition-duration': 150,
      } as never,
    },
    { selector: 'edge[label]', style: { label: 'data(label)', 'font-size': 9, color: t.textDim, 'text-background-color': t.bg, 'text-background-opacity': 0.9, 'text-background-padding': '2px', 'text-rotation': 'autorotate' } as never },
    { selector: 'edge[?dashed]', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] } as never },
    { selector: 'edge[?hollow]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-fill': 'hollow', 'arrow-scale': 1.2 } as never },
    { selector: 'edge[?cycle]', style: { 'line-color': t.danger, 'target-arrow-color': t.danger } as never },
    { selector: '.faded', style: { opacity: 0.08 } as never },
    { selector: 'edge.dim', style: { opacity: 0.15 } as never },
    { selector: 'node.focus', style: { 'border-width': 4, 'border-color': t.accent, 'border-opacity': 1, 'z-index': 20 } as never },
    { selector: 'node.match', style: { 'border-width': 3, 'border-color': t.warning, 'z-index': 15 } as never },
    { selector: 'edge.out', style: { 'line-color': '#60a5fa', 'target-arrow-color': '#60a5fa', opacity: 1, 'z-index': 10 } as never },
    { selector: 'edge.in', style: { 'line-color': '#fb923c', 'target-arrow-color': '#fb923c', opacity: 1, 'z-index': 10 } as never },
    { selector: 'edge.path', style: { 'line-color': t.accent, 'target-arrow-color': t.accent, width: 4, opacity: 1, 'z-index': 12 } as never },
    { selector: 'node.dep', style: { 'border-width': 3, 'border-color': '#60a5fa' } as never },
    { selector: 'node.dependent', style: { 'border-width': 3, 'border-color': '#fb923c' } as never },
    { selector: 'node.cycle', style: { 'border-width': 3, 'border-color': t.danger } as never },
    { selector: 'node.changed', style: { 'border-width': 4, 'border-color': '#fbbf24', 'border-opacity': 1, 'z-index': 25 } as never },
    { selector: 'node.affected', style: { 'border-width': 2.5, 'border-color': '#fb923c', 'border-style': 'dashed', 'border-opacity': 0.9 } as never },
  ];
}

export function fitTo(cy: Core, padding = 40): void {
  cy.fit(undefined, padding);
  if (cy.zoom() > 1.6) {
    cy.zoom(1.6);
    cy.center();
  }
}
