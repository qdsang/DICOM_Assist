import type { ViewportInfo } from '../viewportUtils';

/** Top-left label + slice counter + bottom-left W/L readout for a viewport. */
export function ViewportOverlay({ label, info }: { label: string; info: ViewportInfo }) {
  const shadow = 'drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]';
  return (
    <>
      <div className={`absolute top-2 left-2 pointer-events-none z-10 flex flex-col gap-0.5`}>
        <span className={`text-xs font-medium text-neutral-300 ${shadow}`}>
          {label}
        </span>
        {info.total > 0 && (
          <span className={`text-[11px] tabular-nums text-neutral-400 ${shadow}`}>
            {info.current + 1} / {info.total}
          </span>
        )}
      </div>
      {(info.ww > 0 || info.wc !== 0) && (
        <div className={`absolute bottom-2 left-2 pointer-events-none z-10`}>
          <span className={`text-[11px] tabular-nums text-neutral-400 ${shadow}`}>
            W:{Math.round(info.ww)} C:{Math.round(info.wc)}
          </span>
        </div>
      )}
    </>
  );
}
