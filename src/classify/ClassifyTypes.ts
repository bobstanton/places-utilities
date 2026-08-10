export type CandidateKind = 'peak' | 'water' | 'waterfall' | 'viewpoint' | 'park' | 'campground' | 'store' | 'restaurant' | 'landmark' | 'island';

// Where a category names the same thing as a default marker icon rule, the
// glyph must match `defaultMarkerIconRules()` in places-shared. This table
// cannot read the configured rules (they are main-plugin state and this runs
// in the utilities bundle), and the agreement is maintained by hand.
// Categories with no counterpart there (`water`, `store`, `landmark`,
// `island`) are free choices.
export const CANDIDATE_KIND_ICONS: Record<CandidateKind, string> = {
  peak: '⛰️',
  water: '💧',
  waterfall: '🌊',
  viewpoint: '👀',
  park: '🏞️',
  campground: '🏕️',
  store: '🏪',
  restaurant: '🍽️',
  landmark: '🏛️',
  island: '🏝️',
};

// A named feature near (or containing) the track that can contribute to its name.
export interface FeatureCandidate {
  // OSM type/id; keys persisted checkbox state across re-renders.
  id: string;
  name: string;
  kind: CandidateKind;
  icon: string;
  latitude: number;
  longitude: number;
  // Approximate distance from the track in meters; 0 when the feature contains the track.
  distanceMeters: number;
  // True when the track runs inside this feature's polygon (lake, park, reserve).
  containsTrack: boolean;
  // Where along the track (0-1) this feature sits (nearest track point).
  trackFraction: number;
}
