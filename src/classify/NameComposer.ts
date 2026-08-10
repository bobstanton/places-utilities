import { MatchedWay } from "places-shared/services";
import { RouteType } from "./RouteTypeDetector";
import { CandidateKind, FeatureCandidate } from "./ClassifyTypes";

// Every checked candidate appears in the name, ordered by its position along
// the track ("Barrier Beach Trail to Little River to Laird-Norton Trail").
// Ranking only picks the DEFAULT checked set.

export interface SequenceItem {
  id: string;
  name: string;
  // Position along the track (0-1) used for ordering.
  fraction: number;
}

// Lower rank = better default destination.
const KIND_RANK: Record<CandidateKind, number> = {
  peak: 1,
  viewpoint: 1,
  waterfall: 1,
  water: 2,
  island: 2,
  landmark: 3,
  park: 3,
  campground: 4,
  store: 5,
  restaurant: 5,
};

// Ways below this share of the track start unchecked.
const DEFAULT_WAY_COVERAGE = 0.15;
const DEFAULT_MAX_WAYS = 3;

export function wayId(way: MatchedWay): string {
  return `way:${way.name.toLowerCase()}`;
}

// The route-type suffix ("Loop", "Out and Back") is itself a checkable part of
// the name.
export function composeSequenceName(items: SequenceItem[], routeType: RouteType, includeSuffix: boolean, datePrefix?: string): string {
  const ordered = [...items].sort((a, b) => a.fraction - b.fraction);

  // Drop names that repeat a similar neighbor ("Kilburn Loop" then "Kilburn Loop Trail")
  const names: string[] = [];
  for (const item of ordered) {
    if (names.length === 0 || !namesAreSimilar(names[names.length - 1], item.name)) {
      names.push(item.name);
    }
  }

  const suffix = includeSuffix ? routeSuffixLabel(routeType) : undefined;
  const base = composeBase(names, suffix, routeType);

  // Lead with the date segment ("20260709 - Barrier Beach Trail to Little River Loop").
  if (datePrefix) return base ? `${datePrefix} - ${base}` : datePrefix;
  return base;
}

function composeBase(names: string[], suffix: string | undefined, routeType: RouteType): string {
  if (names.length === 0) return suffix ?? '';

  const sequence = names.join(' to ');
  if (!suffix) return sequence;
  if (routeType === 'loop' && /\bloop\b/i.test(names[names.length - 1])) return sequence;
  return `${sequence} ${suffix}`;
}

// Synthetic chip id for the leading track-date segment of the name.
export const DATE_PREFIX_ID = 'date:prefix';

// Synthetic chip id for the route-type suffix part of the name.
export const ROUTE_SUFFIX_ID = 'route:suffix';

export function routeSuffixLabel(routeType: RouteType): string | undefined {
  if (routeType === 'loop') return 'Loop';
  if (routeType === 'out-and-back') return 'Out and Back';
  return undefined;
}

// The default checked set: significant ways (top coverage) plus the best destination feature.
export function defaultSelectionIds(ways: MatchedWay[], features: FeatureCandidate[]): Set<string> {
  const selected = new Set<string>();

  // A ferry route's name describes its endpoints, not the matched water ("Portsmouth -
  // Star Island" for a river paddle that never left the harbor). It stays a chip the
  // user can check; it never names the note by default.
  const nameableWays = ways.filter(w => w.use !== 'ferry');
  const significantWays = nameableWays
    .filter(w => w.coverage >= DEFAULT_WAY_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, DEFAULT_MAX_WAYS);
  // Fall back to the single dominant way when nothing clears the coverage bar
  if (significantWays.length === 0 && nameableWays.length > 0) {
    significantWays.push(nameableWays.reduce((best, way) => way.coverage > best.coverage ? way : best));
  }
  for (const way of significantWays) {
    selected.add(wayId(way));
  }

  const destination = pickDestination(features.filter(f => !significantWays.some(w => namesAreSimilar(w.name, f.name))));
  if (destination) {
    selected.add(destination.id);
  }

  return selected;
}

export function pickDestination(features: FeatureCandidate[]): FeatureCandidate | undefined {
  if (features.length === 0) return undefined;

  return [...features].sort((a, b) => {
    if (a.containsTrack !== b.containsTrack) return a.containsTrack ? -1 : 1;
    const rankDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rankDiff !== 0) return rankDiff;
    return a.distanceMeters - b.distanceMeters;
  })[0];
}

// Whether two names refer to the same feature ("Kilburn Loop" vs "Kilburn Loop Trail").
export function namesAreSimilar(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();

  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Same feature iff every significant word of the shorter name appears in the
  // longer one: "Cheshire Trail" ~ "Cheshire Rail Trail", but "Cheshire Rail
  // Trail" and "Monadnock Recreational Rail Trail" only share the generic
  // "rail" and are different trails.
  const stopWords = new Set(['trail', 'path', 'loop', 'road', 'street', 'drive', 'lane', 'way', 'the', 'a', 'an']);
  const words1 = n1.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  const words2 = n2.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  const [shorter, longer] = words1.length <= words2.length ? [words1, words2] : [words2, words1];

  return shorter.length > 0 && shorter.every(w => longer.includes(w));
}
