import { VR_BLEND_OPTIONS, VR_PRESETS_CT, VR_PRESETS_MR, type VrBlend } from '../constants';

/**
 * Overlay controls for the 3D Volume Rendering viewport:
 * preset (transfer function), blend mode, and a crop toggle (cuts away
 * superficial tissue like skin/bone to reveal deep structures such as cysts).
 */
export function VrOverlay({
  modality,
  preset,
  blend,
  cropEnabled,
  onPresetChange,
  onBlendChange,
  onToggleCrop,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: {
  modality?: string;
  preset: string;
  blend: VrBlend;
  cropEnabled: boolean;
  onPresetChange: (p: string) => void;
  onBlendChange: (b: VrBlend) => void;
  onToggleCrop: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}) {
  const isMR = modality?.toUpperCase().startsWith('MR') ?? false;
  const presetList = isMR ? VR_PRESETS_MR : VR_PRESETS_CT;
  // Always include the active preset even if it's from the "other" modality list,
  // so the select never shows a blank value.
  const options = presetList.includes(preset) ? presetList : [preset, ...presetList];
  const selectCls =
    'bg-neutral-900/90 text-neutral-200 text-[11px] rounded px-1.5 py-1 border border-neutral-700 outline-none focus:border-blue-500 cursor-pointer backdrop-blur-sm';
  // Stop double-click from bubbling to the grid cell's expand/restore handler,
  // so rapidly clicking zoom (or any overlay button) doesn't toggle fullscreen.
  const stopDblClick = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <div className="absolute top-2 left-2 z-10 flex flex-col gap-1.5 pointer-events-none">
        <span className="text-xs font-medium text-neutral-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          3D
        </span>
        <span className="text-[10px] text-neutral-500 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          {cropEnabled ? 'drag handles to crop' : 'drag to rotate'}
        </span>
      </div>
      {/* Zoom controls (left side, below the label) */}
      <div className="absolute left-2 top-16 z-10 flex flex-col gap-1">
        <button
          onClick={onZoomIn}
          onDoubleClick={stopDblClick}
          className="w-7 h-7 flex items-center justify-center rounded bg-neutral-900/90 hover:bg-neutral-800 border border-neutral-700 text-neutral-200 text-sm cursor-pointer backdrop-blur-sm transition-colors"
          title="Zoom in"
        >+</button>
        <button
          onClick={onZoomOut}
          onDoubleClick={stopDblClick}
          className="w-7 h-7 flex items-center justify-center rounded bg-neutral-900/90 hover:bg-neutral-800 border border-neutral-700 text-neutral-200 text-sm cursor-pointer backdrop-blur-sm transition-colors"
          title="Zoom out"
        >−</button>
        <button
          onClick={onZoomReset}
          onDoubleClick={stopDblClick}
          className="w-7 h-7 flex items-center justify-center rounded bg-neutral-900/90 hover:bg-neutral-800 border border-neutral-700 text-neutral-400 text-[10px] cursor-pointer backdrop-blur-sm transition-colors"
          title="Reset zoom"
        >1:1</button>
      </div>
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5 items-end">
        <select
          className={selectCls}
          value={preset}
          onChange={(e) => onPresetChange(e.target.value)}
          title="Transfer function preset"
        >
          {options.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          className={selectCls}
          value={blend}
          onChange={(e) => onBlendChange(e.target.value as VrBlend)}
          title="Blend mode (MinIP highlights low-density structures like cysts)"
        >
          {VR_BLEND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={onToggleCrop}
          onDoubleClick={stopDblClick}
          className={`text-[11px] rounded px-1.5 py-1 border backdrop-blur-sm cursor-pointer transition-colors ${
            cropEnabled
              ? 'bg-blue-600/80 border-blue-500 text-white'
              : 'bg-neutral-900/90 border-neutral-700 text-neutral-300 hover:bg-neutral-800'
          }`}
          title="Crop box — drag handles to cut away skin/bone and reveal deep structures"
        >
          ✂ Crop
        </button>
      </div>
      {blend === 'minip' && !cropEnabled && (
        <div className="absolute bottom-2 right-2 z-10 pointer-events-none">
          <span className="text-[10px] text-teal-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            MinIP — low-density (cysts/fluid)
          </span>
        </div>
      )}
      {cropEnabled && (
        <div className="absolute bottom-2 right-2 z-10 pointer-events-none">
          <span className="text-[10px] text-amber-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            Crop on — drag sphere handles to clip volume
          </span>
        </div>
      )}
    </>
  );
}
