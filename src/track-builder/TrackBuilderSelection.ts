import type { TrackBuilderLinePosition, TrackBuilderSection } from 'places-shared/map';

export type TrackBuilderSelectionIntensity = 1 | 2 | 3 | 4 | 5;
export type TrackBuilderSelectionPoint = readonly [number, number];

export interface TrackBuilderSelectionProfile {
  readonly label: string;
  readonly localHalfLengthPixels?: number;
  readonly adjacentHops: number;
}

export interface TrackBuilderContinuationCandidate<T> {
  readonly key: string;
  readonly value: T;
  readonly points: readonly TrackBuilderSelectionPoint[];
}

export interface TrackBuilderContinuation<T> {
  readonly candidate: TrackBuilderContinuationCandidate<T>;
  readonly connection: TrackBuilderLinePosition;
  readonly outer: TrackBuilderLinePosition;
}

export interface TrackBuilderSelectionRange {
  start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

const PROFILES: Record<TrackBuilderSelectionIntensity, TrackBuilderSelectionProfile> = {
  1: { label: 'Local', localHalfLengthPixels: 60, adjacentHops: 0 },
  2: { label: 'Extended', localHalfLengthPixels: 150, adjacentHops: 0 },
  3: { label: 'Feature', adjacentHops: 0 },
  4: { label: '+1 adjacent', adjacentHops: 1 },
  5: { label: '+2 adjacent', adjacentHops: 2 },
};

export function trackBuilderSelectionProfile(value: number): TrackBuilderSelectionProfile {
  const intensity = Math.max(1, Math.min(5, Math.round(value))) as TrackBuilderSelectionIntensity;
  return PROFILES[intensity];
}

// Return the complete committed bounds of a section, including a previously trimmed section.
export function wholeTrackBuilderSectionRange(
  section: Pick<TrackBuilderSection, 'coordinates' | 'sourceCoordinates' | 'startPosition' | 'endPosition'>,
): TrackBuilderSelectionRange {
  const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
  return {
    start: section.startPosition ?? { segmentIndex: 0, t: 0 },
    end: section.endPosition ?? { segmentIndex: sourceCoordinates.length - 2, t: 1 },
  };
}

function interpolatePoint(points: readonly TrackBuilderSelectionPoint[], position: TrackBuilderLinePosition): TrackBuilderSelectionPoint {
  const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
  const a = points[index];
  const b = points[index + 1];
  return [a[0] + (b[0] - a[0]) * position.t, a[1] + (b[1] - a[1]) * position.t];
}

function positionOffset(position: TrackBuilderLinePosition): number {
  return position.segmentIndex + position.t;
}

// Project a pointer onto a line while keeping the same route-order occurrence
// when the line doubles back over itself. A clearly closer segment still wins.
export function closestTrackBuilderLinePosition(
  anchor: TrackBuilderSelectionPoint,
  points: readonly TrackBuilderSelectionPoint[],
  reference?: TrackBuilderLinePosition,
  ambiguityPixels = 2,
): TrackBuilderLinePosition {
  if (points.length < 2) return reference ?? { segmentIndex: 0, t: 0 };

  const projection = (index: number) => {
    const a = points[index];
    const b = points[index + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((anchor[0] - a[0]) * dx + (anchor[1] - a[1]) * dy) / denominator));
    return {
      position: { segmentIndex: index, t },
      distance: Math.hypot(anchor[0] - (a[0] + t * dx), anchor[1] - (a[1] + t * dy)),
    };
  };

  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index++) {
    nearestDistance = Math.min(nearestDistance, projection(index).distance);
  }

  const referenceOffset = reference ? positionOffset(reference) : undefined;
  let best: { position: TrackBuilderLinePosition; distance: number; routeDistance: number } | undefined;
  for (let index = 0; index < points.length - 1; index++) {
    const candidate = projection(index);
    if (candidate.distance > nearestDistance + ambiguityPixels) continue;
    const routeDistance = referenceOffset === undefined ? 0 : Math.abs(positionOffset(candidate.position) - referenceOffset);
    if (!best
      || routeDistance < best.routeDistance - 1e-9
      || (Math.abs(routeDistance - best.routeDistance) < 1e-9 && candidate.distance < best.distance)) {
      best = { ...candidate, routeDistance };
    }
  }
  return best?.position ?? reference ?? { segmentIndex: 0, t: 0 };
}

// Prefer the exact source vertex when a continuous edge projection is already
// very close to it. Repeated selections land junctions on the same vertex; a
// distant vertex never beats a substantially closer edge.
export function prioritizeTrackBuilderVertexPosition(
  points: readonly TrackBuilderSelectionPoint[],
  position: TrackBuilderLinePosition,
  maximumDistancePixels = 4,
): TrackBuilderLinePosition {
  if (points.length < 2 || maximumDistancePixels <= 0) return position;
  const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
  const a = points[index];
  const b = points[index + 1];
  const segmentLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const startDistance = segmentLength * position.t;
  const endDistance = segmentLength * (1 - position.t);
  if (startDistance <= maximumDistancePixels && startDistance <= endDistance) {
    return { segmentIndex: index, t: 0 };
  }
  if (endDistance <= maximumDistancePixels) return { segmentIndex: index, t: 1 };
  return position;
}

// Distinguish a pointer gesture crossing a retraced junction from movement
// along the intervening source route. A large source-order detour whose ends
// remain close on screen starts another selected range.
export function shouldSplitTrackBuilderGesture(
  sourceArcPixels: number,
  directScreenPixels: number,
  pointerStepPixels: number,
): boolean {
  return sourceArcPixels > Math.max(48, pointerStepPixels * 6)
    && directScreenPixels <= Math.max(24, pointerStepPixels * 3 + 6);
}

// Canonicalize gesture ranges before previewing or replacing source geometry.
// Boundary adjustments can revisit an earlier occurrence on a retraced line;
// those overlapping passes describe one selected source range, not competing
// replacements.
export function normalizeTrackBuilderSelectionRanges(
  ranges: readonly TrackBuilderSelectionRange[],
): TrackBuilderSelectionRange[] {
  const normalized = ranges
    .map(range => positionOffset(range.start) <= positionOffset(range.end)
      ? { start: range.start, end: range.end }
      : { start: range.end, end: range.start })
    .sort((left, right) => positionOffset(left.start) - positionOffset(right.start));
  const merged: TrackBuilderSelectionRange[] = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || positionOffset(range.start) > positionOffset(previous.end) + 1e-9) {
      merged.push({ ...range });
      continue;
    }
    if (positionOffset(range.end) > positionOffset(previous.end)) previous.end = range.end;
  }
  return merged;
}

function endpointPosition(points: readonly TrackBuilderSelectionPoint[], endpoint: 'start' | 'end'): TrackBuilderLinePosition {
  return endpoint === 'start'
    ? { segmentIndex: 0, t: 0 }
    : { segmentIndex: points.length - 2, t: 1 };
}

// Move a screen-space distance along a projected line. Negative distances move
// toward the start and positive distances move toward the end.
export function linePositionAtScreenDistance(
  points: readonly TrackBuilderSelectionPoint[],
  start: TrackBuilderLinePosition,
  distancePixels: number,
): TrackBuilderLinePosition {
  if (points.length < 2 || Math.abs(distancePixels) < 1e-9) return start;
  const direction = distancePixels < 0 ? -1 : 1;
  let remaining = Math.abs(distancePixels);
  let position = start;

  while (remaining > 1e-9) {
    const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
    const a = points[index];
    const b = points[index + 1];
    const segmentLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const availableFraction = direction < 0 ? position.t : 1 - position.t;
    const availableDistance = segmentLength * availableFraction;
    if (remaining <= availableDistance && segmentLength > 1e-9) {
      return { segmentIndex: index, t: position.t + direction * remaining / segmentLength };
    }
    remaining -= availableDistance;
    if (direction < 0) {
      if (index === 0) return endpointPosition(points, 'start');
      position = { segmentIndex: index - 1, t: 1 };
    } else {
      if (index === points.length - 2) return endpointPosition(points, 'end');
      position = { segmentIndex: index + 1, t: 0 };
    }
  }
  return position;
}

export function localSelectionRange(
  points: readonly TrackBuilderSelectionPoint[],
  center: TrackBuilderLinePosition,
  halfLengthPixels: number,
): { readonly start: TrackBuilderLinePosition; readonly end: TrackBuilderLinePosition } {
  return {
    start: linePositionAtScreenDistance(points, center, -halfLengthPixels),
    end: linePositionAtScreenDistance(points, center, halfLengthPixels),
  };
}

function closestLinePosition(anchor: TrackBuilderSelectionPoint, points: readonly TrackBuilderSelectionPoint[]): {
  readonly position: TrackBuilderLinePosition;
  readonly distance: number;
} {
  let best = { position: { segmentIndex: 0, t: 0 }, distance: Number.POSITIVE_INFINITY };
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((anchor[0] - a[0]) * dx + (anchor[1] - a[1]) * dy) / denominator));
    const distance = Math.hypot(anchor[0] - (a[0] + t * dx), anchor[1] - (a[1] + t * dy));
    if (distance < best.distance) best = { position: { segmentIndex: index - 1, t }, distance };
  }
  return best;
}

// Pick one continuation at a junction. Alignment dominates the score: a
// straight continuation wins over nearby branches; paths that immediately
// reverse direction are rejected.
export function bestTrackBuilderContinuation<T>(
  anchor: TrackBuilderSelectionPoint,
  inwardReference: TrackBuilderSelectionPoint,
  candidates: readonly TrackBuilderContinuationCandidate<T>[],
  maximumJunctionDistancePixels = 8,
): TrackBuilderContinuation<T> | undefined {
  const outwardX = anchor[0] - inwardReference[0];
  const outwardY = anchor[1] - inwardReference[1];
  const outwardLength = Math.hypot(outwardX, outwardY);
  if (outwardLength < 1e-9) return undefined;

  let best: { continuation: TrackBuilderContinuation<T>; score: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.points.length < 2) continue;
    const closest = closestLinePosition(anchor, candidate.points);
    if (closest.distance > maximumJunctionDistancePixels) continue;
    // Vector styles and tile boundaries can expose the selected path more than
    // once. A candidate that also covers the incoming reference is a retrace,
    // not an adjacent continuation.
    if (closestLinePosition(inwardReference, candidate.points).distance <= 2) continue;
    for (const endpoint of ['start', 'end'] as const) {
      const outer = endpointPosition(candidate.points, endpoint);
      if (Math.abs(positionOffset(outer) - positionOffset(closest.position)) < 1e-6) continue;
      const sample = linePositionAtScreenDistance(candidate.points, closest.position, endpoint === 'start' ? -16 : 16);
      const samplePoint = interpolatePoint(candidate.points, sample);
      const connectionPoint = interpolatePoint(candidate.points, closest.position);
      const dx = samplePoint[0] - connectionPoint[0];
      const dy = samplePoint[1] - connectionPoint[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) continue;
      const alignment = (outwardX * dx + outwardY * dy) / (outwardLength * length);
      if (alignment < -0.2) continue;
      const score = alignment * 100 - closest.distance * 4;
      if (!best || score > best.score) {
        best = {
          continuation: { candidate, connection: closest.position, outer },
          score,
        };
      }
    }
  }
  return best?.continuation;
}
