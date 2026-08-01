import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  eventTarget,
  utilities as csCoreUtilities,
} from '@cornerstonejs/core';
import {
  ToolGroupManager,
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
  Enums as csToolsEnums,
  utilities as csToolsUtilities,
} from '@cornerstonejs/tools';
import type { AnatomicalPlane } from '../dicom/orientationUtils';
import type { StudyMetadata } from '../dicom/types';
import EmptyViewportOverlay from './EmptyViewportOverlay';
import { extractViewportInfo } from './viewportUtils';
import type { ViewportInfo } from './viewportUtils';
import { SliceSlider } from './SliceSlider';
import { ViewportOverlay } from './overlays/ViewportOverlay';
import { VrOverlay } from './overlays/VrOverlay';
import { registerTools, applyVrToViewport } from './vrHelpers';
import { createCrosshair3D, setCrosshair3DPosition, type Crosshair3D } from './crosshair3D';
import { logger } from '../utils/logger';
import {
  RENDERING_ENGINE_ID,
  TOOL_GROUP_ID,
  TOOL_GROUP_ID_3D,
  STACK_VIEWPORT_ID,
  VOLUME_SINGLE_VP_ID,
  VOLUME_3D_VP_ID,
  MPR_VIEWPORT_IDS,
  GRID_VIEWPORT_IDS,
  VOLUME_ID,
  ORIENTATION_MAP,
  MARKER_TYPE_MAP,
  ALL_LEFT_CLICK_TOOLS,
  type ActiveToolName,
  type LayoutType,
  type OrientationMarkerType,
  type VrBlend,
} from './constants';

// Re-export shared types so existing imports from this module keep working.
export type { ActiveToolName, LayoutType, OrientationMarkerType };

// `setProperties` exists on StackViewport/VolumeViewport but not on the base
// IViewport returned by getViewports(). Narrow to the structural shape we use.
type ViewportWithProperties = {
  setProperties?(props: { invert?: boolean }): void;
};

/**
 * Set the 3D tool group's primary (left-click) binding:
 *  - crop on  → VolumeCroppingTool active (drag handles), rotate passive
 *  - crop off → TrackballRotateTool active (rotate), crop enabled (planes persist, handles hidden)
 * Zoom (right) + Pan (middle) always bound.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function set3DToolBindings(tg: any, crop: boolean) {
  const cropTool = tg.getToolInstance?.(VolumeCroppingTool.toolName);
  if (crop) {
    try { tg.setToolActive(VolumeCroppingTool.toolName, { bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }] }); } catch { /* */ }
    cropTool?.setHandlesVisible?.(true);
    try { tg.setToolPassive(TrackballRotateTool.toolName); } catch { /* */ }
  } else {
    try { tg.setToolEnabled(VolumeCroppingTool.toolName); } catch { /* crop planes not yet set */ }
    cropTool?.setHandlesVisible?.(false);
    try { tg.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }] }); } catch { /* */ }
  }
  // CRITICAL: VolumeCroppingTool.onSetToolActive forces showClippingPlanes=false,
  // which makes _updateClippingPlanes (called on every CAMERA_MODIFIED, e.g. rotate)
  // strip ALL clipping planes from the mapper — so the crop vanishes the moment the
  // user rotates. Re-enable clipping planes here so the crop persists across camera
  // changes and is actually applied to the volume (not just handle lines).
  if (cropTool) {
    try { cropTool.setClippingPlanesVisible?.(true); } catch { /* */ }
  }
  try { tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: csToolsEnums.MouseBindings.Secondary }] }); } catch { /* */ }
  try { tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: csToolsEnums.MouseBindings.Auxiliary }] }); } catch { /* */ }
}

/** Create (or reuse) the dedicated tool group for the 3D volume viewport. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function create3DToolGroup(renderingEngineId: string, crop: boolean): any {
  let tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID_3D);
  if (!tg) {
    tg = ToolGroupManager.createToolGroup(TOOL_GROUP_ID_3D);
    if (!tg) return null;
    tg.addTool(TrackballRotateTool.toolName);
    tg.addTool(VolumeCroppingTool.toolName);
    tg.addTool(PanTool.toolName);
    tg.addTool(ZoomTool.toolName);
    tg.addViewport(VOLUME_3D_VP_ID, renderingEngineId);
  }
  set3DToolBindings(tg, crop);
  return tg;
}

/** Small expand/restore button shown on each viewport cell (double-click also toggles). */
function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute bottom-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded bg-neutral-800/70 hover:bg-neutral-700 text-neutral-300 text-xs transition-colors"
      title={expanded ? t('viewport.restoreLayout') : t('viewport.expandLayout')}
    >
      {expanded ? '⤡' : '⤢'}
    </button>
  );
}

/**
 * The 3D crosshair marker is rendered as real vtk actors inside the 3D viewport
 * (see crosshair3D.ts) instead of a 2D SVG overlay — so it gets correctly
 * occluded by opaque tissue in front and reads as a true 3D intersection.
 */

interface ViewportGridProps {
  imageIds: string[];
  activeTool: ActiveToolName;
  layout: LayoutType;
  orientation: AnatomicalPlane;
  primaryAxis: AnatomicalPlane;
  orientationMarkerType?: OrientationMarkerType;
  onResetRef?: React.MutableRefObject<(() => void) | null>;
  invert?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  cineEnabled?: boolean;
  studyMetadata?: StudyMetadata | null;
}

export default function ViewportGrid({
  imageIds, activeTool, layout, orientation, primaryAxis,
  orientationMarkerType = 'cube', onResetRef,
  invert = false, flipH = false, flipV = false, cineEnabled = false,
  studyMetadata,
}: ViewportGridProps) {
  const { t } = useTranslation();
  const singleRef = useRef<HTMLDivElement>(null);
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const volume3DRef = useRef<HTMLDivElement>(null);
  const gridRef0 = useRef<HTMLDivElement>(null);
  const gridRef1 = useRef<HTMLDivElement>(null);
  const gridRef2 = useRef<HTMLDivElement>(null);
  const gridRef3 = useRef<HTMLDivElement>(null);
  const renderingEngineRef = useRef<RenderingEngine | null>(null);
  const eventCleanupsRef = useRef<(() => void)[]>([]);
  const markerTypeRef = useRef(orientationMarkerType);
  markerTypeRef.current = orientationMarkerType;

  // Refs for state read inside setup functions (after the 50ms setTimeout)
  const activeToolRef = useRef<ActiveToolName>(activeTool);
  activeToolRef.current = activeTool;
  const togglesRef = useRef({ invert: false, flipH: false, flipV: false, cine: false });
  togglesRef.current = { invert, flipH, flipV, cine: cineEnabled };

  const [singleInfo, setSingleInfo] = useState<ViewportInfo>({ current: 0, total: 0, ww: 0, wc: 0 });
  const [mprInfo, setMprInfo] = useState<Record<string, ViewportInfo>>({
    CT_AXIAL: { current: 0, total: 0, ww: 0, wc: 0 },
    CT_SAGITTAL: { current: 0, total: 0, ww: 0, wc: 0 },
    CT_CORONAL: { current: 0, total: 0, ww: 0, wc: 0 },
  });
  // Per-slot state for grid layouts: maps slot index (1,2,3) → seriesUID
  const [gridLoadedSlots, setGridLoadedSlots] = useState<Record<number, string>>({});
  const [gridInfo, setGridInfo] = useState<Record<number, ViewportInfo>>({});
  const [pickingSlot, setPickingSlot] = useState<number | null>(null);

  // Volume Rendering state (3D viewport in MPR layout)
  const [vrPreset, setVrPreset] = useState<string>('CT-Soft-Tissue');
  const [vrBlend, setVrBlend] = useState<VrBlend>('composite');
  const vrSettingsRef = useRef({ preset: vrPreset, blend: vrBlend });
  vrSettingsRef.current = { preset: vrPreset, blend: vrBlend };

  // Volume cropping (3D viewport): drag handles to cut away superficial tissue
  // (skin/bone) and reveal deep structures like cysts. Crop planes persist when
  // crop mode is toggled off (handles hidden, rotation re-enabled).
  const [crop3DEnabled, setCrop3DEnabled] = useState(false);
  const crop3DEnabledRef = useRef(false);
  crop3DEnabledRef.current = crop3DEnabled;

  // Expand-to-fullscreen: double-click a cell in MPR/grid to fill the area.
  const [expandedSlot, setExpandedSlot] = useState<number | null>(null);

  // 3D crosshair marker: rendered as real vtk actors (lines + sphere) INSIDE the
  // 3D viewport. Stored in refs because the actors are mutated imperatively from
  // inside event handlers (camera-modified callbacks) and we don't want React
  // re-renders on every slice scroll.
  const crosshair3DRef = useRef<Crosshair3D | null>(null);
  const volumeBoundsRef = useRef<number[] | null>(null);
  // update3DCrosshair is defined inside setupMprViewports (closure over viewport
  // elements). Expose it via ref so an activeTool change effect can re-trigger it
  // (e.g. when the user activates Crosshairs, no CAMERA_MODIFIED fires yet, so the
  // marker would otherwise stay absent until the first slice drag).
  const updateCrosshairRef = useRef<(() => void) | null>(null);

  // Create rendering engine once on mount — avoids WebGL context leaks
  useEffect(() => {
    registerTools();
    renderingEngineRef.current = new RenderingEngine(RENDERING_ENGINE_ID);
    return () => {
      teardownViewports();
      renderingEngineRef.current?.destroy();
      renderingEngineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set up viewports when layout/data changes (reuses the single engine)
  useEffect(() => {
    if (!renderingEngineRef.current || imageIds.length === 0) return;

    // Clear secondary grid slots when layout or primary series changes
    setGridLoadedSlots({});
    setGridInfo({});
    setPickingSlot(null);

    const timer = setTimeout(() => {
      setupViewports();
    }, 50);

    return () => {
      clearTimeout(timer);
      teardownViewports();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, imageIds, orientation, primaryAxis]);

  // Expose reset function
  useEffect(() => {
    if (!onResetRef) return;
    onResetRef.current = () => {
      const engine = renderingEngineRef.current;
      if (!engine) return;
      // Stop cine on all viewports
      for (const vp of engine.getViewports()) {
        try { csToolsUtilities.cine.stopClip((vp as any).element); } catch { /* ok */ }
      }
      for (const vp of engine.getViewports()) {
        vp.resetCamera();
        (vp as any).resetProperties?.();
        vp.render();
      }
      // resetProperties wipes the VR transfer function — re-apply current preset/blend.
      const vp3D = engine.getViewport(VOLUME_3D_VP_ID);
      if (vp3D) {
        applyVrToViewport(vp3D, vrSettingsRef.current.preset, vrSettingsRef.current.blend);
      }
    };
    return () => { onResetRef.current = null; };
  });

  // Re-apply VR preset + blend mode when they change at runtime (3D viewport only).
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const vp = engine.getViewport(VOLUME_3D_VP_ID);
    if (!vp) return;
    applyVrToViewport(vp, vrPreset, vrBlend);
  }, [vrPreset, vrBlend]);

  // Toggle crop mode on the 3D tool group (rotate ↔ crop handles).
  useEffect(() => {
    const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID_3D);
    if (!tg) return;
    set3DToolBindings(tg, crop3DEnabled);
  }, [crop3DEnabled]);

  // When the user activates Crosshairs (or any MPR tool), no CAMERA_MODIFIED
  // event fires yet, so the 3D marker wouldn't appear until the first slice drag.
  // Re-trigger the crosshair update so it shows immediately on tool activation.
  useEffect(() => {
    updateCrosshairRef.current?.();
  }, [activeTool]);

  // Re-fit viewports when a cell is expanded / restored (sizes change).
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const id = requestAnimationFrame(() => {
      engine.resize();
      engine.render();
    });
    return () => cancelAnimationFrame(id);
  }, [expandedSlot]);

  // Reset expansion when switching layout.
  useEffect(() => { setExpandedSlot(null); }, [layout]);

  // Resize viewports when container dimensions change
  useEffect(() => {
    const elements = [
      singleRef.current, axialRef.current, sagittalRef.current, coronalRef.current,
      volume3DRef.current, gridRef0.current, gridRef1.current, gridRef2.current, gridRef3.current,
    ].filter(Boolean) as HTMLDivElement[];
    if (elements.length === 0) return;

    const observer = new ResizeObserver(() => {
      const engine = renderingEngineRef.current;
      if (!engine) return;
      engine.resize();
      for (const vp of engine.getViewports()) {
        vp.resetCamera();
        vp.render();
      }
    });

    for (const el of elements) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [layout]);

  // Prevent browser zoom on trackpad pinch and route to Cornerstone zoom
  useEffect(() => {
    const elements = [
      singleRef.current, axialRef.current, sagittalRef.current, coronalRef.current,
      gridRef0.current, gridRef1.current, gridRef2.current, gridRef3.current,
    ].filter(Boolean) as HTMLDivElement[];
    if (elements.length === 0) return;

    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const engine = renderingEngineRef.current;
      if (!engine) return;

      for (const vp of engine.getViewports()) {
        if ((e.currentTarget as Node).contains(e.target as Node)) {
          const factor = 1 - e.deltaY * 0.01;
          const current = vp.getZoom();
          vp.setZoom(current * factor);
          vp.render();
          break;
        }
      }
    }

    function preventGesture(e: Event) {
      e.preventDefault();
    }

    for (const el of elements) {
      el.addEventListener('wheel', handleWheel, { passive: false });
      el.addEventListener('gesturestart', preventGesture);
      el.addEventListener('gesturechange', preventGesture);
    }

    return () => {
      for (const el of elements) {
        el.removeEventListener('wheel', handleWheel);
        el.removeEventListener('gesturestart', preventGesture);
        el.removeEventListener('gesturechange', preventGesture);
      }
    };
  }, [layout]);

  // Apply invert toggle
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    for (const vp of engine.getViewports()) {
      (vp as ViewportWithProperties).setProperties?.({ invert });
      vp.render();
    }
  }, [invert]);

  // Apply flip horizontal
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    for (const vp of engine.getViewports()) {
      vp.setCamera({ flipHorizontal: flipH });
      vp.render();
    }
  }, [flipH]);

  // Apply flip vertical
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    for (const vp of engine.getViewports()) {
      vp.setCamera({ flipVertical: flipV });
      vp.render();
    }
  }, [flipV]);

  // Apply cine play/stop
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    for (const vp of engine.getViewports()) {
      const el = (vp as any).element;
      if (!el) continue;
      if (cineEnabled) {
        csToolsUtilities.cine.playClip(el, { framesPerSecond: 15 });
      } else {
        csToolsUtilities.cine.stopClip(el);
      }
    }
  }, [cineEnabled]);

  /** Re-apply active tool + toggle settings after viewport recreation */
  function applyInitialState() {
    // Apply active tool (the useEffect for activeTool fires before tool group exists)
    const toolMap: Record<ActiveToolName, string> = {
      WindowLevel: WindowLevelTool.toolName,
      Pan: PanTool.toolName,
      Zoom: ZoomTool.toolName,
      Length: LengthTool.toolName,
      Angle: AngleTool.toolName,
      EllipticalROI: EllipticalROITool.toolName,
      Crosshairs: CrosshairsTool.toolName,
      Rotate: PlanarRotateTool.toolName,
    };
    setLeftClickTool(toolMap[activeToolRef.current]);

    // Apply toggles
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const t = togglesRef.current;
    for (const vp of engine.getViewports()) {
      if (t.invert) (vp as ViewportWithProperties).setProperties?.({ invert: true });
      if (t.flipH) vp.setCamera({ flipHorizontal: true });
      if (t.flipV) vp.setCamera({ flipVertical: true });
      vp.render();
    }
    if (t.cine) {
      for (const vp of engine.getViewports()) {
        const el = (vp as any).element;
        if (el) csToolsUtilities.cine.playClip(el, { framesPerSecond: 15 });
      }
    }
  }

  /** Teardown viewports + tool group but keep the rendering engine alive */
  function teardownViewports() {
    for (const fn of eventCleanupsRef.current) fn();
    eventCleanupsRef.current = [];

    // Remove orientation marker actors before disabling viewports
    const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (toolGroup) {
      try {
        const tool = toolGroup.getToolInstance(OrientationMarkerTool.toolName) as any;
        const engine = renderingEngineRef.current;
        if (tool?.orientationMarkers && engine) {
          for (const vp of engine.getViewports()) {
            const marker = tool.orientationMarkers[vp.id];
            if (!marker) continue;
            try {
              (vp as any).getRenderer?.()?.removeActor?.(marker.actor);
              marker.orientationWidget?.setEnabled(false);
              marker.orientationWidget?.delete();
              marker.actor?.delete();
            } catch { /* viewport may be partially torn down */ }
          }
          tool.orientationMarkers = {};
        }
        toolGroup.setToolDisabled(OrientationMarkerTool.toolName);
      } catch { /* may already be cleaned up */ }
    }

    ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
    ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID_3D);

    // Disable viewports (releases WebGL contexts) but keep engine alive
    const engine = renderingEngineRef.current;
    if (engine) {
      const vpIds = engine.getViewports().map((vp) => vp.id);
      for (const id of vpIds) {
        try { engine.disableElement(id); } catch { /* ok */ }
      }
    }

    if (cache.getVolume(VOLUME_ID)) {
      cache.removeVolumeLoadObject(VOLUME_ID);
    }
  }

  function listenToViewport(element: HTMLDivElement, event: string, onUpdate: () => void) {
    element.addEventListener(event, onUpdate);
    eventCleanupsRef.current.push(() => element.removeEventListener(event, onUpdate));
  }

  async function setupViewports() {
    if (imageIds.length === 0) return;

    const renderingEngine = renderingEngineRef.current;
    if (!renderingEngine) return;

    if (layout === 'mpr') {
      await setupMprViewports(renderingEngine);
    } else if (layout === '3d') {
      await setup3DViewport(renderingEngine);
    } else if (layout === '1x1') {
      if (orientation === primaryAxis) {
        setupNativeStackViewport(renderingEngine);
      } else {
        await setupReconstructedViewport(renderingEngine);
      }
    } else {
      // Grid layouts: 1x2, 2x1, 2x2
      setupGridViewports(renderingEngine);
    }
  }

  // Primary axis in 1x1 mode: native StackViewport (best quality)
  function setupNativeStackViewport(renderingEngine: RenderingEngine) {
    const element = singleRef.current;
    if (!element) return;

    renderingEngine.enableElement({
      viewportId: STACK_VIEWPORT_ID,
      element,
      type: Enums.ViewportType.STACK,
    });

    const toolGroup = createToolGroup([STACK_VIEWPORT_ID], renderingEngine.id);
    toolGroup?.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
    });

    const viewport = renderingEngine.getViewport(STACK_VIEWPORT_ID) as any;
    viewport.setStack(imageIds, 0).then(() => {
      renderingEngine.resize();
      viewport.resetCamera();
      viewport.render();
      updateSingleInfo(STACK_VIEWPORT_ID);
      applyInitialState();
    });

    listenToViewport(element, Enums.Events.STACK_NEW_IMAGE, () => {
      updateSingleInfo(STACK_VIEWPORT_ID);
    });
    listenToViewport(element, Enums.Events.VOI_MODIFIED, () => {
      updateSingleInfo(STACK_VIEWPORT_ID);
    });
  }

  // Reconstructed axis in 1x1 mode: single VolumeViewport
  async function setupReconstructedViewport(renderingEngine: RenderingEngine) {
    const element = singleRef.current;
    if (!element) return;

    renderingEngine.setViewports([{
      viewportId: VOLUME_SINGLE_VP_ID,
      element,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      defaultOptions: { orientation: ORIENTATION_MAP[orientation] },
    }]);

    const toolGroup = createToolGroup([VOLUME_SINGLE_VP_ID], renderingEngine.id);
    toolGroup?.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
    });

    const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
    volume.load();

    setVolumesForViewports(
      renderingEngine,
      [{ volumeId: VOLUME_ID }],
      [VOLUME_SINGLE_VP_ID],
    );

    renderingEngine.resize();
    renderingEngine.renderViewports([VOLUME_SINGLE_VP_ID]);
    applyInitialState();

    listenToViewport(element, Enums.Events.VOLUME_NEW_IMAGE, () => {
      updateSingleInfo(VOLUME_SINGLE_VP_ID);
    });
    listenToViewport(element, Enums.Events.VOI_MODIFIED, () => {
      updateSingleInfo(VOLUME_SINGLE_VP_ID);
    });

    updateSingleInfo(VOLUME_SINGLE_VP_ID);

    // Volume loading completes asynchronously — update info once ready
    const onVolumeLoaded = () => updateSingleInfo(VOLUME_SINGLE_VP_ID);
    eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded);
    eventCleanupsRef.current.push(() =>
      eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded),
    );
  }

  function updateSingleInfo(viewportId: string) {
    const vp = renderingEngineRef.current?.getViewport(viewportId);
    if (!vp) return;
    setSingleInfo(extractViewportInfo(vp));
  }

  async function setupMprViewports(renderingEngine: RenderingEngine) {
    const axialEl = axialRef.current;
    const sagittalEl = sagittalRef.current;
    const coronalEl = coronalRef.current;
    const volume3DEl = volume3DRef.current;
    if (!axialEl || !sagittalEl || !coronalEl || !volume3DEl) return;

    const elements = [axialEl, sagittalEl, coronalEl];

    renderingEngine.setViewports([
      {
        viewportId: MPR_VIEWPORT_IDS[0],
        element: axialEl,
        type: Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
      },
      {
        viewportId: MPR_VIEWPORT_IDS[1],
        element: sagittalEl,
        type: Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL },
      },
      {
        viewportId: MPR_VIEWPORT_IDS[2],
        element: coronalEl,
        type: Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: { orientation: Enums.OrientationAxis.CORONAL },
      },
      // 4th slot: true 3D volume rendering (perspective). Rotatable via TrackballRotateTool.
      {
        viewportId: VOLUME_3D_VP_ID,
        element: volume3DEl,
        type: Enums.ViewportType.VOLUME_3D,
      },
    ]);

    const toolGroup = createToolGroup(MPR_VIEWPORT_IDS, renderingEngine.id);
    toolGroup?.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
    });

    // Dedicated tool group for the 3D viewport (rotate / crop / pan / zoom).
    create3DToolGroup(renderingEngine.id, crop3DEnabledRef.current);

    const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
    volume.load();

    const allVpIds = [...MPR_VIEWPORT_IDS, VOLUME_3D_VP_ID];
    setVolumesForViewports(
      renderingEngine,
      [{ volumeId: VOLUME_ID }],
      allVpIds,
    );

    // Apply the current VR preset + blend mode to the 3D viewport and frame it.
    const vp3D = renderingEngine.getViewport(VOLUME_3D_VP_ID);
    if (vp3D) {
      applyVrToViewport(vp3D, vrSettingsRef.current.preset, vrSettingsRef.current.blend);
      try { vp3D.resetCamera(); } catch { /* not ready yet */ }
    }

    renderingEngine.resize();
    renderingEngine.renderViewports(allVpIds);
    applyInitialState();

    const updateAllMprInfo = () => {
      const engine = renderingEngineRef.current;
      if (!engine) return;
      for (const vpId of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId);
        if (!vp) continue;
        setMprInfo((prev) => ({ ...prev, [vpId]: extractViewportInfo(vp) }));
      }
    };

    for (let i = 0; i < MPR_VIEWPORT_IDS.length; i++) {
      const vpId = MPR_VIEWPORT_IDS[i];
      const el = elements[i];

      const updateVpInfo = () => {
        const vp = renderingEngineRef.current?.getViewport(vpId);
        if (!vp) return;
        setMprInfo((prev) => ({ ...prev, [vpId]: extractViewportInfo(vp) }));
      };

      listenToViewport(el, Enums.Events.VOLUME_NEW_IMAGE, updateVpInfo);
      listenToViewport(el, Enums.Events.VOI_MODIFIED, updateVpInfo);
      updateVpInfo();
    }

    // Volume loading completes asynchronously — update info once ready, and
    // re-frame/re-preset the 3D viewport once the volume data is available.
    const onVolumeLoaded = () => {
      updateAllMprInfo();
      const engine = renderingEngineRef.current;
      if (!engine || engine.hasBeenDestroyed) return;
      const vp3DLate = engine.getViewport(VOLUME_3D_VP_ID);
      if (vp3DLate) {
        applyVrToViewport(vp3DLate, vrSettingsRef.current.preset, vrSettingsRef.current.blend);
        try { vp3DLate.resetCamera(); } catch { /* not ready yet */ }
        try { vp3DLate.render(); } catch { /* engine torn down */ }
        update3DCrosshair();
      }
    };
    eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded);
    eventCleanupsRef.current.push(() =>
      eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded),
    );

    // 3D crosshair marker: real vtk actors (lines + sphere) living INSIDE the 3D
    // viewport. Position is the MPR slice intersection (x from sagittal, y from
    // coronal, z from axial). Updates on MPR scroll/crosshair-drag AND on 3D
    // rotation (camera-modified on the 3D viewport triggers a re-render so the
    // actors are redrawn from the new viewpoint — the actor geometry itself only
    // depends on MPR focus, so we don't need to update it on 3D rotation).
    const update3DCrosshair = () => {
      const engine = renderingEngineRef.current;
      if (!engine) return;
      const aVP = engine.getViewport(MPR_VIEWPORT_IDS[0]);
      const sVP = engine.getViewport(MPR_VIEWPORT_IDS[1]);
      const cVP = engine.getViewport(MPR_VIEWPORT_IDS[2]);
      const v3 = engine.getViewport(VOLUME_3D_VP_ID);
      if (!aVP || !sVP || !cVP || !v3) {
        logger.log('[crosshair3D] skip: missing viewport', { aVP: !!aVP, sVP: !!sVP, cVP: !!cVP, v3: !!v3 });
        return;
      }
      const aF = aVP.getCamera()?.focalPoint;
      const sF = sVP.getCamera()?.focalPoint;
      const cF = cVP.getCamera()?.focalPoint;
      if (!aF || !sF || !cF) {
        logger.log('[crosshair3D] skip: missing focal point');
        return;
      }
      // Intersection of the 3 orthogonal planes: x from sagittal, y from coronal, z from axial.
      const world = [sF[0], cF[1], aF[2]] as [number, number, number];
      // Bounds: prefer the cached volume's imageData bounds (structural, available
      // as soon as the volume is created) over vp.getBounds() (which uses
      // renderer.computeVisiblePropBounds and can return all-Infinity before the
      // volume actor is fully processed by the render pipeline).
      if (!volumeBoundsRef.current) {
        try {
          const vol = cache.getVolume(VOLUME_ID);
          const b = (vol as any)?.imageData?.getBounds?.();
          logger.log('[crosshair3D] bounds from volume imageData:', b);
          if (b && b.length === 6 && Number.isFinite(b[0]) && b[3] > b[0]) {
            volumeBoundsRef.current = b;
          }
        } catch (e) { logger.log('[crosshair3D] bounds fetch failed:', e); }
      }
      const bounds = volumeBoundsRef.current;
      if (!bounds || bounds.length !== 6) {
        logger.log('[crosshair3D] skip: no bounds');
        return;
      }
      const existing = crosshair3DRef.current;
      try {
        if (existing) {
          setCrosshair3DPosition(existing, world, bounds);
        } else {
          const ch = createCrosshair3D(world, bounds);
          crosshair3DRef.current = ch;
          // Add actors to the SAME renderer as the volume (not a separate overlay
          // layer — that would show on all viewports). VR renders in the
          // translucent pass; these actors render in the opaque pass first, then
          // VR composites on top. The portions of the lines that extend BEYOND
          // the volume bounds (MARGIN_RATIO) are outside the ray-cast region and
          // remain visible.
          const renderer = (v3 as any).getRenderer?.();
          if (!renderer) { console.warn('[crosshair3D] no renderer'); return; }
          ch.actors.forEach((a) => renderer.addActor(a.actor));
          // Extend clipping range so the crosshair lines (which poke beyond the
          // volume) aren't clipped by the camera's near/far planes.
          try { renderer.resetCameraClippingRange(); } catch { /* */ }
          logger.log('[crosshair3D] created actors at:', world, 'actors in renderer:', renderer.getActors().length);
        }
        v3.render();
      } catch (err) {
        console.warn('[crosshair3D] update failed:', err);
      }
    };
    updateCrosshairRef.current = update3DCrosshair;
    listenToViewport(axialEl, Enums.Events.CAMERA_MODIFIED, update3DCrosshair);
    listenToViewport(sagittalEl, Enums.Events.CAMERA_MODIFIED, update3DCrosshair);
    listenToViewport(coronalEl, Enums.Events.CAMERA_MODIFIED, update3DCrosshair);
    listenToViewport(volume3DEl, Enums.Events.CAMERA_MODIFIED, update3DCrosshair);
    eventCleanupsRef.current.push(() => {
      const engine = renderingEngineRef.current;
      const v3 = engine?.getViewport(VOLUME_3D_VP_ID);
      const ch = crosshair3DRef.current;
      if (v3 && ch) {
        try {
          const renderer = (v3 as any).getRenderer?.();
          if (renderer) ch.actors.forEach((a) => renderer.removeActor(a.actor));
        } catch { /* */ }
        try { v3.render(); } catch { /* */ }
      }
      crosshair3DRef.current = null;
      if (updateCrosshairRef.current === update3DCrosshair) updateCrosshairRef.current = null;
    });
    update3DCrosshair();
  }

  // Standalone 3D layout: a single full-size Volume Rendering viewport.
  async function setup3DViewport(renderingEngine: RenderingEngine) {
    const el = volume3DRef.current;
    if (!el) return;

    renderingEngine.enableElement({
      viewportId: VOLUME_3D_VP_ID,
      element: el,
      type: Enums.ViewportType.VOLUME_3D,
    });

    create3DToolGroup(renderingEngine.id, crop3DEnabledRef.current);

    const volume = await volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
    volume.load();

    setVolumesForViewports(renderingEngine, [{ volumeId: VOLUME_ID }], [VOLUME_3D_VP_ID]);

    const vp3D = renderingEngine.getViewport(VOLUME_3D_VP_ID);
    if (vp3D) {
      applyVrToViewport(vp3D, vrSettingsRef.current.preset, vrSettingsRef.current.blend);
      try { vp3D.resetCamera(); } catch { /* not ready yet */ }
    }

    renderingEngine.resize();
    renderingEngine.renderViewports([VOLUME_3D_VP_ID]);

    const onVolumeLoaded = () => {
      const engine = renderingEngineRef.current;
      if (!engine || engine.hasBeenDestroyed) return;
      const vp = engine.getViewport(VOLUME_3D_VP_ID);
      if (!vp) return;
      applyVrToViewport(vp, vrSettingsRef.current.preset, vrSettingsRef.current.blend);
      try { vp.resetCamera(); } catch { /* not ready yet */ }
      try { vp.render(); } catch { /* engine torn down */ }
    };
    eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded);
    eventCleanupsRef.current.push(() =>
      eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onVolumeLoaded),
    );
  }

  // Grid layouts (1x2, 2x1, 2x2): StackViewports, first has images, rest are empty
  function setupGridViewports(renderingEngine: RenderingEngine) {
    const refs = [gridRef0, gridRef1, gridRef2, gridRef3];
    const count = layout === '2x2' ? 4 : 2;
    const elements: HTMLDivElement[] = [];
    const vpIds: string[] = [];

    for (let i = 0; i < count; i++) {
      const el = refs[i].current;
      if (!el) continue;
      elements.push(el);
      vpIds.push(GRID_VIEWPORT_IDS[i]);
    }

    if (elements.length === 0) return;

    // Enable all viewport containers
    for (let i = 0; i < elements.length; i++) {
      renderingEngine.enableElement({
        viewportId: vpIds[i],
        element: elements[i],
        type: Enums.ViewportType.STACK,
      });
    }

    const toolGroup = createToolGroup(vpIds, renderingEngine.id);
    toolGroup?.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
    });

    // Load images only into the first viewport
    const viewport = renderingEngine.getViewport(vpIds[0]) as any;
    viewport.setStack(imageIds, 0).then(() => {
      renderingEngine.resize();
      viewport.resetCamera();
      viewport.render();
      updateSingleInfo(vpIds[0]);
      applyInitialState();
    });

    listenToViewport(elements[0], Enums.Events.STACK_NEW_IMAGE, () => updateSingleInfo(vpIds[0]));
    listenToViewport(elements[0], Enums.Events.VOI_MODIFIED, () => updateSingleInfo(vpIds[0]));
  }

  function loadSeriesIntoSlot(slotIndex: number, seriesUID: string) {
    if (!studyMetadata) return;
    const series = studyMetadata.series.find((s) => s.seriesInstanceUID === seriesUID);
    if (!series) return;

    const slotImageIds = series.slices.map((s) => s.imageId);
    if (slotImageIds.length === 0) return;

    const engine = renderingEngineRef.current;
    if (!engine) return;

    const vpId = GRID_VIEWPORT_IDS[slotIndex];
    const viewport = engine.getViewport(vpId) as any;
    if (!viewport) return;

    const infoUpdater = slotIndex === 0
      ? () => updateSingleInfo(vpId)
      : () => updateGridSlotInfo(slotIndex, vpId);

    viewport.setStack(slotImageIds, 0).then(() => {
      viewport.resetCamera();
      viewport.render();
      infoUpdater();
    });

    // Find the element for this viewport to attach event listeners
    const refs = [gridRef0, gridRef1, gridRef2, gridRef3];
    const el = refs[slotIndex].current;
    if (el) {
      listenToViewport(el, Enums.Events.STACK_NEW_IMAGE, infoUpdater);
      listenToViewport(el, Enums.Events.VOI_MODIFIED, infoUpdater);
    }

    setGridLoadedSlots((prev) => ({ ...prev, [slotIndex]: seriesUID }));
    setPickingSlot(null);
  }

  function updateGridSlotInfo(slotIndex: number, viewportId: string) {
    const vp = renderingEngineRef.current?.getViewport(viewportId);
    if (!vp) return;
    setGridInfo((prev) => ({ ...prev, [slotIndex]: extractViewportInfo(vp) }));
  }

  function createToolGroup(viewportIds: string[], renderingEngineId: string) {
    const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) return null;

    toolGroup.addTool(WindowLevelTool.toolName);
    toolGroup.addTool(PanTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.addTool(StackScrollTool.toolName);
    toolGroup.addTool(LengthTool.toolName);
    toolGroup.addTool(CrosshairsTool.toolName);
    toolGroup.addTool(AngleTool.toolName);
    toolGroup.addTool(EllipticalROITool.toolName);
    toolGroup.addTool(PlanarRotateTool.toolName);
    toolGroup.addTool(OrientationMarkerTool.toolName);
    // Set marker type directly on instance via ref
    const markerTool = toolGroup.getToolInstance(OrientationMarkerTool.toolName) as any;
    if (markerTool) {
      markerTool.configuration.overlayMarkerType = MARKER_TYPE_MAP[markerTypeRef.current];
    }

    for (const id of viewportIds) {
      toolGroup.addViewport(id, renderingEngineId);
    }

    // Enable AFTER viewports are added
    toolGroup.setToolEnabled(OrientationMarkerTool.toolName);

    return toolGroup;
  }

  const setLeftClickTool = useCallback((toolName: string) => {
    const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) return;

    for (const name of ALL_LEFT_CLICK_TOOLS) {
      // CrosshairsTool crashes in passive mode if annotations aren't initialized
      if (name === CrosshairsTool.toolName) {
        toolGroup.setToolDisabled(name);
      } else {
        toolGroup.setToolPassive(name);
      }
    }

    // Active tool on left click
    toolGroup.setToolActive(toolName, {
      bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
    });

    // Always keep Zoom on right-click and Pan on middle-click
    if (toolName !== ZoomTool.toolName) {
      toolGroup.setToolActive(ZoomTool.toolName, {
        bindings: [
          { mouseButton: csToolsEnums.MouseBindings.Secondary },
          { numTouchPoints: 2 },
        ],
      });
    }
    if (toolName !== PanTool.toolName) {
      toolGroup.setToolActive(PanTool.toolName, {
        bindings: [
          { mouseButton: csToolsEnums.MouseBindings.Auxiliary },
          { numTouchPoints: 3 },
        ],
      });
    }
  }, []);

  useEffect(() => {
    const toolMap: Record<ActiveToolName, string> = {
      WindowLevel: WindowLevelTool.toolName,
      Pan: PanTool.toolName,
      Zoom: ZoomTool.toolName,
      Length: LengthTool.toolName,
      Angle: AngleTool.toolName,
      EllipticalROI: EllipticalROITool.toolName,
      Crosshairs: CrosshairsTool.toolName,
      Rotate: PlanarRotateTool.toolName,
    };
    setLeftClickTool(toolMap[activeTool]);
  }, [activeTool, setLeftClickTool]);

  // Switch orientation marker type at runtime
  useEffect(() => {
    const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) return;
    const tool = toolGroup.getToolInstance(OrientationMarkerTool.toolName) as any;
    if (!tool) return;
    const engine = renderingEngineRef.current;
    if (!engine) return;
    tool.configuration.overlayMarkerType = MARKER_TYPE_MAP[orientationMarkerType];
    for (const vp of engine.getViewports()) {
      try {
        tool.updatingOrientationMarker[vp.id] = false;
        tool.addAxisActorInViewport(vp);
      } catch { /* skip viewports not ready */ }
    }
  }, [orientationMarkerType]);

  // Throttle trackpad scroll (trackpads fire many events per gesture)
  useEffect(() => {
    const elements = [
      singleRef.current, axialRef.current, sagittalRef.current, coronalRef.current,
      volume3DRef.current, gridRef0.current, gridRef1.current, gridRef2.current, gridRef3.current,
    ].filter(Boolean) as HTMLDivElement[];
    if (elements.length === 0) return;

    let lastScrollTime = 0;
    function throttleWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) return;
      const now = Date.now();
      if (now - lastScrollTime < 50) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      lastScrollTime = now;
    }

    for (const el of elements) {
      el.addEventListener('wheel', throttleWheel, { capture: true, passive: false });
    }
    return () => {
      for (const el of elements) {
        el.removeEventListener('wheel', throttleWheel, { capture: true } as EventListenerOptions);
      }
    };
  }, [layout]);

  const handleSliceChange = useCallback((viewportId: string, index: number) => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const vp = engine.getViewport(viewportId);
    if (!vp) return;
    const current = vp.getSliceIndex();
    const delta = index - current;
    if (delta === 0) return;
    if ('setImageIdIndex' in vp && typeof (vp as any).setImageIdIndex === 'function') {
      (vp as any).setImageIdIndex(index);
    } else {
      csCoreUtilities.scroll(vp, { delta });
    }
    vp.render();
    updateSingleInfo(viewportId);
  }, []);

  // 3D viewport zoom controls (buttons in VrOverlay). VolumeViewport3D supports
  // getZoom/setZoom via the base Viewport API (dolly).
  const handle3DZoom = useCallback((factor: number) => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const vp = engine.getViewport(VOLUME_3D_VP_ID);
    if (!vp) return;
    try {
      const current = (vp as any).getZoom?.() ?? 1;
      (vp as any).setZoom?.(current * factor);
      vp.render();
    } catch (e) {
      console.warn('[3D zoom] failed:', e);
    }
  }, []);

  const handle3DZoomReset = useCallback(() => {
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const vp = engine.getViewport(VOLUME_3D_VP_ID);
    if (!vp) return;
    try {
      (vp as any).setZoom?.(1);
      vp.render();
    } catch (e) {
      console.warn('[3D zoom reset] failed:', e);
    }
  }, []);

  // Capitalize first letter for label
  const orientationLabel = orientation.charAt(0).toUpperCase() + orientation.slice(1);
  const isReconstructed = orientation !== primaryAxis;
  const isGridLayout = layout === '1x2' || layout === '2x1' || layout === '2x2';

  if (layout === 'mpr') {
    const cells = [
      { ref: axialRef, label: 'Axial', info: mprInfo.CT_AXIAL, vpId: MPR_VIEWPORT_IDS[0], is3D: false },
      { ref: sagittalRef, label: 'Sagittal', info: mprInfo.CT_SAGITTAL, vpId: MPR_VIEWPORT_IDS[1], is3D: false },
      { ref: coronalRef, label: 'Coronal', info: mprInfo.CT_CORONAL, vpId: MPR_VIEWPORT_IDS[2], is3D: false },
      { ref: volume3DRef, label: '3D', info: null as ViewportInfo | null, vpId: VOLUME_3D_VP_ID, is3D: true },
    ];
    return (
      <div
        className="w-full h-full grid grid-cols-2 grid-rows-2 gap-px bg-neutral-800"
        onContextMenu={(e) => e.preventDefault()}
      >
        {cells.map((c, i) => {
          const expanded = expandedSlot === i;
          const hidden = expandedSlot !== null && !expanded;
          return (
            <div
              key={i}
              className={`flex overflow-hidden bg-black ${expanded ? 'col-span-2 row-span-2' : ''} ${hidden ? 'hidden' : ''}`}
              onDoubleClick={() => setExpandedSlot(expanded ? null : i)}
            >
              {!c.is3D && c.info && (
                <SliceSlider current={c.info.current} total={c.info.total} onChange={(idx) => handleSliceChange(c.vpId, idx)} />
              )}
              <div className="relative flex-1 min-w-0">
                <div ref={c.ref} className="absolute inset-0" />
                {c.is3D ? (
                  <>
                    <VrOverlay
                      modality={studyMetadata?.modality}
                      preset={vrPreset}
                      blend={vrBlend}
                      cropEnabled={crop3DEnabled}
                      onPresetChange={setVrPreset}
                      onBlendChange={setVrBlend}
                      onToggleCrop={() => setCrop3DEnabled((v) => !v)}
                      onZoomIn={() => handle3DZoom(1.2)}
                      onZoomOut={() => handle3DZoom(1 / 1.2)}
                      onZoomReset={handle3DZoomReset}
                    />
                  </>
                ) : c.info && (
                  <ViewportOverlay label={c.label} info={c.info} />
                )}
                <ExpandButton expanded={expanded} onClick={() => setExpandedSlot(expanded ? null : i)} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (layout === '3d') {
    return (
      <div
        className="w-full h-full bg-black"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="relative w-full h-full">
          <div ref={volume3DRef} className="absolute inset-0" />
          <VrOverlay
            modality={studyMetadata?.modality}
            preset={vrPreset}
            blend={vrBlend}
            cropEnabled={crop3DEnabled}
            onPresetChange={setVrPreset}
            onBlendChange={setVrBlend}
            onToggleCrop={() => setCrop3DEnabled((v) => !v)}
            onZoomIn={() => handle3DZoom(1.2)}
            onZoomOut={() => handle3DZoom(1 / 1.2)}
            onZoomReset={handle3DZoomReset}
          />
        </div>
      </div>
    );
  }

  if (isGridLayout) {
    const count = layout === '2x2' ? 4 : 2;
    const gridClass =
      layout === '1x2' ? 'grid-cols-2 grid-rows-1'
      : layout === '2x1' ? 'grid-cols-1 grid-rows-2'
      : 'grid-cols-2 grid-rows-2';
    const refs = [gridRef0, gridRef1, gridRef2, gridRef3];
    const spanClass =
      layout === '1x2' ? 'col-span-2'
      : layout === '2x1' ? 'row-span-2'
      : 'col-span-2 row-span-2';

    return (
      <div
        className={`w-full h-full grid ${gridClass} gap-px bg-neutral-800`}
        onContextMenu={(e) => e.preventDefault()}
      >
        {Array.from({ length: count }).map((_, i) => {
          const isSlotLoaded = i === 0 || !!gridLoadedSlots[i];
          const slotInfo = i === 0 ? singleInfo : gridInfo[i];
          const slotSeriesUID = gridLoadedSlots[i];
          const slotSeries = slotSeriesUID && studyMetadata
            ? studyMetadata.series.find((s) => s.seriesInstanceUID === slotSeriesUID)
            : null;
          const slotLabel = i === 0
            ? orientationLabel
            : slotSeries
              ? `#${slotSeries.seriesNumber} ${slotSeries.seriesDescription || ''}`
              : '';
          const hasSeries = studyMetadata && studyMetadata.series.length > 1;
          const isPicking = pickingSlot === i;
          const expanded = expandedSlot === i;
          const hidden = expandedSlot !== null && !expanded;

          return (
            <div
              key={i}
              className={`flex overflow-hidden bg-black ${expanded ? spanClass : ''} ${hidden ? 'hidden' : ''}`}
              onDoubleClick={() => setExpandedSlot(expanded ? null : i)}
            >
              {isSlotLoaded && slotInfo && (
                <SliceSlider current={slotInfo.current} total={slotInfo.total} onChange={(idx) => handleSliceChange(GRID_VIEWPORT_IDS[i], idx)} />
              )}
              <div className="relative flex-1 min-w-0 bg-black">
                <div ref={refs[i]} className="absolute inset-0" />
                {isPicking && hasSeries ? (
                  <EmptyViewportOverlay
                    availableSeries={studyMetadata.series}
                    onSelect={(uid) => loadSeriesIntoSlot(i, uid)}
                    onClose={() => setPickingSlot(null)}
                  />
                ) : isSlotLoaded && slotInfo ? (
                  <>
                    <ViewportOverlay label={slotLabel} info={slotInfo} />
                    {hasSeries && (
                      <button
                        onClick={() => setPickingSlot(i)}
                        className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded bg-neutral-800/70 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 text-xs transition-colors"
                        title={t('viewport.switchSeries')}
                      >
                        &#x21C4;
                      </button>
                    )}
                    <ExpandButton expanded={expanded} onClick={() => setExpandedSlot(expanded ? null : i)} />
                  </>
                ) : hasSeries ? (
                  <EmptyViewportOverlay
                    availableSeries={studyMetadata.series}
                    onSelect={(uid) => loadSeriesIntoSlot(i, uid)}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-xs text-neutral-600">No other series available</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const singleVpId = orientation === primaryAxis ? STACK_VIEWPORT_ID : VOLUME_SINGLE_VP_ID;

  return (
    <div className="flex w-full h-full" onContextMenu={(e) => e.preventDefault()}>
      <SliceSlider current={singleInfo.current} total={singleInfo.total} onChange={(idx) => handleSliceChange(singleVpId, idx)} />
      <div className="relative flex-1 min-w-0 bg-black overflow-hidden">
        <div ref={singleRef} className="absolute inset-0" />
        <ViewportOverlay
          label={`${orientationLabel}${isReconstructed ? ' (recon)' : ''}`}
          info={singleInfo}
        />
      </div>
    </div>
  );
}
