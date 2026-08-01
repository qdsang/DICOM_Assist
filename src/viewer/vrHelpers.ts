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
 *
 * Renders defensively: the volume viewport can outlive its rendering engine
 * (e.g. volume.load() completes after a layout switch tears the engine down),
 * and Cornerstone3D's getRendererContextPool() does NOT guard against a null
 * engine — so an unguarded vp.render() throws "Cannot read properties of
 * undefined (reading 'getRenderer')" and crashes the app. We check the engine
 * is still alive before touching the viewport.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyVrToViewport(vp: any, preset: string, blend: VrBlend) {
  const engine = vp?.getRenderingEngine?.();
  if (!engine || engine.hasBeenDestroyed) return;
  try {
    vp.setProperties?.({ preset });
  } catch { /* preset may not exist for some modalities — ignore */ }
  try {
    vp.setBlendMode?.(VR_BLEND_MAP[blend]);
  } catch { /* some viewports don't support blend mode */ }
  try {
    vp.render?.();
  } catch { /* engine/viewport may have been torn down mid-call */ }
}
