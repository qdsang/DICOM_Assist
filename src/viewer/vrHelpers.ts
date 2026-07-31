import { addTool } from '@cornerstonejs/tools';
import {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  LengthTool,
  CrosshairsTool,
  AngleTool,
  EllipticalROITool,
  PlanarRotateTool,
  OrientationMarkerTool,
  TrackballRotateTool,
  VolumeCroppingTool,
} from '@cornerstonejs/tools';
import { VR_BLEND_MAP, type VrBlend } from './constants';

let toolsRegistered = false;

/** Register all tools once. Idempotent. Includes 3D-only tools (rotate, crop). */
export function registerTools() {
  if (toolsRegistered) return;
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(StackScrollTool);
  addTool(LengthTool);
  addTool(CrosshairsTool);
  addTool(AngleTool);
  addTool(EllipticalROITool);
  addTool(PlanarRotateTool);
  addTool(OrientationMarkerTool);
  addTool(TrackballRotateTool);
  addTool(VolumeCroppingTool);
  toolsRegistered = true;
}

/**
 * Apply a transfer-function preset + blend mode to a 3D volume viewport.
 * MinIP is especially useful for low-density structures (cysts, fluid, air).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyVrToViewport(vp: any, preset: string, blend: VrBlend) {
  try {
    vp.setProperties?.({ preset });
  } catch { /* preset may not exist for some modalities — ignore */ }
  try {
    vp.setBlendMode?.(VR_BLEND_MAP[blend]);
  } catch { /* some viewports don't support blend mode */ }
  vp.render?.();
}
