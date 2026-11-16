import { Coordinate, DistanceCalculator } from "places-shared/geo";
import { type Meters, meters } from "places-shared/units";

// - loop: Track starts and ends at approximately the same location, following a circular path
// - out-and-back: Track starts and ends at approximately the same location, retracing the same path
// - point-to-point: Track starts and ends at different locations (one-way route)
export type RouteType = 'loop' | 'out-and-back' | 'point-to-point';

export interface RouteTypeResult {
  type: RouteType;
  // Distance between start and end points in meters
  startEndDistanceM: Meters;
  // Percentage of track that overlaps (0-100), used to distinguish loop from out-and-back
  overlapPercentage: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface RouteTypeOptions {
  // Maximum distance between start and end to consider as closed route (loop or out-and-back). Default: 500m
  closedRouteThresholdM?: Meters;
  // Minimum overlap percentage to classify as out-and-back (vs loop). Default: 50%
  outAndBackOverlapThreshold?: number;
  // Buffer distance in meters for overlap detection. Default: 50m
  overlapBufferM?: Meters;
}

const DEFAULT_OPTIONS: Required<RouteTypeOptions> = {
  closedRouteThresholdM: meters(500),
  outAndBackOverlapThreshold: 50,
  overlapBufferM: meters(50)
};

// 1. If start and end are farther apart than closedRouteThreshold, it is point-to-point.
// 2. Otherwise compare the second half of the track against the first half:
//    high overlap means out-and-back, low overlap means loop.
export function detectRouteType(coordinates: Coordinate[], options?: RouteTypeOptions): RouteTypeResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (coordinates.length < 2) {
    return { type: 'point-to-point', startEndDistanceM: meters(0), overlapPercentage: 0, confidence: 'low' };
  }

  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  const startEndDistanceM = DistanceCalculator.haversineDistanceMeters(start.latitude, start.longitude, end.latitude, end.longitude);

  if (startEndDistanceM > opts.closedRouteThresholdM) {
    return {
      type: 'point-to-point',
      startEndDistanceM,
      overlapPercentage: 0,
      confidence: startEndDistanceM > opts.closedRouteThresholdM * 2 ? 'high' : 'medium'
    };
  }

  const overlapPercentage = calculateTrackOverlap(coordinates, opts.overlapBufferM);

  if (overlapPercentage >= opts.outAndBackOverlapThreshold) {
    return { type: 'out-and-back', startEndDistanceM, overlapPercentage, confidence: overlapPercentage >= 70 ? 'high' : 'medium' };
  }

  return { type: 'loop', startEndDistanceM, overlapPercentage, confidence: overlapPercentage < 30 ? 'high' : 'medium' };
}

// Percentage (0-100) of sampled second-half points that lie within the buffer
// distance of the first half of the track.
function calculateTrackOverlap(coordinates: Coordinate[], bufferM: Meters): number {
  const midpoint = Math.floor(coordinates.length / 2);

  if (midpoint < 5) {
    return 0;
  }

  const firstHalf = coordinates.slice(0, midpoint);
  const secondHalf = coordinates.slice(midpoint);

  const sampleRate = Math.max(1, Math.floor(secondHalf.length / 20));
  let overlappingCount = 0;
  let sampledCount = 0;

  for (let i = 0; i < secondHalf.length; i += sampleRate) {
    const point = secondHalf[i];

    sampledCount++;

    // Check against EVERY first-half point: sampling the first half leaves gaps
    // larger than the buffer on dense tracks, misreading out-and-backs as loops.
    // Cost is bounded by the ~20 second-half samples.
    for (const firstHalfPoint of firstHalf) {
      const distanceM = DistanceCalculator.haversineDistanceMeters(point.latitude, point.longitude, firstHalfPoint.latitude, firstHalfPoint.longitude);

      if (distanceM <= bufferM) {
        overlappingCount++;
        break;
      }
    }
  }

  return sampledCount > 0 ? (overlappingCount / sampledCount) * 100 : 0;
}

export function getRouteTypeLabel(type: RouteType): string {
  switch (type) {
    case 'loop': return 'Loop';
    case 'out-and-back': return 'Out and Back';
    case 'point-to-point': return 'Point to Point';
  }
}
