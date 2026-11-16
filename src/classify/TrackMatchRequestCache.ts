import type { Coordinate } from "places-shared/geo";
import type { ITrackMatchService, TrackMatchCosting, TrackMatchResult } from "places-shared/services";
import { withTimeout } from "places-shared/utils";

export const TRACK_MATCH_TIMEOUT_MS = 60_000;

interface CachedTrackMatch {
  costing: TrackMatchCosting;
  coordinates: Float64Array;
  promise: Promise<TrackMatchResult>;
  expiresAt: number;
  state: "pending" | "fulfilled" | "rejected";
}

export class TrackMatchRequestCache {
  private static readonly RESULT_TTL_MS = 10 * 60_000;
  private static readonly FAILURE_TTL_MS = 60_000;
  private readonly requestsByService = new WeakMap<ITrackMatchService, Map<string, CachedTrackMatch[]>>();

  match(service: ITrackMatchService, coordinates: Coordinate[], costing: TrackMatchCosting, refresh = false): Promise<TrackMatchResult> {
    let requests = this.requestsByService.get(service);

    if (!requests) {
      requests = new Map();
      this.requestsByService.set(service, requests);
    }

    const now = Date.now();

    for (const [staleKey, entries] of requests) {
      const live = entries.filter(entry => entry.expiresAt > now);

      if (live.length) requests.set(staleKey, live);
      else requests.delete(staleKey);
    }

    const key = this.key(coordinates, costing);
    const entries = requests.get(key) ?? [];
    const cached = entries.find(entry => entry.costing === costing && entry.coordinates.length === coordinates.length * 2
      && coordinates.every((point, i) => Object.is(point.latitude, entry.coordinates[i * 2])
        && Object.is(point.longitude, entry.coordinates[i * 2 + 1])));

    if (cached && (!refresh || cached.state === "pending")) {
      requests.delete(key); requests.set(key, entries);

      return cached.promise;
    }

    if (cached) entries.splice(entries.indexOf(cached), 1);

    const promise = withTimeout(
      service.matchTrack(coordinates, { costing }),
      TRACK_MATCH_TIMEOUT_MS,
      `Track matching timed out after ${TRACK_MATCH_TIMEOUT_MS / 1_000} seconds.`,
    );
    const snapshot = new Float64Array(coordinates.length * 2);

    coordinates.forEach((point, i) => { snapshot[i * 2] = point.latitude; snapshot[i * 2 + 1] = point.longitude; });
    const entry: CachedTrackMatch = {
      costing,
      coordinates: snapshot,
      promise,
      expiresAt: now + TrackMatchRequestCache.RESULT_TTL_MS,
      state: "pending",
    };

    entries.push(entry);
    requests.delete(key); requests.set(key, entries);
    let bytes = 0, count = 0;

    for (const values of requests.values()) for (const value of values) { bytes += value.coordinates.byteLength; count++; }

    while (bytes > 8 * 1024 * 1024 || count > 64) {
      const oldestKey = requests.keys().next().value;

      if (oldestKey === undefined) break;
      const oldest = requests.get(oldestKey)!;

      for (const value of oldest) { bytes -= value.coordinates.byteLength; count--; }
      requests.delete(oldestKey);
    }

    void promise.then(
      () => {
        if (!requests.get(key)?.includes(entry)) return;
        entry.state = "fulfilled";
        entry.expiresAt = Date.now() + TrackMatchRequestCache.RESULT_TTL_MS;
      },
      () => {
        if (!requests.get(key)?.includes(entry)) return;
        entry.state = "rejected";
        entry.expiresAt = Date.now() + TrackMatchRequestCache.FAILURE_TTL_MS;
      },
    );

    return promise;
  }

  private key(coordinates: Coordinate[], costing: TrackMatchCosting): string {
    const value = new DataView(new ArrayBuffer(8));
    let hash = 2166136261;

    for (const point of coordinates) {
      for (const number of [point.latitude, point.longitude]) {
        value.setFloat64(0, number);
        hash = Math.imul(hash ^ value.getUint32(0), 16777619);
        hash = Math.imul(hash ^ value.getUint32(4), 16777619);
      }
    }

    return `${costing}:${coordinates.length}:${hash >>> 0}`;
  }
}
