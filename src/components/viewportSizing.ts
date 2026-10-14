import type { Viewport } from 'pixi-viewport';

export type ViewportSize = {
  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
};

export function fitScale(size: ViewportSize): number | undefined {
  if (
    [size.screenWidth, size.screenHeight, size.worldWidth, size.worldHeight].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    return undefined;
  }
  return Math.min(size.screenWidth / size.worldWidth, size.screenHeight / size.worldHeight);
}

export function resizeViewport(viewport: Viewport, size: ViewportSize, previous?: ViewportSize) {
  const minimumScale = fitScale(size);
  // A ResizeObserver can report zero before layout or while the container is hidden.
  if (minimumScale === undefined) return;

  const previousScale = previous && fitScale(previous);
  const scale = viewport.scale.x;
  const center = viewport.center;
  const refit =
    previousScale === undefined ||
    Math.abs(scale - previousScale) <= previousScale * 0.000001 ||
    previous?.worldWidth !== size.worldWidth ||
    previous?.worldHeight !== size.worldHeight;

  viewport.resize(size.screenWidth, size.screenHeight, size.worldWidth, size.worldHeight);
  viewport.clampZoom({ minScale: minimumScale, maxScale: Math.max(3, minimumScale) });
  viewport.setZoom(refit ? minimumScale : scale);
  viewport.moveCenter(refit ? { x: size.worldWidth / 2, y: size.worldHeight / 2 } : center);
}
