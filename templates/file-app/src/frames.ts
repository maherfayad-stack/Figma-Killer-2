import type { ComponentType } from 'react';
import Hero from './frames/Hero.js';
import Pricing from './frames/Pricing.js';

/**
 * Frame registry — every `.tsx` in `src/frames/` default-exports a
 * component and is a frame (playbook §4/P0 convention). This file is the
 * one place that has to be updated by hand today; the studio's "new frame"
 * tool (P1) writes both the `.tsx` file and its `.studio/canvas.json` entry.
 */
export const frames: Record<string, ComponentType> = {
  Hero,
  Pricing,
};

export function getFrame(name: string | null): ComponentType | null {
  if (!name) return null;
  return frames[name] ?? null;
}

export function listFrameNames(): string[] {
  return Object.keys(frames);
}
