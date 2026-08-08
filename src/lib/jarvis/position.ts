import type { WidgetPosition } from "./types";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface WidgetSize {
  width: number;
  height: number;
}

export function defaultWidgetPosition(): WidgetPosition {
  return { x: 0.5, y: 0.9 };
}

export function clampWidgetPosition(
  position: WidgetPosition,
  viewport: ViewportSize,
  widget: WidgetSize,
  margin = 12,
): WidgetPosition {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return defaultWidgetPosition();
  }
  const halfWidth = Math.min(widget.width / 2, viewport.width / 2);
  const halfHeight = Math.min(widget.height / 2, viewport.height / 2);
  const minX = (halfWidth + margin) / viewport.width;
  const maxX = 1 - minX;
  const minY = (halfHeight + margin) / viewport.height;
  const maxY = 1 - minY;
  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  };
}

export function positionFromRect(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: ViewportSize,
): WidgetPosition {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return defaultWidgetPosition();
  }
  return {
    x: (rect.left + rect.width / 2) / viewport.width,
    y: (rect.top + rect.height / 2) / viewport.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
