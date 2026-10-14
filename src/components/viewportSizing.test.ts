import type { EventSystem } from 'pixi.js';
import { createRequire } from 'node:module';
import { fitScale, resizeViewport, ViewportSize } from './viewportSizing';

const world = { worldWidth: 1440, worldHeight: 960 };
const landscape = { ...world, screenWidth: 900, screenHeight: 400 };
let Viewport: typeof import('pixi-viewport').Viewport;

beforeAll(() => {
  // pixi-viewport reads window dimensions when its module initializes.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1, innerHeight: 1 },
  });
  // Load the installed CJS entry directly; Jest exposes it as a default ESM export.
  const viewportModule = createRequire(import.meta.url)(
    'pixi-viewport',
  ) as typeof import('pixi-viewport');
  Viewport = viewportModule.Viewport;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

function createViewport(size: ViewportSize = landscape) {
  const viewport = new Viewport({
    ...size,
    noTicker: true,
    events: {
      domElement: { addEventListener() {}, removeEventListener() {} },
    } as unknown as EventSystem,
  });
  viewport.drag().pinch().wheel().decelerate().clamp({ direction: 'all', underflow: 'center' });
  return viewport;
}

describe('map viewport sizing', () => {
  it.each([
    landscape,
    { ...world, screenWidth: 360, screenHeight: 640 },
    { ...world, screenWidth: 700, screenHeight: 700 },
  ])('fits and centers the complete map in %j', (size) => {
    const viewport = createViewport(size);
    resizeViewport(viewport, size);
    expect(viewport.scale.x).toBe(fitScale(size));
    expect(viewport.scale.y).toBe(viewport.scale.x);
    expect(viewport.left).toBeLessThanOrEqual(0);
    expect(viewport.top).toBeLessThanOrEqual(0);
    expect(viewport.right).toBeGreaterThanOrEqual(size.worldWidth);
    expect(viewport.bottom).toBeGreaterThanOrEqual(size.worldHeight);
    expect(viewport.center.x).toBeCloseTo(size.worldWidth / 2);
    expect(viewport.center.y).toBeCloseTo(size.worldHeight / 2);
    viewport.destroy();
  });

  it('refits the overview on resize and updates wheel zoom limits', () => {
    const viewport = createViewport();
    resizeViewport(viewport, landscape);
    const portrait = { ...world, screenWidth: 320, screenHeight: 640 };
    resizeViewport(viewport, portrait, landscape);
    expect(viewport.screenWidth).toBe(320);
    expect(viewport.screenHeight).toBe(640);
    expect(viewport.scale.x).toBe(fitScale(portrait));
    viewport.setZoom(0.01);
    expect(viewport.scale.x).toBe(fitScale(portrait));
    viewport.setZoom(100);
    expect(viewport.scale.x).toBe(3);
    for (const name of ['drag', 'pinch', 'wheel', 'decelerate', 'clamp']) {
      expect(viewport.plugins.get(name)).toBeDefined();
    }
    viewport.destroy();
  });

  it('keeps avatar or manual zoom and its center on resize', () => {
    const viewport = createViewport();
    resizeViewport(viewport, landscape);
    viewport.animate({ position: { x: 600, y: 450 }, scale: 1.5, time: 100 });
    viewport.update(100);
    resizeViewport(viewport, { ...world, screenWidth: 800, screenHeight: 500 }, landscape);
    expect(viewport.scale.x).toBe(1.5);
    expect(viewport.center.x).toBeCloseTo(600);
    expect(viewport.center.y).toBeCloseTo(450);
    viewport.destroy();
  });

  it('ignores unmeasured or invalid dimensions until a valid first fit', () => {
    const viewport = createViewport({ ...world, screenWidth: 1, screenHeight: 1 });
    const unmeasured = { ...world, screenWidth: 0, screenHeight: 0 };
    for (const value of [0, -1, NaN, Infinity]) {
      const size = { ...landscape, screenWidth: value };
      expect(fitScale(size)).toBeUndefined();
      resizeViewport(viewport, size);
      expect(viewport.scale.x).toBe(1);
      expect(viewport.screenWidth).toBe(1);
    }
    resizeViewport(viewport, landscape, unmeasured);
    expect(viewport.scale.x).toBe(fitScale(landscape));
    viewport.destroy();
  });
});
