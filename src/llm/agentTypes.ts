// --- Annotation Types ---

export type AnnotationType = 'arrow' | 'circle' | 'text';

export interface LLMAnnotation {
  id: string;
  seriesNumber: string;
  instanceNumber: number;
  type: AnnotationType;
  /** arrow: [startX, startY, endX, endY] | circle: [centerX, centerY, radius] | text: [x, y] */
  coordinates: number[];
  label?: string;
  color?: string;
}

// --- Tool Result Types ---

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType?: string }
  | { type: 'images'; images: { base64: string; mediaType?: string }[]; text: string };

export interface ToolExecutor {
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResultContent>;
}

// --- Agent Loop Types ---

export interface AgentConfig {
  maxIterations: number;
  maxImagesPerCall: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxIterations: 15,
  maxImagesPerCall: 20,
};

// --- Tool Schema Type (Claude API format) ---

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// --- Tool Schemas ---

export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: 'list_series',
    description: 'List all available DICOM series in the study with their metadata (slice count, thickness, window presets, z-range, anatomical plane). Call this first to understand what series are available.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_slice',
    description: 'Render a specific slice from a series with specified window/level and return it as a JPEG image. Use this to examine a particular slice in detail or with a different window (e.g. lung vs mediastinum).',
    input_schema: {
      type: 'object',
      properties: {
        seriesNumber: { type: 'string', description: 'Series Number, e.g. "3"' },
        instanceNumber: { type: 'number', description: 'Instance number of the slice to render' },
        windowWidth: { type: 'number', description: 'Window width for display (e.g. 1500 for lung, 400 for mediastinum)' },
        windowCenter: { type: 'number', description: 'Window center/level for display (e.g. -600 for lung, 40 for mediastinum)' },
      },
      required: ['seriesNumber', 'instanceNumber', 'windowWidth', 'windowCenter'],
    },
  },
  {
    name: 'get_slice_range',
    description: 'Render multiple slices from a range, uniformly sampled, with specified window/level. Returns up to 20 JPEG images. Use this to browse a region of interest.',
    input_schema: {
      type: 'object',
      properties: {
        seriesNumber: { type: 'string', description: 'Series Number' },
        startInstance: { type: 'number', description: 'Start instance number (inclusive)' },
        endInstance: { type: 'number', description: 'End instance number (inclusive)' },
        count: { type: 'number', description: 'Number of slices to sample (max 20)' },
        windowWidth: { type: 'number', description: 'Window width' },
        windowCenter: { type: 'number', description: 'Window center/level' },
      },
      required: ['seriesNumber', 'startInstance', 'endInstance', 'count', 'windowWidth', 'windowCenter'],
    },
  },
  {
    name: 'render_mpr',
    description: 'Generate a multiplanar reconstruction (MPR) view — coronal or sagittal — at a specified position through the volume. Returns a JPEG image. Use this to assess lesion 3D morphology and pleural relationships.',
    input_schema: {
      type: 'object',
      properties: {
        seriesNumber: { type: 'string', description: 'Series Number (must be an axial series)' },
        plane: { type: 'string', enum: ['coronal', 'sagittal'], description: 'Reconstruction plane' },
        positionPercent: { type: 'number', description: 'Position through the volume, 0.0 = anterior/left, 1.0 = posterior/right (0.5 = center)' },
        windowWidth: { type: 'number', description: 'Window width' },
        windowCenter: { type: 'number', description: 'Window center/level' },
      },
      required: ['seriesNumber', 'plane', 'positionPercent', 'windowWidth', 'windowCenter'],
    },
  },
  {
    name: 'get_hu_stats',
    description: 'Read raw CT Hounsfield Unit (HU) values from a circular ROI on a specific slice. Returns min, max, mean, and standard deviation. Use this to characterize lesion density (solid: 30-100 HU, ground-glass: -700 to -300, calcium: >150, fat: <-50, fluid: 0-20).',
    input_schema: {
      type: 'object',
      properties: {
        seriesNumber: { type: 'string', description: 'Series Number' },
        instanceNumber: { type: 'number', description: 'Instance number of the slice' },
        x: { type: 'number', description: 'X coordinate of ROI center (in image pixels, 0 = left)' },
        y: { type: 'number', description: 'Y coordinate of ROI center (in image pixels, 0 = top)' },
        radius: { type: 'number', description: 'Radius of circular ROI in pixels' },
      },
      required: ['seriesNumber', 'instanceNumber', 'x', 'y', 'radius'],
    },
  },
  {
    name: 'annotate',
    description: 'Place an annotation on a specific slice to mark a finding. The annotation will be displayed on the viewer. Use this to highlight lesions, measurements, or areas of interest for the user.',
    input_schema: {
      type: 'object',
      properties: {
        seriesNumber: { type: 'string', description: 'Series Number' },
        instanceNumber: { type: 'number', description: 'Instance number of the slice to annotate' },
        annotationType: { type: 'string', enum: ['arrow', 'circle', 'text'], description: 'Type of annotation' },
        coordinates: {
          type: 'array',
          items: { type: 'number' },
          description: 'arrow: [startX, startY, endX, endY] | circle: [centerX, centerY, radius] | text: [x, y]',
        },
        label: { type: 'string', description: 'Text label for the annotation (e.g. "Nodule 2.5cm", "Ground-glass opacity")' },
        color: { type: 'string', description: 'Hex color (default: #ef4444 red). e.g. "#fbbf24" for yellow' },
      },
      required: ['seriesNumber', 'instanceNumber', 'annotationType', 'coordinates'],
    },
  },
  {
    name: 'finish_analysis',
    description: 'Submit your final analysis report and end the investigation. Call this when you have gathered enough information. The report should be formatted as markdown with sections for Findings, Impression, and Recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', description: 'Final analysis report in markdown format' },
      },
      required: ['report'],
    },
  },
];
