import {
  SunDim,
  Move,
  ZoomIn,
  Ruler,
  RotateCcw,
  LayoutGrid,
  Square,
  Grid2x2,
  Info,
  Search,
  Settings,
  Compass,
  Layers,
  Crosshair,
  RotateCw,
  Contrast,
  FlipHorizontal,
  FlipVertical,
  Play,
  Pause,
  ChevronDown,
  Triangle,
  Circle,
  Box,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ActiveToolName, LayoutType, OrientationMarkerType } from './ViewportGrid';

type MeasureTool = 'Length' | 'Angle' | 'EllipticalROI';

interface ToolbarProps {
  activeTool: ActiveToolName;
  onToolChange: (tool: ActiveToolName) => void;
  layout: LayoutType;
  onLayoutChange: (layout: LayoutType) => void;
  onReset: () => void;
  showSeriesBrowser?: boolean;
  onToggleSeriesBrowser?: () => void;
  showMetadata?: boolean;
  onToggleMetadata?: () => void;
  onOpenSpotlight?: () => void;
  onOpenSettings?: () => void;
  orientationMarkerType?: OrientationMarkerType;
  onOrientationMarkerTypeChange?: (type: OrientationMarkerType) => void;
  invert?: boolean;
  onInvertToggle?: () => void;
  flipH?: boolean;
  onFlipHToggle?: () => void;
  flipV?: boolean;
  onFlipVToggle?: () => void;
  cineEnabled?: boolean;
  onCineToggle?: () => void;
}

const mainTools: { name: ActiveToolName; label: string; icon: React.ReactNode }[] = [
  { name: 'WindowLevel', label: 'toolbar.windowLevel', icon: <SunDim className="w-5 h-5" /> },
  { name: 'Zoom', label: 'toolbar.zoom', icon: <ZoomIn className="w-5 h-5" /> },
  { name: 'Pan', label: 'toolbar.pan', icon: <Move className="w-5 h-5" /> },
];

const measureTools: { name: MeasureTool; label: string; icon: React.ReactNode }[] = [
  { name: 'Length', label: 'toolbar.length', icon: <Ruler className="w-5 h-5" /> },
  { name: 'Angle', label: 'toolbar.angle', icon: <Triangle className="w-5 h-5" /> },
  { name: 'EllipticalROI', label: 'toolbar.ellipticalROI', icon: <Circle className="w-5 h-5" /> },
];

const layouts: { name: LayoutType; label: string; icon: React.ReactNode }[] = [
  { name: '1x1', label: 'toolbar.layout1x1', icon: <Square className="w-4 h-4" /> },
  { name: '1x2', label: 'toolbar.layout1x2', icon: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="w-4 h-4">
      <rect x="1" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="1" width="6" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )},
  { name: '2x1', label: 'toolbar.layout2x1', icon: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="w-4 h-4">
      <rect x="1" y="1" width="14" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="9" width="14" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )},
  { name: '2x2', label: 'toolbar.layout2x2', icon: <Grid2x2 className="w-4 h-4" /> },
  { name: 'mpr', label: 'toolbar.layoutMpr', icon: <Grid2x2 className="w-4 h-4" /> },
  { name: '3d', label: 'toolbar.layout3d', icon: <Box className="w-4 h-4" /> },
];

const markerTypes: { name: OrientationMarkerType; label: string }[] = [
  { name: 'cube', label: 'toolbar.markerCube' },
  { name: 'axes', label: 'toolbar.markerAxes' },
  { name: 'custom', label: 'toolbar.markerCustom' },
];

/**
 * Portal-based dropdown menu that escapes overflow:hidden/auto ancestors.
 * Uses a transparent backdrop to handle outside clicks — this avoids the
 * problem of document-level mousedown listeners racing with menu item clicks.
 */
function PortalDropdown({
  anchorRef,
  open,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [open, anchorRef]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Invisible backdrop — catches clicks outside the menu */}
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={onClose}
      />
      {/* The actual dropdown menu — above the backdrop */}
      <div
        className="fixed bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl py-1 z-[9999] min-w-[180px] pointer-events-auto"
        style={{ top: pos.top, left: pos.left }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export default function Toolbar({
  activeTool, onToolChange,
  layout, onLayoutChange,
  onReset,
  showSeriesBrowser, onToggleSeriesBrowser,
  showMetadata, onToggleMetadata,
  onOpenSpotlight, onOpenSettings,
  orientationMarkerType = 'cube', onOrientationMarkerTypeChange,
  invert = false, onInvertToggle,
  flipH = false, onFlipHToggle,
  flipV = false, onFlipVToggle,
  cineEnabled = false, onCineToggle,
}: ToolbarProps) {
  const { t } = useTranslation();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [markerOpen, setMarkerOpen] = useState(false);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [currentMeasure, setCurrentMeasure] = useState<MeasureTool>('Length');

  const layoutBtnRef = useRef<HTMLButtonElement>(null);
  const markerBtnRef = useRef<HTMLButtonElement>(null);
  const measureBtnRef = useRef<HTMLDivElement>(null);

  // Track active measurement tool
  useEffect(() => {
    if (activeTool === 'Length' || activeTool === 'Angle' || activeTool === 'EllipticalROI') {
      setCurrentMeasure(activeTool);
    }
  }, [activeTool]);

  const isMeasureActive = activeTool === 'Length' || activeTool === 'Angle' || activeTool === 'EllipticalROI';
  const activeMeasureInfo = measureTools.find((m) => m.name === currentMeasure) ?? measureTools[0];

  const btnClass = (active?: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
      active
        ? 'bg-blue-600 text-white'
        : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
    }`;

  const toggleClass = (active?: boolean) =>
    `flex items-center gap-1 px-2 py-1.5 rounded text-sm transition-colors ${
      active
        ? 'bg-amber-600/80 text-white'
        : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
    }`;

  return (
    <div className="relative z-20 flex items-center gap-1 px-3 py-2 bg-neutral-900 border-b border-neutral-800 overflow-x-auto whitespace-nowrap">
      {/* Series browser toggle — far left */}
      {onToggleSeriesBrowser && (
        <>
          <button
            onClick={onToggleSeriesBrowser}
            title={t('toolbar.seriesBrowser')}
            className={btnClass(showSeriesBrowser)}
          >
            <Layers className="w-5 h-5" />
            <span className="hidden sm:inline">{t('toolbar.series')}</span>
          </button>
          <div className="w-px h-6 bg-neutral-700 mx-1" />
        </>
      )}

      {/* Main tools: W/L, Zoom, Pan */}
      {mainTools.map((tool) => (
        <button
          key={tool.name}
          onClick={() => onToolChange(activeTool === tool.name && tool.name !== 'WindowLevel' ? 'WindowLevel' : tool.name)}
          title={t(tool.label)}
          className={btnClass(activeTool === tool.name)}
        >
          {tool.icon}
          <span className="hidden sm:inline">{t(tool.label)}</span>
        </button>
      ))}

      {/* Crosshairs — only in MPR */}
      {layout === 'mpr' && (
        <button
          onClick={() => onToolChange(activeTool === 'Crosshairs' ? 'WindowLevel' : 'Crosshairs')}
          title={t('toolbar.crosshairs')}
          className={btnClass(activeTool === 'Crosshairs')}
        >
          <Crosshair className="w-5 h-5" />
          <span className="hidden sm:inline">{t('toolbar.crosshairs')}</span>
        </button>
      )}

      {/* Measurement dropdown */}
      <div className="relative flex items-center" ref={measureBtnRef}>
        <button
          onClick={() => {
            if (isMeasureActive) {
              onToolChange('WindowLevel');
            } else {
              onToolChange(currentMeasure);
            }
          }}
          title={t(activeMeasureInfo.label)}
          className={`flex items-center gap-1.5 pl-3 pr-1 py-1.5 rounded-l text-sm transition-colors ${
            isMeasureActive
              ? 'bg-blue-600 text-white'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          {activeMeasureInfo.icon}
          <span className="hidden sm:inline">{t(activeMeasureInfo.label)}</span>
        </button>
        <button
          onClick={() => setMeasureOpen(!measureOpen)}
          title={t('toolbar.moreMeasurements')}
          className={`flex items-center px-1 py-1.5 rounded-r text-sm transition-colors ${
            isMeasureActive
              ? 'bg-blue-600 text-white'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <PortalDropdown anchorRef={measureBtnRef} open={measureOpen} onClose={() => setMeasureOpen(false)}>
          {measureTools.map((m) => (
            <button
              key={m.name}
              onClick={() => {
                setCurrentMeasure(m.name);
                onToolChange(m.name);
                setMeasureOpen(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors ${
                activeTool === m.name
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {m.icon}
              {t(m.label)}
            </button>
          ))}
        </PortalDropdown>
      </div>

      <div className="w-px h-6 bg-neutral-700 mx-1" />

      {/* Utility tools: Rotate */}
      <button
        onClick={() => onToolChange(activeTool === 'Rotate' ? 'WindowLevel' : 'Rotate')}
        title={t('toolbar.rotate')}
        className={btnClass(activeTool === 'Rotate')}
      >
        <RotateCw className="w-5 h-5" />
      </button>

      {/* Viewport toggles: Invert, Flip H, Flip V */}
      {onInvertToggle && (
        <button onClick={onInvertToggle} title={t('toolbar.invert')} className={toggleClass(invert)}>
          <Contrast className="w-5 h-5" />
        </button>
      )}
      {onFlipHToggle && (
        <button onClick={onFlipHToggle} title={t('toolbar.flipHorizontal')} className={toggleClass(flipH)}>
          <FlipHorizontal className="w-5 h-5" />
        </button>
      )}
      {onFlipVToggle && (
        <button onClick={onFlipVToggle} title={t('toolbar.flipVertical')} className={toggleClass(flipV)}>
          <FlipVertical className="w-5 h-5" />
        </button>
      )}

      {/* Cine play/pause */}
      {onCineToggle && (
        <button onClick={onCineToggle} title={cineEnabled ? t('toolbar.stopCine') : t('toolbar.playCine')} className={toggleClass(cineEnabled)}>
          {cineEnabled ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
        </button>
      )}

      <div className="w-px h-6 bg-neutral-700 mx-1" />

      <button
        onClick={onReset}
        title={t('toolbar.resetViewport')}
        className={btnClass()}
      >
        <RotateCcw className="w-5 h-5" />
        <span className="hidden sm:inline">{t('toolbar.reset')}</span>
      </button>

      <div className="w-px h-6 bg-neutral-700 mx-1" />

      {/* Layout dropdown */}
      <button
        ref={layoutBtnRef}
        onClick={() => setLayoutOpen(!layoutOpen)}
        title={t('toolbar.layout')}
        className={btnClass()}
      >
        <LayoutGrid className="w-5 h-5" />
        <span className="hidden sm:inline">{t('toolbar.layout')}</span>
      </button>
      <PortalDropdown anchorRef={layoutBtnRef} open={layoutOpen} onClose={() => setLayoutOpen(false)}>
        {layouts.map((l) => (
          <button
            key={l.name}
            onClick={() => {
              onLayoutChange(l.name);
              setLayoutOpen(false);
            }}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors ${
              layout === l.name
                ? 'bg-blue-600/20 text-blue-400'
                : 'text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            {l.icon}
            {t(l.label)}
          </button>
        ))}
      </PortalDropdown>

      {/* Orientation marker type dropdown */}
      {onOrientationMarkerTypeChange && (
        <>
          <button
            ref={markerBtnRef}
            onClick={() => setMarkerOpen(!markerOpen)}
            title={t('toolbar.orientationMarker')}
            className={btnClass()}
          >
            <Compass className="w-5 h-5" />
          </button>
          <PortalDropdown anchorRef={markerBtnRef} open={markerOpen} onClose={() => setMarkerOpen(false)}>
            {markerTypes.map((m) => (
              <button
                key={m.name}
                onClick={() => {
                  onOrientationMarkerTypeChange(m.name);
                  setMarkerOpen(false);
                }}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors ${
                  orientationMarkerType === m.name
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {t(m.label)}
              </button>
            ))}
          </PortalDropdown>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Analyze button (Cmd+K) */}
      {onOpenSpotlight && (
        <button
          onClick={onOpenSpotlight}
          title={t('toolbar.analyzeShortcut')}
          className={btnClass()}
        >
          <Search className="w-5 h-5" />
          <span className="hidden sm:inline">{t('toolbar.analyze')}</span>
        </button>
      )}

      {/* Study Info toggle */}
      {onToggleMetadata && (
        <button
          onClick={onToggleMetadata}
          title={t('toolbar.studyInfo')}
          className={btnClass(showMetadata)}
        >
          <Info className="w-5 h-5" />
        </button>
      )}

      {/* Settings */}
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          title={t('toolbar.llmSettings')}
          className={btnClass()}
        >
          <Settings className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
