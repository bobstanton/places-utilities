import type * as GeoJSON from 'geojson';
import type { IndexedPoint, PlaybackPosition } from './TrackPlayback';

const CHUNK_VERTICES = 256;

interface ProgressChunk {
  start: number;
  end: number;
  segment: number;
}

export class PlaybackProgressGeometry {
  readonly data: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  private readonly chunks: ProgressChunk[] = [];

  constructor(private readonly points: readonly IndexedPoint[]) {
    for (let start = 0; start < points.length - 1;) {
      let end = start;

      while (end + 1 < points.length && end - start < CHUNK_VERTICES - 1 && points[end + 1].segmentIndex === points[start].segmentIndex) end++;
      if (end > start) this.chunks.push({ start, end, segment: points[start].segmentIndex });
      start = end + 1 < points.length && points[end + 1].segmentIndex === points[start].segmentIndex ? end : end + 1;
    }

    this.data = { type: 'FeatureCollection', features: this.chunks.map((chunk, id) => ({
      type: 'Feature', id, properties: { chunk: id }, geometry: { type: 'LineString',
        coordinates: points.slice(chunk.start, chunk.end + 1).map(point => [point.longitude, point.latitude]),
      },
    })) };
  }

  at(distance: number, position: PlaybackPosition): { completedChunks: number; tail: GeoJSON.FeatureCollection<GeoJSON.LineString> } {
    let low = 0;
    let high = this.chunks.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const chunk = this.chunks[mid];
      const end = this.points[chunk.end].distanceMeters;

      if (end < distance || (end === distance && chunk.segment <= (position.segmentIndex ?? 0))) low = mid + 1;
      else high = mid;
    }

    const completedChunks = low;
    const chunk = this.chunks[low];
    const tail: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: 'FeatureCollection', features: [] };

    if (chunk && chunk.segment === position.segmentIndex && this.points[chunk.start].distanceMeters <= distance) {
      let end = chunk.start;

      while (end <= chunk.end && this.points[end].distanceMeters <= distance) end++;
      const coordinates = this.data.features[low].geometry.coordinates.slice(0, end - chunk.start);

      coordinates.push([position.longitude, position.latitude]);
      if (coordinates.length >= 2) tail.features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } });
    }

    return { completedChunks, tail };
  }
}
