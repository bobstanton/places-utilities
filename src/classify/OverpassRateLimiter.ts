import { getError, sleep, withTimeout } from "places-shared/utils";
import { logger } from "places-shared/utils";
import { loggedRequestUrl as requestUrl } from "places-shared/utils";
import { trackApiUsage, type ApiUsageOrigin, type ApiUsageRecorder } from "places-shared/services";

const OVERPASS_USAGE = { provider: 'overpass', service: 'features' } as const;

let usageRecorder: ApiUsageRecorder | undefined;

export function configureOverpassUsage(recorder: ApiUsageRecorder | undefined): void {
  usageRecorder = recorder;
}

// Rate limiter for the Overpass API requests used by track classification.
//
// Each plugin bundles its own code: this queue is a singleton per plugin
// bundle, not per vault.

// Primary endpoint plus fallback mirror. overpass-api.de sits behind an Apache
// WAF that intermittently answers 406 Not Acceptable, especially for requests
// without a descriptive User-Agent; a 406 rotates to the next endpoint.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

// Above the 30s server-side [timeout:*]; a request older than this is a held socket.
const REQUEST_TIMEOUT_MS = 40_000;

const OVERPASS_REQUEST_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "ObsidianPlaces/1.0 (Obsidian plugin; https://obsidian.md)",
  "Referer": "https://obsidian.md/"
};

interface QueuedRequest<T> {
  origin?: ApiUsageOrigin;
  query: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

class OverpassRateLimiterClass {
  private requestQueue: QueuedRequest<unknown>[] = [];
  private isProcessingQueue = false;
  private endpointIndex = 0;
  private readonly minRequestInterval = 1500;
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 5000;
  // One entry per query text: the in-flight promise while a request runs (a
  // concurrent identical query joins it instead of queueing a second round
  // trip - a startup re-render asks the same corridor twice within seconds),
  // then the settled result until the TTL lapses (a Reclassify moments later
  // reuses the answer; a slow Overpass round is the expensive thing here, and
  // the features around a track do not change on that timescale). Failures are
  // dropped, and the next identical query retries.
  private readonly resultsByQuery = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();
  private static readonly RESULT_TTL_MS = 10 * 60_000;

  async request<T>(query: string, origin?: ApiUsageOrigin): Promise<T> {
    const cached = this.resultsByQuery.get(query);

    if (cached && cached.expiresAt > Date.now()) {
      usageRecorder?.record({ ...OVERPASS_USAGE, success: true, durationMs: 0, cached: true, ...(origin ? { origin } : {}) });

      return cached.promise as Promise<T>;
    }

    const promise = new Promise((resolve, reject) => {
      this.requestQueue.push({
        query,
        resolve,
        reject,
        ...(origin ? { origin } : {})
      });
      void this.processQueue();
    });

    for (const [staleQuery, entry] of this.resultsByQuery) {
      if (entry.expiresAt <= Date.now()) this.resultsByQuery.delete(staleQuery);
    }

    this.resultsByQuery.set(query, { promise, expiresAt: Date.now() + OverpassRateLimiterClass.RESULT_TTL_MS });
    promise.catch(() => {
      if (this.resultsByQuery.get(query)?.promise === promise) this.resultsByQuery.delete(query);
    });

    return promise as Promise<T>;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;

      try {
        const result = await trackApiUsage(usageRecorder, { ...OVERPASS_USAGE, ...(request.origin ? { origin: request.origin } : {}) }, () => this.executeRequestWithRetry(request.query));

        request.resolve(result);
      } catch (error) {
        request.reject(getError(error));
      }

      if (this.requestQueue.length > 0) {
        await sleep(this.minRequestInterval);
      }
    }

    this.isProcessingQueue = false;
  }

  private async executeRequestWithRetry(query: string, attempt: number = 0): Promise<unknown> {
    try {
      const response = await withTimeout(requestUrl({
        url: OVERPASS_ENDPOINTS[this.endpointIndex],
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: OVERPASS_REQUEST_HEADERS,
        throw: false
      }), REQUEST_TIMEOUT_MS, `Overpass request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);

      if (response.status === 406 || response.status >= 500) {
        if (attempt < this.maxRetries) {
          this.endpointIndex = (this.endpointIndex + 1) % OVERPASS_ENDPOINTS.length;
          logger.warn(`Overpass endpoint returned ${response.status}, switching to ${OVERPASS_ENDPOINTS[this.endpointIndex]}`);

          return this.executeRequestWithRetry(query, attempt + 1);
        }

        throw new Error(`Overpass API error: ${response.status} (all endpoints failed)`);
      }

      if (response.status === 429) {
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * (attempt + 1);

          logger.warn(`Overpass rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await sleep(delay);

          return this.executeRequestWithRetry(query, attempt + 1);
        }

        throw new Error(`Overpass API rate limited after ${this.maxRetries} retries`);
      }

      if (response.status !== 200) {
        throw new Error(`Overpass API error: ${response.status}`);
      }

      return response.json;
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out") && attempt < this.maxRetries) {
        this.endpointIndex = (this.endpointIndex + 1) % OVERPASS_ENDPOINTS.length;
        logger.warn(`Overpass request timed out, switching to ${OVERPASS_ENDPOINTS[this.endpointIndex]}`);

        return this.executeRequestWithRetry(query, attempt + 1);
      }

      if (error instanceof Error && error.message.includes("429") && attempt < this.maxRetries) {
        const delay = this.retryDelayMs * (attempt + 1);

        logger.warn(`Overpass rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
        await sleep(delay);

        return this.executeRequestWithRetry(query, attempt + 1);
      }

      throw error;
    }
  }
}

export const OverpassRateLimiter = new OverpassRateLimiterClass();
