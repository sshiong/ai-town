import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Application, Point } from 'pixi.js';
import type { Viewport as ViewportType } from 'pixi-viewport';
import type { ViewportProps } from './PixiViewport';
import { resizeViewport } from './viewportSizing';

let create: (props: ViewportProps) => ViewportType;

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1, innerHeight: 1 },
  });
  const { Viewport } = createRequire(import.meta.url)(
    'pixi-viewport',
  ) as typeof import('pixi-viewport');
  const code = ts.transpileModule(
    readFileSync(new URL('./PixiViewport.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const module = { exports: {} as { default: { create: typeof create } } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === '@pixi/react')
        return { PixiComponent: (_name: string, factory: unknown) => factory };
      if (name === './viewportSizing') return { resizeViewport };
      if (name === 'pixi-viewport')
        return {
          // Exercise the installed viewport's real event lifecycle without a browser ticker.
          Viewport: class extends Viewport {
            constructor(options: ConstructorParameters<typeof Viewport>[0]) {
              super({ ...options, noTicker: true });
            }
          },
        };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  create = module.exports.default.create;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

test('viewport removes its original canvas listener after renderer teardown without changing shared events', () => {
  const canvas = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
  const events = {
    domElement: canvas as typeof canvas | null,
    resolution: 1,
    mapPositionToPoint: jest.fn(function (
      this: { resolution: number },
      point: Point,
      x: number,
      y: number,
    ) {
      point.x = x * this.resolution;
      point.y = y * this.resolution;
    }),
  };
  const originalMapper = events.mapPositionToPoint;
  const viewport = create({
    app: { renderer: { events } } as unknown as Application,
    screenWidth: 900,
    screenHeight: 400,
    worldWidth: 1440,
    worldHeight: 960,
  });
  expect(viewport.options.events).not.toBe(events);
  expect(events.domElement).toBe(canvas);
  expect(events.mapPositionToPoint).toBe(originalMapper);
  expect(canvas.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), {
    passive: false,
  });
  const registeredListener = canvas.addEventListener.mock.calls[0][1];

  // Mapping must use the original EventSystem's current state and receiver.
  events.resolution = 2;
  const point = viewport.input.getPointerPosition({ clientX: 3, clientY: 4 } as WheelEvent);
  expect(point).toMatchObject({ x: 6, y: 8 });
  expect(originalMapper.mock.contexts[0]).toBe(events);

  // Reproduce Stage destroying the renderer before its queued Pixi React unmount.
  events.domElement = null;
  expect(() => viewport.destroy({ children: true })).not.toThrow();
  expect(canvas.removeEventListener).toHaveBeenCalledWith('wheel', registeredListener);
  expect(events.domElement).toBeNull();
  expect(events.mapPositionToPoint).toBe(originalMapper);
});
