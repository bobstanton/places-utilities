import { trackBuilderMetadataAtPosition, type TrackBuilderCoordinate, type TrackBuilderLinePosition, type TrackBuilderPointMetadata, type TrackBuilderSection } from 'places-shared/map';

export interface TrackBuilderMapSnapPoint {
  readonly x: number;
  readonly y: number;
}

export interface TrackBuilderMapSnapMatch<TCandidate> {
  readonly candidate: TCandidate;
  readonly position: TrackBuilderLinePosition;
}

export interface TrackBuilderMapSnapRun<TCandidate> {
  readonly candidate: TCandidate;
  start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

export interface TrackBuilderMapSnapTrace<TCandidate> {
  readonly runs: TrackBuilderMapSnapRun<TCandidate>[];
  readonly matchedSampleCount: number;
  readonly sampleCount: number;
  readonly startMatched: boolean;
  readonly endMatched: boolean;
}

export interface TrackBuilderMapSnapReplacement {
  readonly start: TrackBuilderLinePosition;
  readonly end: TrackBuilderLinePosition;
  readonly mappedSections: readonly TrackBuilderSection[];
}

export interface TrackBuilderRecordingGap {
  readonly start: TrackBuilderLinePosition;
  readonly end: TrackBuilderLinePosition;
  readonly elapsedSeconds: number;
  readonly directDistanceMeters: number;
}

// Find timestamp jumps that also moved far enough to represent missing recording geometry.
export function findTrackBuilderRecordingGaps(
  section: TrackBuilderSection,
  minimumElapsedSeconds = 60,
  minimumDirectDistanceMeters = 100,
): TrackBuilderRecordingGap[] {
  const coordinates = section.sourceCoordinates ?? section.coordinates;
  const metadata = section.sourcePointMetadata ?? section.pointMetadata;
  if (!metadata || metadata.length !== coordinates.length) return [];
  const gaps: TrackBuilderRecordingGap[] = [];
  for (let index = 0; index < coordinates.length - 1; index++) {
    const startTime = metadata[index]?.time ? Date.parse(metadata[index]!.time!) : Number.NaN;
    const endTime = metadata[index + 1]?.time ? Date.parse(metadata[index + 1]!.time!) : Number.NaN;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue;
    const elapsedSeconds = (endTime - startTime) / 1000;
    const directDistanceMeters = geographicDistanceMeters(coordinates[index], coordinates[index + 1]);
    if (elapsedSeconds < minimumElapsedSeconds || directDistanceMeters < minimumDirectDistanceMeters) continue;
    gaps.push({
      start: { segmentIndex: index, t: 0 },
      end: { segmentIndex: index, t: 1 },
      elapsedSeconds,
      directDistanceMeters,
    });
  }
  return gaps.sort((left, right) => right.elapsedSeconds - left.elapsedSeconds);
}

// Replay a screen-space line as if the pointer had been dragged over the map.
// Candidate lookup and connectivity use the same rendered-feature rules as the
// interactive track builder, while this helper owns deterministic sampling.
export function traceTrackBuilderMapPath<TCandidate>(
  points: readonly TrackBuilderMapSnapPoint[],
  findMatch: (point: TrackBuilderMapSnapPoint, preferred?: TCandidate) => TrackBuilderMapSnapMatch<TCandidate> | undefined,
  getCandidateKey: (candidate: TCandidate) => string,
  areConnected: (left: TCandidate, right: TCandidate) => boolean,
  sampleSpacingPixels = 3,
): TrackBuilderMapSnapTrace<TCandidate> {
  if (points.length < 2) {
    return { runs: [], matchedSampleCount: 0, sampleCount: 0, startMatched: false, endMatched: false };
  }

  const samples: TrackBuilderMapSnapPoint[] = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const count = Math.max(1, Math.ceil(distance / Math.max(1, sampleSpacingPixels)));
    for (let sampleIndex = 1; sampleIndex <= count; sampleIndex++) {
      const fraction = sampleIndex / count;
      samples.push({
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
      });
    }
  }

  const runs: TrackBuilderMapSnapRun<TCandidate>[] = [];
  let matchedSampleCount = 0;
  let startMatched = false;
  let endMatched = false;
  for (let index = 0; index < samples.length; index++) {
    const last = runs[runs.length - 1];
    const match = findMatch(samples[index], last?.candidate);
    if (!match) continue;

    const sameCandidate = last && getCandidateKey(last.candidate) === getCandidateKey(match.candidate);
    const accepted = !last || sameCandidate || areConnected(last.candidate, match.candidate);
    if (!accepted) continue;

    matchedSampleCount++;
    if (index === 0) startMatched = true;
    if (index === samples.length - 1) endMatched = true;
    if (sameCandidate) {
      last.end = match.position;
    } else {
      runs.push({ candidate: match.candidate, start: match.position, end: match.position });
    }
  }

  return { runs, matchedSampleCount, sampleCount: samples.length, startMatched, endMatched };
}

// The feature identities and full source geometry are retained, and subsequent
// endpoint editing behaves exactly like manually drawn sections.
export function replaceTrackBuilderRangeWithMapSections(
  sections: readonly TrackBuilderSection[],
  sectionId: string,
  start: TrackBuilderLinePosition,
  end: TrackBuilderLinePosition,
  mappedSections: readonly TrackBuilderSection[],
  nonce = `${Date.now()}`,
): TrackBuilderSection[] {
  const sectionIndex = sections.findIndex(section => section.id === sectionId);
  if (sectionIndex < 0 || mappedSections.length === 0) return [...sections];
  const section = sections[sectionIndex];
  const source = section.sourceCoordinates ?? section.coordinates;
  if (source.length < 2) return [...sections];

  const originalStart = section.startPosition ?? { segmentIndex: 0, t: 0 };
  const originalEnd = section.endPosition ?? { segmentIndex: source.length - 2, t: 1 };
  const low = comparePositions(start, end) <= 0 ? start : end;
  const high = comparePositions(start, end) <= 0 ? end : start;
  const forward = comparePositions(originalStart, originalEnd) <= 0;
  const selectedStart = forward ? low : high;
  const selectedEnd = forward ? high : low;
  if (positionsEqual(selectedStart, selectedEnd)) return [...sections];

  const beforeExists = !positionsEqual(originalStart, selectedStart);
  const afterExists = !positionsEqual(selectedEnd, originalEnd);
  const selectedInput = sliceLine(source, selectedStart, selectedEnd);
  const previousCoordinates = sections[sectionIndex - 1]?.coordinates;
  const previousEndpoint = previousCoordinates?.[previousCoordinates.length - 1];
  const nextSection = sections[sectionIndex + 1];
  const nextEndpoint = nextSection?.coordinates[0];
  const connectedBefore = !section.breakBefore && previousEndpoint !== undefined && coordinatesEqual(previousEndpoint, selectedInput[0]);
  const connectedAfter = nextSection !== undefined && !nextSection.breakBefore && nextEndpoint !== undefined
    && coordinatesEqual(nextEndpoint, selectedInput[selectedInput.length - 1]);

  const mapped = mappedSections.map((candidate, index): TrackBuilderSection => ({
    ...candidate,
    id: `${candidate.id}:map-snap:${nonce}:${index}`,
    sourceProperties: {
      ...candidate.sourceProperties,
      routingMode: 'mapped',
      snapSource: 'rendered-map',
    },
    coordinates: [...candidate.coordinates],
    breakBefore: index === 0 ? (beforeExists ? false : section.breakBefore) : false,
  }));

  if (beforeExists || connectedBefore) {
    const first = mapped[0];
    const coordinates = [...first.coordinates];
    coordinates[0] = selectedInput[0];
    mapped[0] = { ...first, coordinates, startCoordinateOverride: selectedInput[0] };
  }
  if (afterExists || connectedAfter) {
    const lastIndex = mapped.length - 1;
    const last = mapped[lastIndex];
    const coordinates = [...last.coordinates];
    coordinates[coordinates.length - 1] = selectedInput[selectedInput.length - 1];
    mapped[lastIndex] = { ...last, coordinates, endCoordinateOverride: selectedInput[selectedInput.length - 1] };
  }
  applyReplacementMetadata(mapped, section, selectedStart, selectedEnd);

  const replacements: TrackBuilderSection[] = [];
  if (beforeExists) replacements.push(piece(section, source, originalStart, selectedStart, `map-snap-before:${nonce}`, section.breakBefore));
  replacements.push(...mapped);
  if (afterExists) replacements.push(piece(section, source, selectedEnd, originalEnd, `map-snap-after:${nonce}`, false));

  const next = [...sections];
  next.splice(sectionIndex, 1, ...replacements);
  return next;
}

function applyReplacementMetadata(
  mapped: TrackBuilderSection[],
  sourceSection: TrackBuilderSection,
  start: TrackBuilderLinePosition,
  end: TrackBuilderLinePosition,
): void {
  const sourceMetadata = sourceSection.sourcePointMetadata
    ?? (sourceSection.pointMetadata?.length === (sourceSection.sourceCoordinates ?? sourceSection.coordinates).length
      ? sourceSection.pointMetadata
      : undefined);
  if (!sourceMetadata) return;
  const startMetadata = trackBuilderMetadataAtPosition(sourceMetadata, start);
  const endMetadata = trackBuilderMetadataAtPosition(sourceMetadata, end);
  if (!startMetadata && !endMetadata) return;

  const cumulative: number[][] = [];
  let total = 0;
  let previous: TrackBuilderCoordinate | undefined;
  for (const section of mapped) {
    const sectionDistances: number[] = [];
    for (const coordinate of section.coordinates) {
      if (previous) total += geographicDistanceMeters(previous, coordinate);
      sectionDistances.push(total);
      previous = coordinate;
    }
    cumulative.push(sectionDistances);
  }
  const startTime = startMetadata?.time ? Date.parse(startMetadata.time) : Number.NaN;
  const endTime = endMetadata?.time ? Date.parse(endMetadata.time) : Number.NaN;
  const interpolate = (offset: number): TrackBuilderPointMetadata | undefined => {
    const fraction = total > 0 ? offset / total : 0;
    const time = Number.isFinite(startTime) && Number.isFinite(endTime)
      ? new Date(startTime + (endTime - startTime) * fraction).toISOString()
      : undefined;
    const elevationMeters = startMetadata?.elevationMeters !== undefined && endMetadata?.elevationMeters !== undefined
      ? startMetadata.elevationMeters + (endMetadata.elevationMeters - startMetadata.elevationMeters) * fraction
      : undefined;
    return time || elevationMeters !== undefined ? { time, elevationMeters } : undefined;
  };

  for (let sectionIndex = 0; sectionIndex < mapped.length; sectionIndex++) {
    const section = mapped[sectionIndex];
    const pointMetadata = cumulative[sectionIndex].map(interpolate);
    if (sectionIndex === 0 && pointMetadata.length > 0) pointMetadata[0] = startMetadata;
    if (sectionIndex === mapped.length - 1 && pointMetadata.length > 0) pointMetadata[pointMetadata.length - 1] = endMetadata;
    mapped[sectionIndex] = { ...section, pointMetadata };
  }
}

function geographicDistanceMeters(a: TrackBuilderCoordinate, b: TrackBuilderCoordinate): number {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLon = (b[0] - a[0]) * radians;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

// Replace disjoint ranges from one source section. Ranges are applied from the
// route end toward its start: each earlier range remains on an untouched
// source-backed piece even after the later replacement splits the section.
export function replaceTrackBuilderRangesWithMapSections(
  sections: readonly TrackBuilderSection[],
  sectionId: string,
  replacements: readonly TrackBuilderMapSnapReplacement[],
  nonce = `${Date.now()}`,
): TrackBuilderSection[] {
  const original = sections.find(section => section.id === sectionId);
  if (!original || replacements.length === 0) return [...sections];
  const source = original.sourceCoordinates ?? original.coordinates;
  const originalStart = original.startPosition ?? { segmentIndex: 0, t: 0 };
  const originalEnd = original.endPosition ?? { segmentIndex: source.length - 2, t: 1 };
  const forward = comparePositions(originalStart, originalEnd) <= 0;
  const ordered = [...replacements]
    .filter(replacement => replacement.mappedSections.length > 0 && !positionsEqual(replacement.start, replacement.end))
    .sort((left, right) => {
      const leftOffset = Math.min(positionOffset(left.start), positionOffset(left.end));
      const rightOffset = Math.min(positionOffset(right.start), positionOffset(right.end));
      return forward ? rightOffset - leftOffset : leftOffset - rightOffset;
    });

  let next = [...sections];
  for (let index = 0; index < ordered.length; index++) {
    const replacement = ordered[index];
    const low = comparePositions(replacement.start, replacement.end) <= 0 ? replacement.start : replacement.end;
    const high = comparePositions(replacement.start, replacement.end) <= 0 ? replacement.end : replacement.start;
    const target = next.find(candidate => {
      if (candidate.id !== sectionId && candidate.sourceCoordinates !== source) return false;
      const candidateStart = candidate.startPosition ?? { segmentIndex: 0, t: 0 };
      const candidateEnd = candidate.endPosition ?? { segmentIndex: source.length - 2, t: 1 };
      const candidateLow = comparePositions(candidateStart, candidateEnd) <= 0 ? candidateStart : candidateEnd;
      const candidateHigh = comparePositions(candidateStart, candidateEnd) <= 0 ? candidateEnd : candidateStart;
      return comparePositions(candidateLow, low) <= 0 && comparePositions(high, candidateHigh) <= 0;
    });
    if (!target) return [...sections];
    next = replaceTrackBuilderRangeWithMapSections(
      next,
      target.id,
      replacement.start,
      replacement.end,
      replacement.mappedSections,
      `${nonce}:${index}`,
    );
  }
  return next;
}

function piece(section: TrackBuilderSection, source: readonly TrackBuilderCoordinate[], start: TrackBuilderLinePosition, end: TrackBuilderLinePosition, suffix: string, breakBefore: boolean | undefined): TrackBuilderSection {
  const coordinates = sliceLine(source, start, end);
  const preserveStart = section.startPosition && positionsEqual(start, section.startPosition) ? section.startCoordinateOverride : undefined;
  const preserveEnd = section.endPosition && positionsEqual(end, section.endPosition) ? section.endCoordinateOverride : undefined;
  if (preserveStart) coordinates[0] = preserveStart;
  if (preserveEnd) coordinates[coordinates.length - 1] = preserveEnd;
  return {
    ...section,
    id: `${section.id}:${suffix}`,
    coordinates,
    sourceCoordinates: source,
    startPosition: start,
    endPosition: end,
    startCoordinateOverride: preserveStart,
    endCoordinateOverride: preserveEnd,
    breakBefore,
  };
}

function sliceLine(
  coordinates: readonly TrackBuilderCoordinate[],
  start: TrackBuilderLinePosition,
  end: TrackBuilderLinePosition,
): TrackBuilderCoordinate[] {
  if (comparePositions(start, end) > 0) return sliceLine(coordinates, end, start).reverse();
  const result: TrackBuilderCoordinate[] = [interpolateLine(coordinates, start)];
  for (let index = start.segmentIndex + 1; index <= end.segmentIndex; index++) {
    const coordinate = coordinates[index];
    const previous = result[result.length - 1];
    if (!coordinatesEqual(previous, coordinate)) result.push(coordinate);
  }
  const finalCoordinate = interpolateLine(coordinates, end);
  if (!coordinatesEqual(result[result.length - 1], finalCoordinate)) result.push(finalCoordinate);
  return result;
}

function interpolateLine(coordinates: readonly TrackBuilderCoordinate[], position: TrackBuilderLinePosition): TrackBuilderCoordinate {
  const index = Math.max(0, Math.min(coordinates.length - 2, position.segmentIndex));
  const a = coordinates[index];
  const b = coordinates[index + 1];
  return [a[0] + (b[0] - a[0]) * position.t, a[1] + (b[1] - a[1]) * position.t];
}

function comparePositions(a: TrackBuilderLinePosition, b: TrackBuilderLinePosition): number {
  return a.segmentIndex - b.segmentIndex || a.t - b.t;
}

function positionOffset(position: TrackBuilderLinePosition): number {
  return position.segmentIndex + position.t;
}

function positionsEqual(a: TrackBuilderLinePosition, b: TrackBuilderLinePosition): boolean {
  return a.segmentIndex === b.segmentIndex && Math.abs(a.t - b.t) < 1e-9;
}

function coordinatesEqual(a: TrackBuilderCoordinate, b: TrackBuilderCoordinate): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}
