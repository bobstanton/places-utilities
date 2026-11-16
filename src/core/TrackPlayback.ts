import type { TrackPoint } from 'places-shared/geo';

export interface IndexedPoint {
  latitude: number;
  longitude: number;
  distanceMeters: number;
  segmentIndex: number;
  timestampMs?: number;
}

export interface PlaybackPosition {
  longitude: number;
  latitude: number;
  bearing: number;
  segmentIndex?: number;
}

export interface SmoothedCameraPosition extends PlaybackPosition {
  updatedAt: number;
}

export function smoothCameraPosition(previous: SmoothedCameraPosition | undefined, target: PlaybackPosition, time: number, smoothingSeconds: number): SmoothedCameraPosition {
  if (!previous || smoothingSeconds <= 0 || time <= previous.updatedAt) return { ...target, updatedAt: time };
  const elapsedSeconds = Math.min(0.25, (time - previous.updatedAt) / 1000);
  const amount = 1 - Math.exp(-elapsedSeconds / smoothingSeconds);

  return {
    latitude: previous.latitude + (target.latitude - previous.latitude) * amount,
    longitude: interpolateWrappedDegrees(previous.longitude, target.longitude, amount),
    bearing: interpolateWrappedDegrees(previous.bearing, target.bearing, amount),
    segmentIndex: target.segmentIndex,
    updatedAt: time,
  };
}

function interpolateWrappedDegrees(from: number, to: number, amount: number): number {
  const delta = ((to - from + 540) % 360) - 180;

  return from + delta * amount;
}

export function indexTrackSegments(segments: readonly (readonly TrackPoint[])[]): IndexedPoint[] {
  const indexed: IndexedPoint[] = [];
  let total = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];

    for (let pointIndex = 0; pointIndex < segment.length; pointIndex++) {
      const point = segment[pointIndex];
      const previous = indexed[indexed.length - 1];

      if (previous && pointIndex > 0) total += haversineMeters(previous.latitude, previous.longitude, point.latitude, point.longitude);
      const timestampMs = point.time?.getTime();

      indexed.push({
        latitude: point.latitude,
        longitude: point.longitude,
        distanceMeters: total,
        segmentIndex,
        ...(timestampMs !== undefined && Number.isFinite(timestampMs) ? { timestampMs } : {}),
      });
    }
  }

  return indexed;
}

export function playbackPositionAt(points: readonly IndexedPoint[], total: number, progress: number, lookAheadMeters: number, useTimestamps = hasUsablePlaybackTimestamps(points)): PlaybackPosition | undefined {
  if (points.length < 2) return undefined;
  const distance = useTimestamps ? playbackDistanceAtProgress(points, total, progress, true) : total * progress;
  const current = coordinateAtDistance(points, distance);
  const lookAhead = Math.max(1, lookAheadMeters);
  const bounds = segmentDistanceBounds(points, current.segmentIndex ?? 0);
  const compareForward = distance < bounds.end;
  const comparison = compareForward
    ? coordinateAtDistance(points, Math.min(bounds.end, distance + lookAhead))
    : coordinateAtDistance(points, Math.max(bounds.start, distance - lookAhead));
  const routeBearing = compareForward
    ? bearing(current.latitude, current.longitude, comparison.latitude, comparison.longitude)
    : bearing(comparison.latitude, comparison.longitude, current.latitude, current.longitude);

  return { ...current, bearing: routeBearing };
}

export function nearestProgress(points: readonly IndexedPoint[], latitude: number, longitude: number, total: number): number {
  if (points.length === 0 || total <= 0) return 0;
  let bestDistanceAlongTrack = points[0].distanceMeters;
  let bestTimestamp = points[0].timestampMs;
  let bestDistance = Number.POSITIVE_INFINITY;
  const scaleX = Math.cos(latitude * Math.PI / 180);

  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[index + 1];

    if (!end || start.segmentIndex !== end.segmentIndex) {
      const distance = Math.hypot((start.longitude - longitude) * scaleX, start.latitude - latitude);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestDistanceAlongTrack = start.distanceMeters;
        bestTimestamp = start.timestampMs;
      }

      continue;
    }

    const ax = (start.longitude - longitude) * scaleX;
    const ay = start.latitude - latitude;
    const dx = (end.longitude - start.longitude) * scaleX;
    const dy = end.latitude - start.latitude;
    const denominator = dx * dx + dy * dy;
    const ratio = denominator > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
    const distance = Math.hypot(ax + ratio * dx, ay + ratio * dy);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestDistanceAlongTrack = start.distanceMeters + (end.distanceMeters - start.distanceMeters) * ratio;
      bestTimestamp = start.timestampMs !== undefined && end.timestampMs !== undefined
        ? start.timestampMs + (end.timestampMs - start.timestampMs) * ratio
        : undefined;
    }
  }

  return Math.max(0, Math.min(1, bestTimestamp !== undefined && hasUsablePlaybackTimestamps(points)
    ? (bestTimestamp - points[0].timestampMs!) / (points[points.length - 1].timestampMs! - points[0].timestampMs!)
    : bestDistanceAlongTrack / total));
}

export function playbackLabel(points: readonly IndexedPoint[], progress: number, useTimestamps = hasUsablePlaybackTimestamps(points)): string {
  if (useTimestamps) {
    const first = points[0].timestampMs!;
    const last = points[points.length - 1].timestampMs!;

    return new Date(first + (last - first) * progress).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
  }

  return `${Math.round(progress * 100)}%`;
}

export function playbackDistanceAtProgress(points: readonly IndexedPoint[], total: number, progress: number, timestampsValidated = false): number {
  if (!timestampsValidated && !hasUsablePlaybackTimestamps(points)) return total * progress;
  const firstTime = points[0].timestampMs!;
  const lastTime = points[points.length - 1].timestampMs!;

  const targetTime = firstTime + (lastTime - firstTime) * Math.max(0, Math.min(1, progress));
  let low = 1;
  let high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].timestampMs! < targetTime) low = mid + 1;
    else high = mid;
  }

  const end = points[low];
  const start = points[low - 1];
  const timeSpan = end.timestampMs! - start.timestampMs!;
  const ratio = timeSpan > 0 ? (targetTime - start.timestampMs!) / timeSpan : 1;

  return start.distanceMeters + (end.distanceMeters - start.distanceMeters) * ratio;
}

export function hasUsablePlaybackTimestamps(points: readonly IndexedPoint[]): boolean {
  const firstTime = points[0]?.timestampMs;
  const lastTime = points[points.length - 1]?.timestampMs;

  if (firstTime === undefined || lastTime === undefined || lastTime <= firstTime) return false;
  let previousTime = firstTime;

  for (let index = 1; index < points.length; index++) {
    const timestamp = points[index].timestampMs;

    if (timestamp === undefined || timestamp <= previousTime) return false;
    previousTime = timestamp;
  }

  return true;
}

function coordinateAtDistance(points: readonly IndexedPoint[], distance: number): { latitude: number; longitude: number; segmentIndex: number } {
  let low = 1;
  let high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].distanceMeters < distance) low = mid + 1;
    else high = mid;
  }

  const end = points[low];
  const start = points[Math.max(0, low - 1)];

  if (start.segmentIndex !== end.segmentIndex) {
    return { latitude: end.latitude, longitude: end.longitude, segmentIndex: end.segmentIndex };
  }

  const span = end.distanceMeters - start.distanceMeters;
  const ratio = span > 0 ? (distance - start.distanceMeters) / span : 0;

  return {
    latitude: start.latitude + (end.latitude - start.latitude) * ratio,
    longitude: start.longitude + (end.longitude - start.longitude) * ratio,
    segmentIndex: end.segmentIndex,
  };
}

function segmentDistanceBounds(points: readonly IndexedPoint[], segmentIndex: number): { start: number; end: number } {
  let low = 0;
  let high = points.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].segmentIndex < segmentIndex) low = mid + 1;
    else high = mid;
  }

  const start = points[low].distanceMeters;

  high = points.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].segmentIndex <= segmentIndex) low = mid + 1;
    else high = mid;
  }

  return { start, end: points[low - 1].distanceMeters };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;

  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);

  return (Math.atan2(y, x) / rad + 360) % 360;
}
