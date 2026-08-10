import { Coordinate, DistanceCalculator } from "places-shared/geo";
import { logger as rootLogger } from "places-shared/utils";
import { CANDIDATE_KIND_ICONS, CandidateKind, FeatureCandidate } from "./ClassifyTypes";
import { OverpassRateLimiter } from "./OverpassRateLimiter";

const logger = rootLogger.scope('OverpassTrackService');

// Spacing for the corridor polyline sent to Overpass; caps query size while keeping coverage.
const CORRIDOR_SAMPLE_METERS = 120;
const CORRIDOR_MAX_POINTS = 200;
// Water bodies are landscape-scale landmarks; they get a wider corridor than shops and POIs.
const WATER_RADIUS_METERS = 500;

interface OverpassElement {
  type: 'node' | 'way' | 'relation' | 'area';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

// Finds named OSM features along a track using two Overpass primitives that
// run against real geometry instead of tile label points:
// - `around:` with a linestring finds features within a corridor of the whole track in one query
// - `is_in()` finds named areas (lakes, parks, reserves) CONTAINING a point: a
//   point anywhere on a lake resolves to the lake regardless of where its label sits
export class OverpassTrackService {

  // Corridor features and containing areas for the whole track in ONE Overpass
  // request. Corridor features come back as node/way/relation elements (with
  // center coordinates); containing areas as type "area" - the parser splits
  // on element type.
  async queryTrackContext(coordinates: Coordinate[], radiusMeters: number, containmentPoints: Coordinate[]): Promise<{ corridor: FeatureCandidate[]; containing: FeatureCandidate[] }> {
    if (coordinates.length < 2) return { corridor: [], containing: [] };

    const corridorLine = resampleForCorridor(coordinates);
    const query = buildTrackContextQuery(corridorLine, radiusMeters, containmentPoints);
    const data = await OverpassRateLimiter.request<OverpassResponse>(query);

    const corridor: FeatureCandidate[] = [];
    const containing: FeatureCandidate[] = [];

    for (const element of data.elements ?? []) {
      if (element.type === 'area') {
        const name = element.tags?.name;
        const kind = categorizeTags(element.tags ?? {});
        if (!name || !kind) continue;
        containing.push({
          id: `area/${element.id}`,
          name,
          kind,
          icon: CANDIDATE_KIND_ICONS[kind],
          latitude: containmentPoints[0]?.latitude ?? coordinates[0].latitude,
          longitude: containmentPoints[0]?.longitude ?? coordinates[0].longitude,
          distanceMeters: 0,
          containsTrack: true,
          trackFraction: 0.5,
        });
      } else {
        const candidate = corridorElementToCandidate(element, corridorLine);
        if (candidate) corridor.push(candidate);
      }
    }

    logger.debug(`Track context query returned ${data.elements?.length ?? 0} elements: ${corridor.length} corridor, ${containing.length} containing`);
    return { corridor: dedupeByName(corridor), containing: dedupeByName(containing) };
  }
}

// Resample the track, keeping the corridor polyline within Overpass query size limits.
export function resampleForCorridor(coordinates: Coordinate[], sampleMeters = CORRIDOR_SAMPLE_METERS, maxPoints = CORRIDOR_MAX_POINTS): Coordinate[] {
  const sampled: Coordinate[] = [coordinates[0]];
  let accumulated = 0;

  for (let i = 1; i < coordinates.length; i++) {
    accumulated += DistanceCalculator.haversineDistanceMeters(coordinates[i - 1].latitude, coordinates[i - 1].longitude, coordinates[i].latitude, coordinates[i].longitude);
    if (accumulated >= sampleMeters) {
      sampled.push(coordinates[i]);
      accumulated = 0;
    }
  }

  const last = coordinates[coordinates.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }

  if (sampled.length <= maxPoints) return sampled;

  const reduced: Coordinate[] = [];
  const step = (sampled.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    reduced.push(sampled[Math.round(i * step)]);
  }
  return reduced;
}

// Overpass QL: one request for both nearby named features (linestring `around:`
// on the whole track, since Overpass 0.7.55) and named areas containing the
// key points (`is_in` point-in-polygon). `out center` gives ways/relations a
// representative coordinate; areas carry tags only.
export function buildTrackContextQuery(corridor: Coordinate[], radiusMeters: number, containmentPoints: Coordinate[]): string {
  const line = corridor.map(c => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`).join(',');
  const around = `(around:${Math.round(radiusMeters)},${line})`;

  const isInBlocks = containmentPoints.map((point, i) => `is_in(${point.latitude.toFixed(6)},${point.longitude.toFixed(6)})->.a${i};`);
  const areaFilters = containmentPoints.flatMap((_, i) => [
    `  area.a${i}["name"]["natural"="water"];`,
    `  area.a${i}["name"]["leisure"~"^(park|nature_reserve)$"];`,
    `  area.a${i}["name"]["boundary"~"^(national_park|protected_area)$"];`,
    `  area.a${i}["name"]["place"~"^(island|islet)$"];`,
  ]);

  const aroundWater = `(around:${WATER_RADIUS_METERS},${line})`;

  // One geometric pass into a named set, then cheap tag filters on that set -
  // repeating the polyline per category made long-ride queries 4x bigger and
  // slow enough to hit the server's own timeout.
  return `[out:json][timeout:30];
${isInBlocks.join('\n')}
nwr["name"]${around}->.near;
(
  nwr.near["natural"];
  nwr.near["waterway"];
  nwr.near["tourism"];
  nwr.near["historic"];
  nwr.near["leisure"];
  nwr.near["amenity"];
  nwr.near["shop"];
  nwr.near["place"~"^(island|islet)$"];
  nwr["name"]["natural"="water"]${aroundWater};
${areaFilters.join('\n')}
);
out tags center;`;
}

// Map OSM tags to a candidate kind; undefined means the feature is not interesting for naming.
export function categorizeTags(tags: Record<string, string>): CandidateKind | undefined {
  if (tags.place === 'island' || tags.place === 'islet') return 'island';
  if (tags.natural === 'peak' || tags.natural === 'volcano' || tags.natural === 'saddle') return 'peak';
  if (tags.natural === 'water' || tags.natural === 'bay' || tags.natural === 'beach' || tags.natural === 'spring' || tags.natural === 'glacier' || tags.natural === 'wetland') return 'water';
  if (tags.waterway === 'waterfall') return 'waterfall';
  if (tags.waterway === 'river' || tags.waterway === 'stream' || tags.waterway === 'canal') return 'water';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'campground';
  if (tags.tourism === 'attraction' || tags.tourism === 'museum' || tags.tourism === 'artwork' || tags.tourism === 'monument' || tags.tourism === 'information') return 'landmark';
  if (tags.historic) return 'landmark';
  if (tags.leisure === 'park' || tags.leisure === 'nature_reserve' || tags.leisure === 'garden') return 'park';
  if (tags.boundary === 'national_park' || tags.boundary === 'protected_area') return 'park';
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.amenity === 'fast_food' || tags.amenity === 'ice_cream' || tags.amenity === 'pub' || tags.amenity === 'bar') return 'restaurant';
  if (tags.shop) return 'store';
  return undefined;
}

function corridorElementToCandidate(element: OverpassElement, corridor: Coordinate[]): FeatureCandidate | null {
  const tags = element.tags ?? {};
  const name = tags.name;
  const kind = categorizeTags(tags);
  if (!name || !kind) return null;

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const nearest = nearestCorridorPoint({ latitude: lat, longitude: lon }, corridor);

  return {
    id: `${element.type}/${element.id}`,
    name,
    kind,
    icon: CANDIDATE_KIND_ICONS[kind],
    latitude: lat,
    longitude: lon,
    distanceMeters: Math.round(nearest.distanceMeters),
    containsTrack: false,
    trackFraction: corridor.length > 1 ? nearest.index / (corridor.length - 1) : 0,
  };
}

// Nearest track point, preferring the EARLIEST near-minimal occurrence. On
// out-and-backs and loops a feature at the start (the launch beach) is nearly
// equidistant from both passes; the first encounter is the narrative position
// ("Raymond Beach to Sebago Lake", not the other way around).
export function nearestCorridorPoint(point: Coordinate, corridor: Coordinate[]): { index: number; distanceMeters: number } {
  const NEAR_MINIMAL_METERS = 30;
  let min = Infinity;
  const distances = corridor.map(trackPoint => {
    const dist = DistanceCalculator.haversineDistanceMeters(point.latitude, point.longitude, trackPoint.latitude, trackPoint.longitude);
    if (dist < min) min = dist;
    return dist;
  });
  const index = distances.findIndex(dist => dist <= min + NEAR_MINIMAL_METERS);
  return { index, distanceMeters: min };
}

// Keep the best entry per name: containing areas win, then closest to the track.
function dedupeByName(candidates: FeatureCandidate[]): FeatureCandidate[] {
  const byName = new Map<string, FeatureCandidate>();

  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, candidate);
      continue;
    }
    if ((candidate.containsTrack && !existing.containsTrack) || (candidate.containsTrack === existing.containsTrack && candidate.distanceMeters < existing.distanceMeters)) {
      byName.set(key, candidate);
    }
  }

  return Array.from(byName.values());
}
