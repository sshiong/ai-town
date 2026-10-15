// Based on https://codepen.io/inlet/pen/yLVmPWv.
// Copyright (c) 2018 Patrick Brouwer, distributed under the MIT license.

import { PixiComponent } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { Application, type EventSystem } from 'pixi.js';
import { MutableRefObject, ReactNode } from 'react';
import { resizeViewport } from './viewportSizing';

export type ViewportProps = {
  app: Application;
  viewportRef?: MutableRefObject<Viewport | undefined>;

  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  children?: ReactNode;
};

// https://davidfig.github.io/pixi-viewport/jsdoc/Viewport.html
export default PixiComponent('Viewport', {
  create(props: ViewportProps) {
    const { app, children: _children, viewportRef, ...viewportProps } = props;
    const rendererEvents = app.renderer.events;
    // Stage can destroy its renderer before React finishes unmounting the viewport.
    // Retain the canvas that owns our wheel listener while keeping coordinate mapping live.
    const events = Object.create(rendererEvents) as EventSystem;
    events.domElement = rendererEvents.domElement;
    events.mapPositionToPoint = rendererEvents.mapPositionToPoint.bind(rendererEvents);
    const viewport = new Viewport({
      events,
      passiveWheel: false,
      ...Object.fromEntries(
        Object.entries(viewportProps).map(([key, value]) => [
          key,
          Number.isFinite(value) && value > 0 ? value : 1,
        ]),
      ),
    });
    if (viewportRef) {
      viewportRef.current = viewport;
    }
    // Activate plugins
    viewport.drag().pinch({}).wheel().decelerate().clamp({ direction: 'all', underflow: 'center' });
    resizeViewport(viewport, props);
    return viewport;
  },
  applyProps(viewport, oldProps: ViewportProps, newProps: ViewportProps) {
    if (
      oldProps.screenWidth !== newProps.screenWidth ||
      oldProps.screenHeight !== newProps.screenHeight ||
      oldProps.worldWidth !== newProps.worldWidth ||
      oldProps.worldHeight !== newProps.worldHeight
    ) {
      resizeViewport(viewport, newProps, oldProps);
    }
  },
});
