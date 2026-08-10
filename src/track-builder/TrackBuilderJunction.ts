import type { TrackBuilderCoordinate, TrackBuilderLinePosition, TrackBuilderSection } from 'places-shared/map';
import type { TrackBuilderSelectionPoint } from './TrackBuilderSelection';

export interface TrackBuilderJunctionConnection {
  readonly a: TrackBuilderLinePosition;
  readonly b: TrackBuilderLinePosition;
  readonly screenDistancePixels: number;
  readonly geographicDistanceMeters: number;
}

export function closestCompatibleTrackBuilderJunction(
  a: TrackBuilderSection,
  b: TrackBuilderSection,
  project: (coordinate: TrackBuilderCoordinate) => TrackBuilderSelectionPoint,
  geographicDistance: (a: TrackBuilderCoordinate, b: TrackBuilderCoordinate) => number,
  maximumScreenDistancePixels = 10,
  maximumGeographicDistanceMeters = 12,
  respectGradeSeparation = true,
): TrackBuilderJunctionConnection | undefined {
  return compatibleTrackBuilderJunctions(
    a,
    b,
    project,
    geographicDistance,
    maximumScreenDistancePixels,
    maximumGeographicDistanceMeters,
    respectGradeSeparation,
  )[0];
}

// Return every compatible rendered-feature endpoint junction, nearest first.
export function compatibleTrackBuilderJunctions(
  a: TrackBuilderSection,
  b: TrackBuilderSection,
  project: (coordinate: TrackBuilderCoordinate) => TrackBuilderSelectionPoint,
  geographicDistance: (a: TrackBuilderCoordinate, b: TrackBuilderCoordinate) => number,
  maximumScreenDistancePixels = 10,
  maximumGeographicDistanceMeters = 12,
  respectGradeSeparation = true,
): TrackBuilderJunctionConnection[] {
  if (respectGradeSeparation && !areTrackBuilderJunctionSectionsCompatible(a, b)) return [];
  const aCoordinates = a.sourceCoordinates ?? a.coordinates;
  const bCoordinates = b.sourceCoordinates ?? b.coordinates;
  const junctions: TrackBuilderJunctionConnection[] = [];

  for (let aIndex = 0; aIndex < aCoordinates.length; aIndex++) {
    for (let bIndex = 0; bIndex < bCoordinates.length; bIndex++) {
      if (!isLineEndpoint(aIndex, aCoordinates.length) && !isLineEndpoint(bIndex, bCoordinates.length)) continue;
      const aCoordinate = aCoordinates[aIndex];
      const bCoordinate = bCoordinates[bIndex];
      const aPoint = project(aCoordinate);
      const bPoint = project(bCoordinate);
      const screenDistancePixels = Math.hypot(aPoint[0] - bPoint[0], aPoint[1] - bPoint[1]);
      if (screenDistancePixels > maximumScreenDistancePixels) continue;
      const geographicDistanceMeters = geographicDistance(aCoordinate, bCoordinate);
      if (geographicDistanceMeters > maximumGeographicDistanceMeters) continue;
      const candidate = {
        a: vertexPosition(aIndex, aCoordinates.length),
        b: vertexPosition(bIndex, bCoordinates.length),
        screenDistancePixels,
        geographicDistanceMeters,
      };
      junctions.push(candidate);
    }
  }

  return junctions.sort((left, right) => left.screenDistancePixels - right.screenDistancePixels
    || left.geographicDistanceMeters - right.geographicDistanceMeters);
}

export function areTrackBuilderJunctionSectionsCompatible(a: TrackBuilderSection, b: TrackBuilderSection): boolean {
  // Imported tracks carry no grade-separation metadata; treat them as compatible.
  if (!a.sourceLayer || !b.sourceLayer) return true;
  const aGrade = grade(a.sourceProperties);
  const bGrade = grade(b.sourceProperties);
  return aGrade.structure === bGrade.structure
    && aGrade.layer === bGrade.layer
    && (aGrade.level === undefined || bGrade.level === undefined || aGrade.level === bGrade.level);
}

function grade(properties: TrackBuilderSection['sourceProperties']): {
  readonly structure: 'ground' | 'bridge' | 'tunnel';
  readonly layer: string;
  readonly level?: string;
} {
  const brunnel = normalized(properties?.brunnel);
  const structure = brunnel === 'bridge' || truthy(properties?.bridge)
    ? 'bridge'
    : brunnel === 'tunnel' || truthy(properties?.tunnel)
      ? 'tunnel'
      : 'ground';
  return {
    structure,
    layer: normalized(properties?.layer) ?? '0',
    level: normalized(properties?.level),
  };
}

function normalized(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).trim().toLowerCase();
  return undefined;
}

function truthy(value: unknown): boolean {
  const normalizedValue = normalized(value);
  return normalizedValue !== undefined && normalizedValue !== '0' && normalizedValue !== 'false' && normalizedValue !== 'no';
}

function isLineEndpoint(index: number, length: number): boolean {
  return index === 0 || index === length - 1;
}

function vertexPosition(index: number, length: number): TrackBuilderLinePosition {
  return index === length - 1
    ? { segmentIndex: Math.max(0, index - 1), t: 1 }
    : { segmentIndex: index, t: 0 };
}
