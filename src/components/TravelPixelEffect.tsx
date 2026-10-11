import { useCallback, useRef } from 'react';
import { Graphics, useTick } from '@pixi/react';
import type { Graphics as PixiGraphics } from 'pixi.js';
import type { TravelEffect } from './travelEffects';

export const TRAVEL_EFFECT_DURATION = 700;
export function TravelPixelEffect({ effect, tileDim, reducedMotion }: { effect: TravelEffect; tileDim: number; reducedMotion: boolean }) {
  const graphics = useRef<PixiGraphics | null>(null);
  const draw = useCallback((g: PixiGraphics) => {
    g.clear();
    const progress = Math.min(1, Math.max(0, (Date.now() - effect.startedAt) / TRAVEL_EFFECT_DURATION));
    if (progress >= 1) return;
    const frame = reducedMotion ? 0.5 : Math.floor(progress * 7) / 7;
    const color = effect.kind === 'arrival' ? 0xffe2a2 : 0xa7c4d2;
    const radius = reducedMotion ? 13 : effect.kind === 'arrival' ? 20 - frame * 8 : 12 + frame * 8;
    g.beginFill(color, reducedMotion ? 0.75 : 1 - frame * 0.7);
    // Square pixels and stepped frames match the original nearest-neighbor assets.
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -0.45], [0, 0.45]])
      g.drawRect(Math.round(dx * radius) - 2, Math.round(dy * radius) - 2, 4, 4);
    if (!reducedMotion) for (const sign of [-1, 1])
      g.drawRect(sign * Math.round(radius * 0.7) - 1, -Math.round(frame * 18) - 2, 2, 2);
    g.endFill();
  }, [effect, reducedMotion]);
  useTick(() => { if (graphics.current) draw(graphics.current); }, !reducedMotion);
  return <Graphics ref={graphics} x={effect.x * tileDim + tileDim / 2} y={effect.y * tileDim + tileDim / 2}
    eventMode="none" draw={draw} />;
}
