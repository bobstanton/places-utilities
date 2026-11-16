import type { TrackBuilderLinePosition } from 'places-utilities/core';
import { prioritizeTrackBuilderVertexPosition, type TrackBuilderSelectionPoint } from './TrackBuilderSelection';

export interface TrackBuilderCandidateBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface TrackBuilderProjectedCandidate<TCandidate> {
  readonly candidate: TCandidate;
  readonly points: readonly TrackBuilderSelectionPoint[];
  readonly bounds: TrackBuilderCandidateBounds;
}

export interface TrackBuilderCandidateIndex<TCandidate> {
  readonly candidates: readonly TrackBuilderProjectedCandidate<TCandidate>[];
  readonly cellSize: number;
  readonly cells: ReadonlyMap<string, readonly TrackBuilderProjectedCandidate<TCandidate>[]>;
}

export interface TrackBuilderProjectedMatch {
  readonly position: TrackBuilderLinePosition;
  readonly distance: number;
}

export function trackBuilderCandidateBounds(points: readonly TrackBuilderSelectionPoint[]): TrackBuilderCandidateBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }

  return { minX, minY, maxX, maxY };
}

export function createTrackBuilderCandidateIndex<TCandidate>(
  candidates: readonly TrackBuilderProjectedCandidate<TCandidate>[],
  radiusPixels: number,
  queryBounds?: TrackBuilderCandidateBounds,
): TrackBuilderCandidateIndex<TCandidate> {
  const cellSize = Math.max(64, radiusPixels * 2);
  const bounds = queryBounds ?? combinedBounds(candidates);
  const gridStartX = Math.floor((bounds.minX - radiusPixels) / cellSize);
  const gridStartY = Math.floor((bounds.minY - radiusPixels) / cellSize);
  const gridEndX = Math.floor((bounds.maxX + radiusPixels) / cellSize);
  const gridEndY = Math.floor((bounds.maxY + radiusPixels) / cellSize);
  const cells = new Map<string, TrackBuilderProjectedCandidate<TCandidate>[]>();

  for (const candidate of candidates) {
    const startX = Math.max(gridStartX, Math.floor((candidate.bounds.minX - radiusPixels) / cellSize));
    const startY = Math.max(gridStartY, Math.floor((candidate.bounds.minY - radiusPixels) / cellSize));
    const endX = Math.min(gridEndX, Math.floor((candidate.bounds.maxX + radiusPixels) / cellSize));
    const endY = Math.min(gridEndY, Math.floor((candidate.bounds.maxY + radiusPixels) / cellSize));

    if (startX > endX || startY > endY) continue;

    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const key = `${x}:${y}`;
        const cell = cells.get(key);

        if (cell) cell.push(candidate);
        else cells.set(key, [candidate]);
      }
    }
  }

  return { candidates, cellSize, cells };
}

export function trackBuilderCandidatesAt<TCandidate>(index: TrackBuilderCandidateIndex<TCandidate>, point: TrackBuilderSelectionPoint): readonly TrackBuilderProjectedCandidate<TCandidate>[] {
  return index.cells.get(`${Math.floor(point[0] / index.cellSize)}:${Math.floor(point[1] / index.cellSize)}`) ?? [];
}

export function closestTrackBuilderProjectedPosition(point: TrackBuilderSelectionPoint, coordinates: readonly TrackBuilderSelectionPoint[], vertexPriorityPixels = 4): TrackBuilderProjectedMatch {
  let best = { position: { segmentIndex: 0, t: 0 }, distance: Number.POSITIVE_INFINITY };

  for (let index = 1; index < coordinates.length; index++) {
    const a = coordinates[index - 1];
    const b = coordinates[index];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator));
    const distance = Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));

    if (distance < best.distance) best = { position: { segmentIndex: index - 1, t }, distance };
  }

  const position = prioritizeTrackBuilderVertexPosition(coordinates, best.position, vertexPriorityPixels);

  if (position.segmentIndex === best.position.segmentIndex && position.t === best.position.t) return best;
  const snapped = interpolatePoint(coordinates, position);

  return { position, distance: Math.hypot(point[0] - snapped[0], point[1] - snapped[1]) };
}

function combinedBounds<TCandidate>(candidates: readonly TrackBuilderProjectedCandidate<TCandidate>[]): TrackBuilderCandidateBounds {
  if (candidates.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  return {
    minX: Math.min(...candidates.map(candidate => candidate.bounds.minX)),
    minY: Math.min(...candidates.map(candidate => candidate.bounds.minY)),
    maxX: Math.max(...candidates.map(candidate => candidate.bounds.maxX)),
    maxY: Math.max(...candidates.map(candidate => candidate.bounds.maxY)),
  };
}

function interpolatePoint(points: readonly TrackBuilderSelectionPoint[], position: TrackBuilderLinePosition): TrackBuilderSelectionPoint {
  const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
  const a = points[index];
  const b = points[index + 1];

  return [a[0] + (b[0] - a[0]) * position.t, a[1] + (b[1] - a[1]) * position.t];
}
