type StyleLike = {
  sources?: Record<string, { type?: string }>;
  layers?: Array<{ id: string; type: string; source?: string; 'source-layer'?: string }>;
};

export function buildingExtrusionLayer(style: StyleLike, theme: 'light' | 'dark') {
  const layers = style.layers ?? [];
  if (layers.some((layer) => layer.type === 'fill-extrusion' && /^buildings?$/i.test(layer['source-layer'] ?? ''))) return null;

  const buildingLayers = layers.filter((layer) =>
    layer.type === 'fill' && /^buildings?$/i.test(layer['source-layer'] ?? '') &&
    layer.source && style.sources?.[layer.source]?.type === 'vector',
  );
  const building = buildingLayers.at(-1);
  if (!building?.source || !building['source-layer']) return null;

  const height = ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], 0]];
  const base = ['to-number', ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0]];
  const firstSymbol = layers.find((layer) => layer.type === 'symbol')?.id;
  return {
    layer: {
      id: 'i-building-3d',
      type: 'fill-extrusion',
      source: building.source,
      'source-layer': building['source-layer'],
      minzoom: 14,
      filter: ['>', height, 0],
      paint: {
        'fill-extrusion-color': theme === 'dark' ? '#202622' : '#cbd3db',
        'fill-extrusion-height': height,
        'fill-extrusion-base': base,
        'fill-extrusion-opacity': theme === 'dark' ? 0.92 : 0.86,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    beforeId: firstSymbol,
  };
}
