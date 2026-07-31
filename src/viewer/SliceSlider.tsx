import { useRef } from 'react';

/** Vertical slice slider rendered to the left of a stack viewport. */
export function SliceSlider({ current, total, onChange }: {
  current: number;
  total: number;
  onChange: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  if (total <= 1) return null;

  const pct = (current / (total - 1)) * 100;

  function indexFromY(clientY: number) {
    const track = trackRef.current;
    if (!track) return current;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.round(ratio * (total - 1));
  }

  function handlePointerDown(e: React.PointerEvent) {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onChange(indexFromY(e.clientY));
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    onChange(indexFromY(e.clientY));
  }

  function handlePointerUp() {
    dragging.current = false;
  }

  return (
    <div
      ref={trackRef}
      className="w-5 shrink-0 flex items-center justify-center bg-neutral-900 cursor-pointer select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="relative w-1 h-full rounded-full bg-neutral-700">
        <div
          className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-blue-500 shadow"
          style={{ top: `calc(${pct}% - 6px)` }}
        />
      </div>
    </div>
  );
}
