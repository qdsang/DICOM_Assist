import { imageLoader } from '@cornerstonejs/core';
import type { StudyMetadata, SeriesMetadata } from '../dicom/types';
import { renderSliceToJpeg } from '../filtering/SliceExporter';
import { blobToBase64 } from './shared';
import { logger } from '../utils/logger';
import i18next from '../i18n';
import type { LLMAnnotation, ToolExecutor, ToolResultContent } from './agentTypes';
import { DEFAULT_AGENT_CONFIG } from './agentTypes';

// --- Agent System Prompt ---

export function buildAgentSystemPrompt(surveyMode?: boolean): string {
  const lines = [
    'You are a medical imaging AI assistant performing an interactive analysis of DICOM images.',
    'You have access to tools that let you examine slices, adjust windowing, generate MPR reconstructions, measure HU values, and place annotations.',
    '',
    'WORKFLOW:',
    '1. You will receive initial slices selected for your review.',
    '2. Examine them carefully. If you need more information, use the available tools:',
    '   - list_series() to see all available series',
    '   - get_slice() to view a specific slice with different windowing',
    '   - get_slice_range() to browse a range of slices',
    '   - render_mpr() for coronal/sagittal reconstructions',
    '   - get_hu_stats() to measure CT density in a region',
    '   - annotate() to mark findings on the viewer for the user',
    '3. When you have enough information, call finish_analysis() with your complete report.',
    '',
    'GUIDELINES:',
    '- Be thorough but efficient. Do not request more images than necessary.',
    '- Always specify appropriate window/level for the tissue of interest:',
    '  Lung: W=1500, L=-600 | Mediastinum: W=400, L=40 | Bone: W=2000, L=400 | Brain: W=80, L=40',
    '- Use annotate() to highlight key findings for the user. Arrow for pointing, circle for regions, text for labels.',
    '- Coordinates are in image pixels (0,0 = top-left). Image dimensions are provided with each image.',
    '- For get_hu_stats, place the ROI center on the finding of interest.',
    '',
    surveyMode
      ? 'MODE: Survey mode — provide a broad overview of all visible findings.'
      : 'MODE: Focused analysis — investigate the specific clinical question thoroughly.',
    '',
    'IMPORTANT: This is a research/portfolio tool, not for clinical diagnosis. Always include this disclaimer in your report.',
  ];

  if (i18next.language === 'zh-CN') {
    lines.push('', 'LANGUAGE: Respond in Simplified Chinese (简体中文). You may keep medical/technical terms in English.');
  }

  return lines.join('\n');
}

// --- ToolExecutor Implementation ---

export interface ToolExecutorOptions {
  metadata: StudyMetadata;
  onAnnotation: (annotation: LLMAnnotation) => void;
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const { metadata, onAnnotation } = options;

  function findSeries(seriesNumber: string): SeriesMetadata | undefined {
    return metadata.series.find((s) => String(s.seriesNumber) === seriesNumber);
  }

  function findSlice(series: SeriesMetadata, instanceNumber: number) {
    return series.slices.find((s) => s.instanceNumber === instanceNumber);
  }

  // --- Tool handlers ---

  async function listSeries(): Promise<ToolResultContent> {
    const lines = metadata.series.map((s) => {
      const parts = [
        `Series ${s.seriesNumber}: "${s.seriesDescription}"`,
        s.modality,
        `${s.slices.length} slices`,
        s.sliceThickness ? `${s.sliceThickness}mm` : '',
        s.anatomicalPlane,
        `z: ${s.zMin.toFixed(1)} to ${s.zMax.toFixed(1)} mm`,
        s.convolutionKernel ? `kernel: ${s.convolutionKernel}` : '',
        `W:${s.windowWidth ?? 'N/A'} C:${s.windowCenter ?? 'N/A'}`,
      ].filter(Boolean);
      return parts.join(' | ');
    });
    return {
      type: 'text',
      text: `Study: ${metadata.studyDescription}\nModality: ${metadata.modality}\n\nAvailable series:\n${lines.join('\n')}`,
    };
  }

  async function getSlice(input: Record<string, unknown>): Promise<ToolResultContent> {
    const seriesNumber = String(input.seriesNumber);
    const instanceNumber = Number(input.instanceNumber);
    const windowWidth = Number(input.windowWidth);
    const windowCenter = Number(input.windowCenter);

    const series = findSeries(seriesNumber);
    if (!series) return { type: 'text', text: `Error: Series ${seriesNumber} not found` };

    const slice = findSlice(series, instanceNumber);
    if (!slice) return { type: 'text', text: `Error: Instance ${instanceNumber} not found in series ${seriesNumber}` };

    const blob = await renderSliceToJpeg(slice.imageId, windowCenter, windowWidth);
    if (!blob) return { type: 'text', text: 'Error: Failed to render image' };

    // Load image to get dimensions for the label
    const image = await imageLoader.loadAndCacheImage(slice.imageId);
    const dims = `${image.columns}x${image.rows}`;
    const z = slice.imagePositionPatient[2]?.toFixed(1) ?? 'N/A';
    const label = `Image ${dims} pixels, series ${seriesNumber}, instance ${instanceNumber}, z=${z}mm, W:${windowWidth} L:${windowCenter}`;

    const base64 = await blobToBase64(blob);
    return { type: 'images', images: [{ base64 }], text: label };
  }

  async function getSliceRange(input: Record<string, unknown>): Promise<ToolResultContent> {
    const seriesNumber = String(input.seriesNumber);
    const start = Number(input.startInstance);
    const end = Number(input.endInstance);
    const count = Math.min(Number(input.count), DEFAULT_AGENT_CONFIG.maxImagesPerCall);
    const windowWidth = Number(input.windowWidth);
    const windowCenter = Number(input.windowCenter);

    const series = findSeries(seriesNumber);
    if (!series) return { type: 'text', text: `Error: Series ${seriesNumber} not found` };

    const inRange = series.slices
      .filter((s) => s.instanceNumber >= start && s.instanceNumber <= end)
      .sort((a, b) => a.instanceNumber - b.instanceNumber);

    if (inRange.length === 0) return { type: 'text', text: `Error: No slices found in range ${start}-${end}` };

    // Uniform sampling
    const sampled: typeof inRange = [];
    if (count >= inRange.length) {
      sampled.push(...inRange);
    } else {
      for (let i = 0; i < count; i++) {
        const idx = Math.round((i * (inRange.length - 1)) / (count - 1));
        sampled.push(inRange[idx]);
      }
    }

    // Render all slices
    const results: { base64: string }[] = [];
    const labels: string[] = [];
    let dims = '';

    for (const slice of sampled) {
      const blob = await renderSliceToJpeg(slice.imageId, windowCenter, windowWidth);
      if (blob) {
        const base64 = await blobToBase64(blob);
        results.push({ base64 });
        const z = slice.imagePositionPatient[2]?.toFixed(1) ?? 'N/A';
        labels.push(`instance ${slice.instanceNumber}, z=${z}mm`);
        if (!dims) {
          const image = await imageLoader.loadAndCacheImage(slice.imageId);
          dims = `${image.columns}x${image.rows}`;
        }
      }
    }

    if (results.length === 0) return { type: 'text', text: 'Error: Failed to render any images' };

    return {
      type: 'images',
      images: results,
      text: `${results.length} images, each ${dims} pixels. Series ${seriesNumber}, W:${windowWidth} L:${windowCenter}. Slices: ${labels.join('; ')}`,
    };
  }

  async function renderMpr(input: Record<string, unknown>): Promise<ToolResultContent> {
    const seriesNumber = String(input.seriesNumber);
    const plane = String(input.plane) as 'coronal' | 'sagittal';
    const positionPercent = Math.max(0, Math.min(1, Number(input.positionPercent)));
    const windowWidth = Number(input.windowWidth);
    const windowCenter = Number(input.windowCenter);

    const series = findSeries(seriesNumber);
    if (!series) return { type: 'text', text: `Error: Series ${seriesNumber} not found` };

    const sortedSlices = [...series.slices].sort((a, b) => a.instanceNumber - b.instanceNumber);
    if (sortedSlices.length === 0) return { type: 'text', text: 'Error: No slices in series' };

    // Load all images
    const images = await Promise.all(
      sortedSlices.map((s) => imageLoader.loadAndCacheImage(s.imageId)),
    );
    const { columns: width, rows: height } = images[0];
    const numSlices = images.length;
    const slope = images[0].slope ?? 1;
    const intercept = images[0].intercept ?? 0;

    const lower = windowCenter - windowWidth / 2;
    const upper = windowCenter + windowWidth / 2;

    // Pixel-level MPR reconstruction
    let mprWidth: number, mprHeight: number;
    if (plane === 'coronal') {
      mprWidth = width;
      mprHeight = numSlices;
    } else {
      mprWidth = height;
      mprHeight = numSlices;
    }

    const pos = Math.floor(positionPercent * (plane === 'coronal' ? height : width));

    const rgba = new Uint8ClampedArray(mprWidth * mprHeight * 4);
    for (let z = 0; z < numSlices; z++) {
      const pixelData = images[z].getPixelData();
      for (let p = 0; p < mprWidth; p++) {
        let pixelIdx: number;
        if (plane === 'coronal') {
          pixelIdx = pos * width + p;
        } else {
          pixelIdx = p * width + pos;
        }
        const hu = pixelData[pixelIdx] * slope + intercept;
        let val: number;
        if (hu <= lower) val = 0;
        else if (hu >= upper) val = 255;
        else val = ((hu - lower) / windowWidth) * 255;

        const offset = (z * mprWidth + p) * 4;
        rgba[offset] = val;
        rgba[offset + 1] = val;
        rgba[offset + 2] = val;
        rgba[offset + 3] = 255;
      }
    }

    const canvas = new OffscreenCanvas(mprWidth, mprHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { type: 'text', text: 'Error: Canvas context unavailable' };
    ctx.putImageData(new ImageData(rgba, mprWidth, mprHeight), 0, 0);

    // Resize if too large
    const MAX_EDGE = 1568;
    const longEdge = Math.max(mprWidth, mprHeight);
    if (longEdge > MAX_EDGE) {
      const scale = MAX_EDGE / longEdge;
      const newW = Math.round(mprWidth * scale);
      const newH = Math.round(mprHeight * scale);
      const resized = new OffscreenCanvas(newW, newH);
      const rctx = resized.getContext('2d');
      if (rctx) {
        rctx.drawImage(canvas, 0, 0, newW, newH);
        const blob = await resized.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        const base64 = await blobToBase64(blob!);
        return { type: 'image', base64 };
      }
    }

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const base64 = await blobToBase64(blob);
    return { type: 'image', base64 };
  }

  async function getHuStats(input: Record<string, unknown>): Promise<ToolResultContent> {
    const seriesNumber = String(input.seriesNumber);
    const instanceNumber = Number(input.instanceNumber);
    const x = Math.round(Number(input.x));
    const y = Math.round(Number(input.y));
    const radius = Math.max(1, Math.round(Number(input.radius)));

    const series = findSeries(seriesNumber);
    if (!series) return { type: 'text', text: `Error: Series ${seriesNumber} not found` };

    const slice = findSlice(series, instanceNumber);
    if (!slice) return { type: 'text', text: `Error: Instance ${instanceNumber} not found` };

    const image = await imageLoader.loadAndCacheImage(slice.imageId);
    const { columns: width, rows: height } = image;
    const pixelData = image.getPixelData();
    const slope = image.slope ?? 1;
    const intercept = image.intercept ?? 0;

    const values: number[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const hu = pixelData[py * width + px] * slope + intercept;
        values.push(hu);
      }
    }

    if (values.length === 0) return { type: 'text', text: 'Error: ROI outside image bounds' };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((sq, v) => sq + (v - mean) ** 2, 0) / values.length);

    let interpretation = '';
    if (mean > 400) interpretation = ' (consistent with calcification/dense bone)';
    else if (mean > 150) interpretation = ' (consistent with high-density/contrast)';
    else if (mean > 30) interpretation = ' (consistent with solid tissue)';
    else if (mean > -10) interpretation = ' (consistent with fluid/cystic)';
    else if (mean > -50) interpretation = ' (consistent with fat)';
    else if (mean > -300) interpretation = ' (consistent with ground-glass opacity)';
    else interpretation = ' (consistent with air/lung)';

    return {
      type: 'text',
      text: `HU stats for ROI at (${x}, ${y}) r=${radius}, ${values.length} pixels:\n  Min: ${min.toFixed(0)} HU\n  Max: ${max.toFixed(0)} HU\n  Mean: ${mean.toFixed(1)} HU${interpretation}\n  Std: ${std.toFixed(1)} HU`,
    };
  }

  function annotate(input: Record<string, unknown>): ToolResultContent {
    const annotation: LLMAnnotation = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seriesNumber: String(input.seriesNumber),
      instanceNumber: Number(input.instanceNumber),
      type: input.annotationType as LLMAnnotation['type'],
      coordinates: (input.coordinates as number[]).map(Number),
      label: input.label as string | undefined,
      color: input.color as string | undefined,
    };
    onAnnotation(annotation);
    logger.log('[Agent] Annotation added:', annotation);
    return { type: 'text', text: `Annotation "${annotation.label ?? annotation.type}" added on series ${annotation.seriesNumber}, instance ${annotation.instanceNumber}` };
  }

  // --- Dispatch ---

  return {
    async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResultContent> {
      try {
        switch (toolName) {
          case 'list_series': return await listSeries();
          case 'get_slice': return await getSlice(input);
          case 'get_slice_range': return await getSliceRange(input);
          case 'render_mpr': return await renderMpr(input);
          case 'get_hu_stats': return await getHuStats(input);
          case 'annotate': return annotate(input);
          case 'finish_analysis': return { type: 'text', text: String(input.report ?? '') };
          default: return { type: 'text', text: `Error: Unknown tool "${toolName}"` };
        }
      } catch (err) {
        logger.warn('[Agent] Tool execution error:', err);
        return { type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` };
      }
    },
  };
}
