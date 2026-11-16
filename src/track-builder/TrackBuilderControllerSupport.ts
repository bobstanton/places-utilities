import type { TrackBuilderCoordinate, TrackBuilderLinePosition, TrackBuilderSection } from 'places-utilities/core';

export function sectionLogData(section: TrackBuilderSection): Record<string, unknown> {
  return {
    id: section.id,
    sourceFeatureKey: section.sourceFeatureKey,
    layerId: section.layerId,
    sourceLayer: section.sourceLayer,
    featureId: section.featureId,
    name: section.name,
    sourceProperties: section.sourceProperties,
    startPosition: section.startPosition,
    endPosition: section.endPosition,
    coordinates: section.coordinates,
    sourceCoordinates: section.sourceCoordinates,
    breakBefore: section.breakBefore,
  };
}

export function sectionLogSummary(section: TrackBuilderSection): Record<string, unknown> {
  return {
    id: section.id,
    sourceFeatureKey: section.sourceFeatureKey,
    layerId: section.layerId,
    sourceLayer: section.sourceLayer,
    featureId: section.featureId,
    name: section.name,
    startPosition: section.startPosition,
    endPosition: section.endPosition,
    coordinateCount: section.coordinates.length,
    sourceCoordinateCount: section.sourceCoordinates?.length,
    breakBefore: section.breakBefore,
  };
}

export function interpolateLine(coordinates: readonly TrackBuilderCoordinate[], position: TrackBuilderLinePosition): TrackBuilderCoordinate {
  const index = Math.max(0, Math.min(coordinates.length - 2, position.segmentIndex));
  const a = coordinates[index];
  const b = coordinates[index + 1];

  return [a[0] + (b[0] - a[0]) * position.t, a[1] + (b[1] - a[1]) * position.t];
}

export function sliceLine(coordinates: readonly TrackBuilderCoordinate[], start: TrackBuilderLinePosition, end: TrackBuilderLinePosition): TrackBuilderCoordinate[] {
  if (comparePositions(start, end) > 0) return sliceLine(coordinates, end, start).reverse();
  const result: TrackBuilderCoordinate[] = [interpolateLine(coordinates, start)];

  for (let index = start.segmentIndex + 1; index <= end.segmentIndex; index++) {
    const coordinate = coordinates[index];
    const previous = result[result.length - 1];

    if (previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) result.push(coordinate);
  }

  const finalCoordinate = interpolateLine(coordinates, end);
  const previous = result[result.length - 1];

  if (previous[0] !== finalCoordinate[0] || previous[1] !== finalCoordinate[1]) result.push(finalCoordinate);

  return result;
}

export function comparePositions(a: TrackBuilderLinePosition, b: TrackBuilderLinePosition): number {
  return a.segmentIndex - b.segmentIndex || a.t - b.t;
}

export function positionsEqual(a: TrackBuilderLinePosition, b: TrackBuilderLinePosition): boolean {
  return Math.abs((a.segmentIndex + a.t) - (b.segmentIndex + b.t)) < 1e-9;
}

export function coordinateDistanceSquared(a: TrackBuilderCoordinate, b: TrackBuilderCoordinate): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
