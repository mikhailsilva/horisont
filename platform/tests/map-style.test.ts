import { describe, expect, it } from 'vitest';
import { styleFor } from '../src/app/map/mapStyle';

describe('initial and changed map style', () => {
  it('initializes a saved hybrid preference with the vector style required by its raster overlay', () => {
    expect(styleFor('hybrid', 'light')).toBe('https://tiles.openfreemap.org/styles/liberty');
  });

  it('applies the first theme change to the same saved hybrid base', () => {
    expect(styleFor('hybrid', 'dark')).toBe('https://tiles.openfreemap.org/styles/dark');
    expect(styleFor('hybrid', 'dark')).not.toBe(styleFor('hybrid', 'light'));
  });
});
