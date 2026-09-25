import { describe, expect, it } from 'vitest';
import { buildingExtrusionLayer } from '../src/app/map/buildings';

describe('map 3D buildings', () => {
  const style = {
    sources: { openmaptiles: { type: 'vector' } },
    layers: [
      { id: 'background', type: 'background' },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building' },
      { id: 'road-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name' },
    ],
  };

  it('places extrusions above fills and roads, while keeping symbols above them', () => {
    expect(buildingExtrusionLayer(style, 'dark')).toMatchObject({
      beforeId: 'road-label',
      layer: { id: 'i-building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14 },
    });
    expect(buildingExtrusionLayer({ ...style, layers: style.layers.slice(0, 2) }, 'dark')?.beforeId).toBeUndefined();
    expect(buildingExtrusionLayer({ ...style, sources: { openmaptiles: { type: 'raster' } } }, 'dark')).toBeNull();
    expect(buildingExtrusionLayer({ ...style, layers: [style.layers[0]] }, 'dark')).toBeNull();
  });

  it('does not duplicate a style-provided building extrusion', () => {
    const existing = { ...style, layers: [...style.layers, { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building' }] };
    expect(buildingExtrusionLayer(existing, 'light')).toBeNull();
  });
});
