import { Enums } from '@cornerstonejs/core';
import {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  LengthTool,
  CrosshairsTool,
  AngleTool,
  EllipticalROITool,
  PlanarRotateTool,
  OrientationMarkerTool,
} from '@cornerstonejs/tools';
import type { AnatomicalPlane } from '../dicom/orientationUtils';

// --- Viewport / engine identifiers ---
export const RENDERING_ENGINE_ID = 'dicomRenderingEngine';
export const TOOL_GROUP_ID = 'mainTools';
export const TOOL_GROUP_ID_3D = 'mainTools3D';
export const STACK_VIEWPORT_ID = 'CT_STACK';
export const VOLUME_SINGLE_VP_ID = 'CT_SINGLE_VOL';
export const VOLUME_3D_VP_ID = 'CT_3D';
export const MPR_VIEWPORT_IDS = ['CT_AXIAL', 'CT_SAGITTAL', 'CT_CORONAL'];
export const GRID_VIEWPORT_IDS = ['VP_GRID_0', 'VP_GRID_1', 'VP_GRID_2', 'VP_GRID_3'];
export const VOLUME_ID = 'dicomVolume';

// --- Shared types ---
export type ActiveToolName =
  | 'WindowLevel' | 'Pan' | 'Zoom'
  | 'Length' | 'Angle' | 'EllipticalROI'
  | 'Crosshairs' | 'Rotate';

export type LayoutType = '1x1' | '1x2' | '2x1' | '2x2' | 'mpr' | '3d';
export type OrientationMarkerType = 'cube' | 'axes' | 'custom';

// --- Maps ---
export const ORIENTATION_MAP: Record<AnatomicalPlane, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal: Enums.OrientationAxis.CORONAL,
};

export const MARKER_TYPE_MAP: Record<OrientationMarkerType, number> = {
  cube: OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE,
  axes: OrientationMarkerTool.OVERLAY_MARKER_TYPES.AXES,
  custom: OrientationMarkerTool.OVERLAY_MARKER_TYPES.CUSTOM,
};

export const ALL_LEFT_CLICK_TOOLS = [
  WindowLevelTool.toolName,
  PanTool.toolName,
  ZoomTool.toolName,
  LengthTool.toolName,
  AngleTool.toolName,
  EllipticalROITool.toolName,
  CrosshairsTool.toolName,
  PlanarRotateTool.toolName,
];

// --- Volume Rendering presets ---
// CT-Soft-Tissue is the default — it renders organs and fluid-filled structures
// (e.g. cysts, ~0-20 HU) as low-density regions against soft tissue.
export const VR_PRESETS_CT = [
  'CT-Soft-Tissue',
  'CT-Bone',
  'CT-Bones',
  'CT-Lung',
  'CT-MIP',
  'CT-Fat',
  'CT-Muscle',
  'CT-Air',
  'CT-Chest-Contrast-Enhanced',
  'CT-Chest-Vessels',
  'CT-Liver-Vasculature',
  'CT-Cardiac',
  'CT-Pulmonary-Arteries',
  'CT-Coronary-Arteries',
];
export const VR_PRESETS_MR = ['MR-Default', 'MR-MIP', 'MR-Angio', 'MR-T2-Brain'];

export type VrBlend = 'composite' | 'mip' | 'minip' | 'average';

export const VR_BLEND_OPTIONS: { value: VrBlend; label: string }[] = [
  { value: 'composite', label: 'Volume' },
  { value: 'mip', label: 'MIP' },
  { value: 'minip', label: 'MinIP' },
  { value: 'average', label: 'Average' },
];

export const VR_BLEND_MAP: Record<VrBlend, Enums.BlendModes> = {
  composite: Enums.BlendModes.COMPOSITE,
  mip: Enums.BlendModes.MAXIMUM_INTENSITY_BLEND,
  minip: Enums.BlendModes.MINIMUM_INTENSITY_BLEND,
  average: Enums.BlendModes.AVERAGE_INTENSITY_BLEND,
};
