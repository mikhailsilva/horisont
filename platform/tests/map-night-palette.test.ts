import { describe, expect, it } from 'vitest';
import { NIGHT_MAP_TOKENS, nightPaintForLayer } from '../src/app/map/nightPalette';

describe('Sage Garden night map palette', () => {
  it('uses black land, deep water, muted roads and readable labels', () => {
    expect(NIGHT_MAP_TOKENS).toMatchObject({ background: '#0a0a0a', card: '#121212', muted: '#1a1a1a', label: '#a0a0a0', accent: '#7c9082', water: '#10191d' });
    expect(nightPaintForLayer({ id: 'background', type: 'background' })['background-color']).toBe('#0a0a0a');
    expect(nightPaintForLayer({ id: 'water', type: 'fill', 'source-layer': 'water' })['fill-color']).toBe('#10191d');
    expect(nightPaintForLayer({ id: 'landcover-forest', type: 'fill', 'source-layer': 'landcover' })['fill-color']).toBe('#0d100f');
    expect(nightPaintForLayer({ id: 'transportation-primary', type: 'line', 'source-layer': 'transportation' })['line-color']).toBe('#555b58');
    expect(nightPaintForLayer({ id: 'place-label', type: 'symbol', layout: { 'text-field': '{name}' } })['text-color']).toBe('#a0a0a0');
  });

  it('leaves unrelated layers unchanged', () => {
    expect(nightPaintForLayer({ id: 'boundary-country', type: 'line', 'source-layer': 'boundary' })).toEqual({});
  });
});
