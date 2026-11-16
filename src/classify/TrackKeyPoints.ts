import { Coordinate, DistanceCalculator } from "places-shared/geo";
import { TrackPoint } from "places-shared/geo";

// Pure geometry analysis of a track's structurally interesting points:
// turnarounds (direction reversals / farthest-from-start maxima), dwells
// (clusters where time was spent), and the summit. These are the points worth
// asking "what is here?" - everything else along the track is corridor.

export interface DwellPoint {
  index: number;
  durationSeconds: number;
  centerCoord: Coordinate;
}

// Find turnaround points by locating local maxima of distance-from-start and
// sharp heading reversals (>120°). Returns coordinate indices ordered by
// significance, separated by at least 15% of the track length.
export function findTurnaroundIndices(coordinates: Coordinate[]): number[] {
  if (coordinates.length < 10) {
    return [Math.floor(coordinates.length / 2)];
  }

  const distancesFromStart: number[] = [0];

  for (let i = 1; i < coordinates.length; i++) {
    distancesFromStart.push(DistanceCalculator.haversineDistanceMeters(coordinates[0].latitude, coordinates[0].longitude, coordinates[i].latitude, coordinates[i].longitude));
  }

  const windowSize = Math.max(5, Math.floor(coordinates.length * 0.05));
  const candidates: Array<{ index: number; score: number }> = [];

  for (let i = windowSize; i < coordinates.length - windowSize; i++) {
    const currentDist = distancesFromStart[i];

    let isLocalMax = true;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j !== i && distancesFromStart[j] > currentDist) {
        isLocalMax = false;
        break;
      }
    }

    if (isLocalMax && currentDist > 100) {
      const headingChange = calculateHeadingChange(coordinates, i, windowSize);

      candidates.push({ index: i, score: currentDist * (1 + headingChange / 180) });
    }
  }

  for (let i = windowSize; i < coordinates.length - windowSize; i++) {
    const headingChange = calculateHeadingChange(coordinates, i, windowSize);

    if (headingChange > 120) {
      const alreadyFound = candidates.some(c => Math.abs(c.index - i) < windowSize * 2);

      if (!alreadyFound) {
        candidates.push({ index: i, score: distancesFromStart[i] * (1 + headingChange / 180) });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const result: number[] = [];
  const minSeparation = Math.floor(coordinates.length * 0.15);

  for (const candidate of candidates) {
    const tooClose = result.some(idx => Math.abs(candidate.index - idx) < minSeparation);

    if (!tooClose) {
      result.push(candidate.index);
    }
  }

  if (result.length === 0) {
    result.push(Math.floor(coordinates.length / 2));
  }

  return result;
}

// Find dwell clusters: runs of points within 50m of a moving center lasting at
// least minDwellSeconds. Dwells in the first/last 5% of the track are dropped
// (usually recording start/stop). Sorted longest first.
export function findDwellPoints(points: TrackPoint[], minDwellSeconds = 60): DwellPoint[] {
  if (points.length < 3 || points.some(p => !p.time)) {
    return [];
  }

  const dwellPoints: DwellPoint[] = [];
  const DWELL_RADIUS_METERS = 50;

  let dwellStart = 0;
  let centerLat = points[0].latitude;
  let centerLng = points[0].longitude;
  let pointsInDwell = 1;

  const closeCluster = (endIndex: number) => {
    const durationSeconds = (points[endIndex].time!.getTime() - points[dwellStart].time!.getTime()) / 1000;

    if (durationSeconds >= minDwellSeconds && pointsInDwell >= 3) {
      dwellPoints.push({
        index: Math.floor((dwellStart + endIndex) / 2),
        durationSeconds,
        centerCoord: { latitude: centerLat, longitude: centerLng }
      });
    }
  };

  for (let i = 1; i < points.length; i++) {
    const distFromCenter = DistanceCalculator.haversineDistanceMeters(centerLat, centerLng, points[i].latitude, points[i].longitude);

    if (distFromCenter <= DWELL_RADIUS_METERS) {
      pointsInDwell++;
      centerLat = (centerLat * (pointsInDwell - 1) + points[i].latitude) / pointsInDwell;
      centerLng = (centerLng * (pointsInDwell - 1) + points[i].longitude) / pointsInDwell;
    } else {
      closeCluster(i - 1);
      dwellStart = i;
      centerLat = points[i].latitude;
      centerLng = points[i].longitude;
      pointsInDwell = 1;
    }
  }

  closeCluster(points.length - 1);

  const minIdx = Math.floor(points.length * 0.05);
  const maxIdx = Math.floor(points.length * 0.95);

  return dwellPoints
    .filter(d => d.index >= minIdx && d.index <= maxIdx)
    .sort((a, b) => b.durationSeconds - a.durationSeconds);
}

// Index of the highest point, or -1 when no elevations are present.
export function findSummitIndex(points: TrackPoint[]): number {
  let maxIdx = -1;
  let maxElev = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const elev = points[i].elevationMeters;

    if (elev !== undefined && (elev as number) > maxElev) {
      maxElev = elev;
      maxIdx = i;
    }
  }

  return maxIdx;
}

// The coordinates worth running containment (is_in) queries at: track center,
// the most significant turnaround, and the longest dwell. Deduplicated within
// 200m of each other, capped at 3 to bound API calls.
export function containmentQueryPoints(points: TrackPoint[]): Coordinate[] {
  if (points.length === 0) return [];

  const coordinates = points.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
  const candidates: Coordinate[] = [coordinates[Math.floor(coordinates.length / 2)]];

  const turnarounds = findTurnaroundIndices(coordinates);

  if (turnarounds.length > 0) {
    candidates.push(coordinates[turnarounds[0]]);
  }

  const dwells = findDwellPoints(points);

  if (dwells.length > 0) {
    candidates.push(dwells[0].centerCoord);
  }

  const result: Coordinate[] = [];

  for (const candidate of candidates) {
    const nearExisting = result.some(existing => DistanceCalculator.haversineDistanceMeters(existing.latitude, existing.longitude, candidate.latitude, candidate.longitude) < 200);

    if (!nearExisting) {
      result.push(candidate);
    }
  }

  return result.slice(0, 3);
}

function calculateHeadingChange(coordinates: Coordinate[], index: number, windowSize: number): number {
  const beforeIdx = Math.max(0, index - windowSize);
  const afterIdx = Math.min(coordinates.length - 1, index + windowSize);

  const headingBefore = calculateBearing(coordinates[beforeIdx], coordinates[index]);
  const headingAfter = calculateBearing(coordinates[index], coordinates[afterIdx]);

  let change = Math.abs(headingAfter - headingBefore);

  if (change > 180) {
    change = 360 - change;
  }

  return change;
}

function calculateBearing(from: Coordinate, to: Coordinate): number {
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const dLon = (to.longitude - from.longitude) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  const bearing = Math.atan2(y, x) * 180 / Math.PI;

  return (bearing + 360) % 360;
}
