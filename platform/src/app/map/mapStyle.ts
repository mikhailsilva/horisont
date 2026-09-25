import type { StyleSpecification } from 'maplibre-gl';

export type Base = 'scheme' | 'satellite' | 'hybrid' | 'topo';

const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = 'Снимки © Esri, Maxar, Earthstar Geographics';

function rasterStyle(tiles: string[], attribution: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

export function styleFor(base: Base, theme: 'light' | 'dark'): string | StyleSpecification {
  if (base === 'scheme' || base === 'hybrid')
    return theme === 'dark' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/liberty';
  if (base === 'satellite') return rasterStyle([ESRI_IMAGERY], ESRI_ATTR, 17);
  return rasterStyle(
    ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
    '© OpenTopoMap (CC-BY-SA), © участники OpenStreetMap',
    17,
  );
}
