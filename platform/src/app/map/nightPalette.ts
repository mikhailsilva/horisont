type StyleLayerLike = {
  id: string;
  type: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
};

export function nightPaintForLayer(layer: StyleLayerLike): Record<string, string | number> {
  const id = layer.id.toLowerCase();
  const sourceLayer = (layer['source-layer'] ?? '').toLowerCase();
  const name = `${id} ${sourceLayer}`;

  if (layer.type === 'background') return { 'background-color': '#0a0a0a' };
  if (layer.type === 'fill-extrusion') return { 'fill-extrusion-color': '#202622', 'fill-extrusion-opacity': 0.94 };
  if (layer.type === 'fill') {
    if (/water|ocean|river|lake/.test(name)) return { 'fill-color': '#10191d' };
    if (/building/.test(name)) return { 'fill-color': '#121212' };
    if (/landcover|landuse|land|park|wood|forest|grass/.test(name)) return { 'fill-color': '#0d100f' };
    return {};
  }
  if (layer.type === 'line') {
    if (/water|waterway|river/.test(name)) return { 'line-color': '#10191d' };
    if (/transportation|road|street|highway|bridge|tunnel/.test(name)) {
      const major = /motorway|trunk|primary/.test(name);
      return { 'line-color': major ? '#555b58' : '#343936' };
    }
    return {};
  }
  if (layer.type === 'symbol' && layer.layout?.['text-field'] !== undefined)
    return { 'text-color': '#a0a0a0', 'text-halo-color': '#0a0a0a', 'text-halo-width': 1.3 };
  return {};
}

export const NIGHT_MAP_TOKENS = {
  background: '#0a0a0a',
  card: '#121212',
  muted: '#1a1a1a',
  label: '#a0a0a0',
  accent: '#7c9082',
  water: '#10191d',
} as const;
