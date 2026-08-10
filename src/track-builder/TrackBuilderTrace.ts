import type { TrackBuilderLinePosition } from 'places-shared/map';

export interface TrackFeatureTraceRun<TCandidate> {
  readonly candidate: TCandidate;
  start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

export interface InferredFeatureBacktrack {
  readonly repeatedKey: string;
  readonly insertedKeys: readonly string[];
}

export interface RejectedTraceTransition<TCandidate> {
  readonly from: TCandidate;
  readonly to: TCandidate;
  readonly index: number;
}

export interface TrackOverlapSample {
  // Monotonic position along the feature, expressed as segmentIndex + t.
  readonly offset: number;
  // Draft section nearest this sample when it is close enough to count as overlap.
  readonly coveredBy?: string;
}

export interface EndpointOverlapClip {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startTransition?: {
    readonly coveredOffset: number;
    readonly uncoveredOffset: number;
    readonly coveredBy: string;
  };
  readonly endTransition?: {
    readonly uncoveredOffset: number;
    readonly coveredOffset: number;
    readonly coveredBy: string;
  };
}

export interface TrackEndpointContinuation {
  readonly endpoint: 'start' | 'end';
  readonly connection: TrackBuilderLinePosition;
  readonly screenDistancePixels: number;
  readonly geographicDistanceMeters: number;
}

// Pick the route endpoint that actually lies on the clicked feature. Single-click additions can
// grow either side of a draft, and preferring the array tail would make prepended routes impossible
// to continue when the junction falls inside a rendered vector-tile feature.
export function chooseTrackEndpointContinuation<T extends TrackEndpointContinuation>(
  candidates: readonly T[],
  pointerPosition: TrackBuilderLinePosition,
  maximumScreenDistancePixels = 7,
  maximumGeographicDistanceMeters = 20,
): T | undefined {
  return candidates
    .filter(candidate => candidate.screenDistancePixels <= maximumScreenDistancePixels
      && candidate.geographicDistanceMeters <= maximumGeographicDistanceMeters
      && (candidate.connection.segmentIndex !== pointerPosition.segmentIndex
        || Math.abs(candidate.connection.t - pointerPosition.t) >= 1e-9))
    .sort((left, right) => left.screenDistancePixels - right.screenDistancePixels
      || left.geographicDistanceMeters - right.geographicDistanceMeters)[0];
}

// Remove only overlap attached to the ends of a newly selected feature. An isolated covered
// sample in the middle is deliberately retained: it represents a crossing or a point junction,
// not a length of trail that should be removed from the selection.
export function clipEndpointOverlapSamples(samples: readonly TrackOverlapSample[]): EndpointOverlapClip | undefined {
  if (samples.length < 2) return undefined;

  let firstUncovered = 0;
  while (firstUncovered < samples.length && samples[firstUncovered].coveredBy) firstUncovered++;
  if (firstUncovered === samples.length) return undefined;

  let lastUncovered = samples.length - 1;
  while (lastUncovered >= 0 && samples[lastUncovered].coveredBy) lastUncovered--;
  if (firstUncovered > lastUncovered) return undefined;

  const startCovered = firstUncovered > 0 ? samples[firstUncovered - 1] : undefined;
  const endCovered = lastUncovered < samples.length - 1 ? samples[lastUncovered + 1] : undefined;
  return {
    startOffset: samples[firstUncovered].offset,
    endOffset: samples[lastUncovered].offset,
    startTransition: startCovered?.coveredBy ? {
      coveredOffset: startCovered.offset,
      uncoveredOffset: samples[firstUncovered].offset,
      coveredBy: startCovered.coveredBy,
    } : undefined,
    endTransition: endCovered?.coveredBy ? {
      uncoveredOffset: samples[lastUncovered].offset,
      coveredOffset: endCovered.offset,
      coveredBy: endCovered.coveredBy,
    } : undefined,
  };
}

// The longest gap an added feature may bridge onto a nearby draft endpoint.
export const TRACK_BRIDGE_MAX_DISTANCE_METERS = 65;

// A short gap is safe to bridge only when it continues in roughly the same direction.
export function shouldBridgeNearbyTrackEndpoint(
  geographicDistanceMeters: number,
  alignmentCosine: number,
  maximumDistanceMeters = TRACK_BRIDGE_MAX_DISTANCE_METERS,
  minimumAlignmentCosine = 0.5,
): boolean {
  return geographicDistanceMeters <= maximumDistanceMeters && alignmentCosine >= minimumAlignmentCosine;
}

// A vector-tile provider can expose the same physical path under different feature IDs at
// different zooms or tile boundaries. Treat a candidate projected onto the section's source
// line as that source too: dragging an endpoint backward trims instead of appending a
// duplicate run.
export function shouldTrimEndpointToCurrentSource(
  hasMatchingIdentity: boolean,
  screenDistancePixels: number,
  geographicDistanceMeters: number,
  maximumScreenDistancePixels = 2,
  maximumGeographicDistanceMeters = 1,
): boolean {
  return hasMatchingIdentity
    || (screenDistancePixels <= maximumScreenDistancePixels
      && geographicDistanceMeters <= maximumGeographicDistanceMeters);
}

// Resolve a sampled run between its graph junctions without using the drag handle radius as
// geometry. When an out-and-back run enters and leaves through the same junction, retain the
// furthest position reached by the handle center as two legs. A feature merely touched by the
// capture circle contributes no geometry.
export function resolveCenterBasedTraceRun<TCandidate>(
  run: TrackFeatureTraceRun<TCandidate>,
  entry: TrackBuilderLinePosition,
  exit: TrackBuilderLinePosition,
  distance: (a: TrackBuilderLinePosition, b: TrackBuilderLinePosition) => number,
  minimumDistance = 1e-6,
): TrackFeatureTraceRun<TCandidate>[] {
  if (distance(entry, exit) > minimumDistance) return [{ ...run, start: entry, end: exit }];

  const startDistance = distance(entry, run.start);
  const endDistance = distance(entry, run.end);
  const center = startDistance >= endDistance ? run.start : run.end;
  if (Math.max(startDistance, endDistance) <= minimumDistance) return [];
  return [
    { ...run, start: entry, end: center },
    { ...run, start: center, end: exit },
  ];
}

const DEFAULT_PREFERENCE_HYSTERESIS_PIXELS = 1.5;

// Keep the current feature only for a near tie. This prevents adjacent or crossing features from
// flickering without letting an eight-pixel capture radius hide a substantially closer feature.
export function shouldKeepPreferredTrackCandidate(
  preferredDistancePixels: number,
  closestDistancePixels: number,
  maximumDistancePixels: number,
  hysteresisPixels = DEFAULT_PREFERENCE_HYSTERESIS_PIXELS,
): boolean {
  return preferredDistancePixels <= maximumDistancePixels
    && preferredDistancePixels <= closestDistancePixels + hysteresisPixels;
}

// If a drag leaves a feature through a connected chain and later re-enters the same feature from
// a disconnected jump, infer that the pointer retraced the connected chain. The inserted reverse
// runs let junction resolution use real feature intersections instead of leaving a straight gap.
export function expandRepeatedFeatureBacktracks<TCandidate>(
  runs: readonly TrackFeatureTraceRun<TCandidate>[],
  getKey: (candidate: TCandidate) => string,
  areConnected: (left: TCandidate, right: TCandidate) => boolean,
): { runs: TrackFeatureTraceRun<TCandidate>[]; inferred: InferredFeatureBacktrack[] } {
  const expanded: TrackFeatureTraceRun<TCandidate>[] = [];
  const inferred: InferredFeatureBacktrack[] = [];

  for (const sourceRun of runs) {
    const current = { ...sourceRun };
    const previous = expanded[expanded.length - 1];
    if (previous && !areConnected(previous.candidate, current.candidate)) {
      const currentKey = getKey(current.candidate);
      let repeatedIndex = -1;
      for (let index = expanded.length - 2; index >= 0; index--) {
        if (getKey(expanded[index].candidate) !== currentKey) continue;
        let connectedPath = true;
        for (let pathIndex = index + 1; pathIndex < expanded.length; pathIndex++) {
          if (!areConnected(expanded[pathIndex - 1].candidate, expanded[pathIndex].candidate)) {
            connectedPath = false;
            break;
          }
        }
        if (connectedPath) {
          repeatedIndex = index;
          break;
        }
      }

      if (repeatedIndex >= 0) {
        const insertedKeys: string[] = [];
        for (let index = expanded.length - 2; index > repeatedIndex; index--) {
          const outwardRun = expanded[index];
          expanded.push({
            candidate: outwardRun.candidate,
            start: outwardRun.end,
            end: outwardRun.start,
          });
          insertedKeys.push(getKey(outwardRun.candidate));
        }
        inferred.push({ repeatedKey: currentKey, insertedKeys });
      }
    }
    expanded.push(current);
  }

  return { runs: expanded, inferred };
}

// Keep only the contiguous prefix of a sampled drag. Once the pointer jumps to a feature that
// does not meet the current one, later samples cannot silently create a second disconnected run.
export function connectedTracePrefix<TCandidate>(
  runs: readonly TrackFeatureTraceRun<TCandidate>[],
  areConnected: (left: TCandidate, right: TCandidate) => boolean,
): { runs: TrackFeatureTraceRun<TCandidate>[]; rejected?: RejectedTraceTransition<TCandidate> } {
  if (runs.length === 0) return { runs: [] };
  const connected = [{ ...runs[0] }];
  for (let index = 1; index < runs.length; index++) {
    const previous = connected[connected.length - 1];
    const current = runs[index];
    if (!areConnected(previous.candidate, current.candidate)) {
      return { runs: connected, rejected: { from: previous.candidate, to: current.candidate, index } };
    }
    connected.push({ ...current });
  }
  return { runs: connected };
}
