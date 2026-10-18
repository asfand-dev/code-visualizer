import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Core, ElementDefinition, EventObject, LayoutOptions, NodeSingular } from 'cytoscape';
import { Download, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useStore } from '../state/store';
import { downloadUrl } from '../lib/download';
import { baseStyle, ensureCytoscape, fitTo, themeColors } from './cy';

/** Generic interactive node-link canvas used by the component, call-flow and layer views. */
export function CyCanvas({
  elements,
  layout,
  onTap,
  onDblTap,
  highlight,
  tooltip,
  children,
  exportName = 'diagram',
  curve = 'bezier',
}: {
  elements: ElementDefinition[];
  layout: LayoutOptions;
  onTap?: (id: string) => void;
  onDblTap?: (id: string) => void;
  highlight?: string | null;
  tooltip?: (id: string) => ReactNode;
  children?: ReactNode;
  exportName?: string;
  curve?: 'bezier' | 'straight' | 'taxi';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const theme = useStore((s) => s.theme);
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);
  const handlers = useRef({ onTap, onDblTap });
  handlers.current = { onTap, onDblTap };

  useEffect(() => {
    const cytoscape = ensureCytoscape();
    const cy = cytoscape({
      container: ref.current,
      style: baseStyle(themeColors(), { curve }),
      minZoom: 0.05,
      maxZoom: 3.5,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', (e: EventObject) => handlers.current.onTap?.((e.target as NodeSingular).id()));
    cy.on('dbltap', 'node', (e: EventObject) => handlers.current.onDblTap?.((e.target as NodeSingular).id()));
    cy.on('mouseover', 'node', (e: EventObject) => {
      const n = e.target as NodeSingular;
      const p = n.renderedPosition();
      setHover({ x: p.x, y: p.y, id: n.id() });
    });
    cy.on('mouseout', 'node', () => setHover(null));
    cy.on('viewport', () => setHover(null));
    const ro = new ResizeObserver(() => cy.resize());
    if (ref.current) ro.observe(ref.current);
    cyRef.current = cy;
    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [curve]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (!elements.length) return;
    const l = cy.layout({ ...layout, fit: true, padding: 40 } as LayoutOptions);
    l.one('layoutstop', () => fitTo(cy));
    l.run();
  }, [elements, layout]);

  useEffect(() => {
    cyRef.current?.style(baseStyle(themeColors(), { curve }));
  }, [theme, curve]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('faded focus out in');
      if (!highlight) return;
      const node = cy.getElementById(highlight);
      if (node.empty()) return;
      const hood = node.closedNeighborhood();
      cy.elements().not(hood).addClass('faded');
      node.addClass('focus');
      node.outgoers('edge').addClass('out');
      node.incomers('edge').addClass('in');
    });
  }, [highlight, elements]);

  const zoom = (f: number): void => {
    const cy = cyRef.current;
    if (cy) cy.animate({ zoom: { level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 200 });
  };

  return (
    <div className="canvas-wrap">
      <div ref={ref} className="canvas" />
      {children}
      <div className="floating zoom-controls">
        <button className="btn ghost icon sm" onClick={() => zoom(1.3)} aria-label="Zoom in">
          <ZoomIn size={15} />
        </button>
        <button className="btn ghost icon sm" onClick={() => zoom(1 / 1.3)} aria-label="Zoom out">
          <ZoomOut size={15} />
        </button>
        <button className="btn ghost icon sm" onClick={() => cyRef.current && fitTo(cyRef.current)} aria-label="Fit">
          <Maximize2 size={15} />
        </button>
        <button
          className="btn ghost icon sm"
          aria-label="Download PNG"
          title="Download PNG"
          onClick={() => {
            const cy = cyRef.current;
            if (cy) downloadUrl(`${exportName}.png`, cy.png({ full: true, scale: 2, bg: themeColors().bg }));
          }}
        >
          <Download size={15} />
        </button>
      </div>
      {hover && tooltip && (
        <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {tooltip(hover.id)}
        </div>
      )}
    </div>
  );
}

export function cardSize(label: string, sub?: string): { w: number; size: number; tw: string } {
  const longest = Math.max(label.length * 7.4, (sub?.length ?? 0) * 6.2);
  const w = Math.max(90, Math.min(260, longest + 28));
  return { w, size: sub ? 44 : 32, tw: `${w - 16}px` };
}
