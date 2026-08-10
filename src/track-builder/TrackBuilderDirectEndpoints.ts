export type TrackBuilderScreenPoint = readonly [number, number];

// Count distinct directions leaving a coordinate. Repeated/retraced geometry
// contributes one ray, while a genuine through-junction contributes two.
export function uniqueTrackBuilderRayCount(
  rays: readonly TrackBuilderScreenPoint[],
  equivalentDirectionCosine = 0.94,
): number {
  const directions: TrackBuilderScreenPoint[] = [];
  for (const ray of rays) {
    const length = Math.hypot(ray[0], ray[1]);
    if (length < 1e-6) continue;
    const normalized: TrackBuilderScreenPoint = [ray[0] / length, ray[1] / length];
    if (directions.some(direction => direction[0] * normalized[0] + direction[1] * normalized[1] >= equivalentDirectionCosine)) continue;
    directions.push(normalized);
  }
  return directions.length;
}

// A traversal turnaround has both neighboring coordinates extending in nearly
// the same direction from the vertex. It is a visible geometric leaf even
// though it is not the start or end of the ordered GPX section.
export function isTrackBuilderTurnaround(
  previous: TrackBuilderScreenPoint,
  vertex: TrackBuilderScreenPoint,
  next: TrackBuilderScreenPoint,
  minimumCosine = 0.85,
): boolean {
  const beforeX = previous[0] - vertex[0];
  const beforeY = previous[1] - vertex[1];
  const afterX = next[0] - vertex[0];
  const afterY = next[1] - vertex[1];
  const beforeLength = Math.hypot(beforeX, beforeY);
  const afterLength = Math.hypot(afterX, afterY);
  if (beforeLength < 1e-6 || afterLength < 1e-6) return false;
  return (beforeX * afterX + beforeY * afterY) / (beforeLength * afterLength) >= minimumCosine;
}
