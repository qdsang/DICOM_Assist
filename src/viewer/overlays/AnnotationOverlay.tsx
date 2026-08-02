import type { LLMAnnotation } from '../../llm/agentTypes';

interface AnnotationOverlayProps {
  annotations: LLMAnnotation[];
  imageWidth?: number;
  imageHeight?: number;
}

export function AnnotationOverlay({ annotations, imageWidth, imageHeight }: AnnotationOverlayProps) {
  if (annotations.length === 0 || !imageWidth || !imageHeight) return null;

  const strokeW = Math.max(imageWidth, imageHeight) * 0.004;
  const fontSize = imageHeight * 0.028;
  const headLen = Math.max(imageWidth, imageHeight) * 0.018;

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-10"
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {annotations.map((ann) => {
        const color = ann.color ?? '#ef4444';
        switch (ann.type) {
          case 'arrow': {
            const [sx, sy, ex, ey] = ann.coordinates;
            const angle = Math.atan2(ey - sy, ex - sx);
            const x1 = ex - headLen * Math.cos(angle - Math.PI / 6);
            const y1 = ey - headLen * Math.sin(angle - Math.PI / 6);
            const x2 = ex - headLen * Math.cos(angle + Math.PI / 6);
            const y2 = ey - headLen * Math.sin(angle + Math.PI / 6);
            return (
              <g key={ann.id}>
                <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth={strokeW} />
                <polygon points={`${ex},${ey} ${x1},${y1} ${x2},${y2}`} fill={color} />
                {ann.label && (
                  <text x={ex + headLen * 0.5} y={ey - headLen * 0.3} fill={color} fontSize={fontSize} fontWeight="bold" fontFamily="sans-serif">
                    {ann.label}
                  </text>
                )}
              </g>
            );
          }
          case 'circle': {
            const [cx, cy, r] = ann.coordinates;
            return (
              <g key={ann.id}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeW} />
                {ann.label && (
                  <text x={cx + r + strokeW * 2} y={cy} fill={color} fontSize={fontSize} fontWeight="bold" fontFamily="sans-serif">
                    {ann.label}
                  </text>
                )}
              </g>
            );
          }
          case 'text': {
            const [tx, ty] = ann.coordinates;
            return (
              <g key={ann.id}>
                <text x={tx} y={ty} fill={color} fontSize={fontSize} fontWeight="bold" fontFamily="sans-serif">
                  {ann.label ?? ''}
                </text>
              </g>
            );
          }
          default:
            return null;
        }
      })}
    </svg>
  );
}
