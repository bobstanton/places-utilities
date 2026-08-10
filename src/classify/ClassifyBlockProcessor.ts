import { App, MarkdownPostProcessorContext, TFile, normalizePath } from "obsidian";
import { formatKmInSystem, formatMetersInSystem, meters, UnitsSystem } from "places-shared/units";
import { HostMapSurfaceRequest, IPlacesHostServices, ITrackMatchService, MatchedWay, TrackMatchCosting, resolveHostMapConfig } from "places-shared/services";
import { CodeBlockReader, IPlacesExtensionHostSettings, type ResolvedMapConfig, parseBoolean, parseShortDistanceAsMeters } from "places-shared/settings";
import { createMapRenderPlan, resolveCameraIntent } from "places-shared/render";
import { TrackData } from "places-shared/geo";
import { buildTrackPreviewPlace, MapPlace } from "places-shared/overlay";
import { createFloatingRefreshButton, createLoadingIndicator, RenderStalenessGuard } from "places-shared/ui";
import { Utilities, getErrorMessage, renderErrorWithHelp, logger as rootLogger } from "places-shared/utils";
import { detectRouteType, getRouteTypeLabel, RouteTypeResult } from "./RouteTypeDetector";
import { containmentQueryPoints } from "./TrackKeyPoints";
import { OverpassTrackService } from "./OverpassTrackService";
import { composeSequenceName, defaultSelectionIds, namesAreSimilar, pickDestination, routeSuffixLabel, wayId, ROUTE_SUFFIX_ID, DATE_PREFIX_ID, SequenceItem } from "./NameComposer";
import { CandidateKind, CANDIDATE_KIND_ICONS, FeatureCandidate } from "./ClassifyTypes";
const logger = rootLogger.scope("places-classify");

const DEFAULT_CORRIDOR_RADIUS_METERS = 100;
// Cap on nearby (non-containing) features shown as chips; corridors through towns return dozens of shops.
const MAX_NEARBY_FEATURES = 20;
const TRACK_COLOR = "#3b82f6";
// Matched-way geometry, drawn wide and translucent under the track.
const WAY_COLOR = "#8b5cf6";

const KIND_LABELS: Record<FeatureCandidate["kind"], string> = {
  peak: "Peak",
  water: "Water",
  waterfall: "Waterfall",
  viewpoint: "Viewpoint",
  park: "Park",
  campground: "Campground",
  store: "Store",
  restaurant: "Restaurant",
  landmark: "Landmark",
  island: "Island",
};
// Features farther than this from the track show their distance on the chip.
const FAR_FEATURE_METERS = 150;

interface ClassifyBlockSettings {
  track: string;
  matchProvider?: string;
  costing: TrackMatchCosting;
  radiusMeters: number;
  mapProvider: string;
  style?: string;
  height: string;
  width: string;
  showMap: boolean;
  // Candidate kinds allowed as name candidates; undefined admits every kind.
  features?: Set<CandidateKind>;
  featureErrors: string[];
}

// Session-scoped checkbox state keyed by note + track. Defaults arrive
// progressively as each source settles and must not re-apply over the user's
// later choices.
interface BlockSelectionState {
  checked: Set<string>;
  waysDefaulted: boolean;
  destinationDefaulted: boolean;
  suffixDefaulted: boolean;
  dateDefaulted: boolean;
}

const selectionByBlock = new Map<string, BlockSelectionState>();

// A refresh can restart processing while a previous run is still awaiting API
// results; the superseded run must not touch the element after it was emptied.
// Only the run holding the current token may mutate the DOM.
const latestRunByElement = new WeakMap<HTMLElement, symbol>();

export class ClassifyBlockProcessor {
  private overpassService = new OverpassTrackService();
  constructor(private app: App, private mainSettings: IPlacesExtensionHostSettings, private host: IPlacesHostServices) {}

  private get units(): UnitsSystem {
    return this.mainSettings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (el.closest(".popover.hover-popover")) {
      el.createDiv({ cls: "places-popover-placeholder", text: "🏷️ Classify preview not available in hover" });
      return;
    }

    createFloatingRefreshButton({
      buttonContainer: el.createDiv("places-floating-buttons"),
      ariaLabel: "Reclassify track",
      onRefresh: async () => {
        el.empty();
        await this.processCodeBlock(source, el, ctx);
      },
      onError: error => logger.error("Reclassify track failed:", error),
    });

    // Two ways a run goes stale, needing both checks:
    // - the section is unloaded (a startup re-render replaced the element):
    //   only the guard catches this - a new render is a new element, and the
    //   element-keyed token never mismatches;
    // - the Reclassify button re-enters with the SAME element: only the token
    //   catches this - the section never moved, and the guard is still loaded.
    const stalenessGuard = new RenderStalenessGuard(el);
    ctx.addChild(stalenessGuard);
    const runToken = Symbol("classify-run");
    latestRunByElement.set(el, runToken);
    const isStale = () => stalenessGuard.superseded || latestRunByElement.get(el) !== runToken;

    const settings = this.parseSettings(source);
    const trackInput = settings.track || `"${ctx.sourcePath}"`;
    const loading = createLoadingIndicator(el, "Loading track...");

    let trackData: TrackData;
    try {
      trackData = await this.host.tracks.loadTrackFromPath(trackInput, ctx.sourcePath, { skipCache: true });
      if (isStale()) return;
      if (trackData.points.length < 2) {
        throw new Error("The track needs at least two points to classify.");
      }
    } catch (error) {
      if (isStale()) return;
      loading.remove();
      logger.error("Classification failed:", error);
      renderErrorWithHelp(el, { icon: "⚠️", title: "Classification failed", message: getErrorMessage(error) });
      return;
    }

    loading.remove();
    this.renderProgressive(el, ctx, settings, trackInput, trackData, isStale);
  }

  private parseSettings(source: string): ClassifyBlockSettings {
    const block = new CodeBlockReader(source);
    const costing = block.text('costing')?.trim().toLowerCase();

    const featureErrors: string[] = [];
    let features: Set<CandidateKind> | undefined;
    const rawFeatures = block.text('features')?.trim();
    if (rawFeatures) {
      const validKinds = Object.keys(CANDIDATE_KIND_ICONS) as CandidateKind[];
      const requested = rawFeatures.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
      const unknown = requested.filter(part => !validKinds.includes(part as CandidateKind));
      if (unknown.length > 0) {
        featureErrors.push(`Unknown feature kind${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `"${k}"`).join(', ')}. Available: ${validKinds.join(', ')}.`);
      }
      const known = requested.filter((part): part is CandidateKind => validKinds.includes(part as CandidateKind));
      if (known.length > 0) features = new Set(known);
    }

    return {
      features,
      featureErrors,
      track: block.text('track')?.trim() ?? "",
      matchProvider: block.text('matchProvider')?.trim().toLowerCase() || undefined,
      costing: costing === "bicycle" || costing === "auto" ? costing : "pedestrian",
      radiusMeters: Number(parseShortDistanceAsMeters(block.raw('radius'), this.units) ?? meters(DEFAULT_CORRIDOR_RADIUS_METERS)),
      mapProvider: this.host.maps.resolveMapProvider(block.text('mapProvider')),
      style: block.text('style'),
      height: block.text('height') || "400px",
      width: block.text('width') || "100%",
      showMap: parseBoolean(block.raw('showMap'), true),
    };
  }

  private resolveMatchService(requested: string | undefined): { service?: ITrackMatchService; name?: string; error?: string } {
    const providerName = requested ?? "valhalla";
    const service = this.host.trackMatch.get(providerName);
    if (service?.isAvailable()) return { service, name: providerName };
    const available = this.host.trackMatch.getNames();
    return {
      error: available.length > 0
        ? `Unknown track match provider "${providerName}". Available: ${available.join(", ")}`
        : "No track match service is installed.",
    };
  }

  private renderProgressive(el: HTMLElement, ctx: MarkdownPostProcessorContext, settings: ClassifyBlockSettings, trackInput: string, trackData: TrackData, isStale: () => boolean): void {
    const coordinates = trackData.points.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
    const routeType = detectRouteType(coordinates);
    const match = this.resolveMatchService(settings.matchProvider);

    const stateKey = `${ctx.sourcePath}::${trackInput}`;
    const state = selectionByBlock.get(stateKey) ?? { checked: new Set<string>(), waysDefaulted: false, destinationDefaulted: false, suffixDefaulted: false, dateDefaulted: false };
    selectionByBlock.set(stateKey, state);

    // The track date is known without an API call and defaults checked up front.
    const trackDate = trackData.points.find(p => p.time)?.time;
    const dateLabel = trackDate ? Utilities.formatDateAsYYYYMMDD(trackDate) : undefined;
    if (dateLabel && !state.dateDefaulted) {
      state.dateDefaulted = true;
      state.checked.add(DATE_PREFIX_ID);
    }

    let ways: MatchedWay[] = [];
    let corridor: FeatureCandidate[] = [];
    let containing: FeatureCandidate[] = [];
    let waysPending = Boolean(match.service);
    let featuresPending = true;

    let visibleFeatureCache: FeatureCandidate[] | null = null;
    const visibleFeatures = (): FeatureCandidate[] => {
      if (visibleFeatureCache) return visibleFeatureCache;
      const containingNames = new Set(containing.map(f => f.name.toLowerCase()));
      const nearby = corridor
        .filter(f => !containingNames.has(f.name.toLowerCase()))
        .filter(f => !ways.some(w => namesAreSimilar(w.name, f.name)))
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, MAX_NEARBY_FEATURES);
      visibleFeatureCache = [...containing, ...nearby];
      return visibleFeatureCache;
    };

    const wayFraction = (way: MatchedWay, index: number) => way.startFraction ?? (ways.length > 1 ? index / (ways.length - 1) : 0);

    const composeName = (features = visibleFeatures()) => {
      const items: SequenceItem[] = [
        ...ways.map((way, index) => ({ id: wayId(way), name: way.name, fraction: wayFraction(way, index) })),
        ...features.map(f => ({ id: f.id, name: f.name, fraction: f.trackFraction })),
      ].filter(item => state.checked.has(item.id));
      const datePrefix = dateLabel && state.checked.has(DATE_PREFIX_ID) ? dateLabel : undefined;
      return composeSequenceName(items, routeType.type, state.checked.has(ROUTE_SUFFIX_ID), datePrefix);
    };

    const container = el.createDiv({ cls: "places-classify-container" });

    let currentName = composeName();
    const nameRow = container.createDiv({ cls: "places-classify-name-row" });
    const nameEl = nameRow.createDiv({ cls: "places-classify-name" });
    const applyButton = this.renderApplyButton(nameRow, trackInput, ctx, () => currentName);

    const metaEl = container.createDiv({ cls: "places-classify-meta" });
    const warningsEl = container.createDiv();

    const chipsEl = container.createDiv({ cls: "places-classify-chips" });
    const mapContainer: HTMLElement | null = settings.showMap
      ? container.createDiv({ cls: "places-classify-map-wrap" }).createDiv({ cls: "places-classify-map" })
      : null;

    // Host resolution applies the user's global map settings and the provider layer.
    const { config: mapConfig } = resolveHostMapConfig(this.host, {
      mapProvider: settings.mapProvider,
      height: settings.height,
      width: settings.width,
      showLabels: false,
      track: { defaultVisibility: "visible" },
      poiDiscovery: false,
      ...(settings.style ? { style: settings.style } : {}),
    }, 1);

    const trackPlace = buildTrackPreviewPlace({
      name: trackData.metadata.name ?? "Track",
      icon: "📍",
      coordinates: trackData.points.map(p => [p.longitude, p.latitude]),
      color: TRACK_COLOR,
      lineStyle: "solid",
    });

    // Markers do not toggle selection; the chip bar above the map does.
    // Containing areas anchor at their containment query point.
    const featurePlaces = (features: FeatureCandidate[]): MapPlace[] => features.map(f => ({
      id: f.id,
      latitude: f.latitude,
      longitude: f.longitude,
      name: f.name,
      icon: f.icon,
      subtitle: f.containsTrack ? `${KIND_LABELS[f.kind]} · contains route` : `${KIND_LABELS[f.kind]} · ${formatMetersInSystem(meters(f.distanceMeters), this.units)} from track`,
    }));

    // Draw the matcher's snapped geometry under the track, with a marker popup
    // naming what it is.
    const wayPlaces = (): MapPlace[] => ways.filter(way => way.segments?.length).map(way => {
      const segments = way.segments!;
      const longest = segments.reduce((best, segment) => segment.length > best.length ? segment : best);
      const anchor = longest[Math.floor(longest.length / 2)];
      const trackKm = Number(trackData.metrics.distance);
      const percent = trackKm > 0 ? Math.min(100, Math.round(Number(way.lengthKm) / trackKm * 100)) : undefined;
      const kindLabel = way.use === 'ferry' ? 'ferry route' : (way.use ?? way.roadClass);
      return {
        id: wayId(way),
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        name: way.name,
        icon: way.use === 'ferry' ? "⛴️" : "〰️",
        subtitle: [kindLabel, way.surface, percent !== undefined ? `${percent}% of track` : undefined].filter(Boolean).join(' · '),
        trackDefaultVisibility: 'visible',
        overlay: {
          geojson: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: { stroke: WAY_COLOR, 'stroke-width': 7, 'stroke-opacity': 0.45 },
              geometry: { type: 'MultiLineString', coordinates: segments.map(segment => segment.map(point => [point.longitude, point.latitude])) },
            }],
          },
          style: { color: WAY_COLOR, weight: 7, opacity: 0.45, style: 'solid' },
        },
      };
    });

    const pushMapPlaces = async () => {
      if (!mapContainer || isStale()) return;
      await mapReady;
      const updated = await this.host.maps.updateMapSurface(this.mapRequest(mapContainer, ctx, settings, mapConfig, [trackPlace, ...wayPlaces(), ...featurePlaces(visibleFeatures())], true));
      if (!updated) {
        logger.debug("Feature marker update was rejected by the map provider");
      }
    };

    // Render the map immediately with just the track; stream feature markers in later.
    const mapReady = mapContainer ? this.renderMap(mapContainer, ctx, settings, mapConfig, [trackPlace]) : Promise.resolve(false);

    const refresh = () => {
      if (isStale()) return;
      const features = visibleFeatures();
      currentName = composeName(features);
      nameEl.setText(currentName || "No name parts selected");
      nameEl.toggleClass("places-classify-name-empty", !currentName);
      if (applyButton && !applyButton.title) applyButton.disabled = !currentName;

      const metaParts = [
        getRouteTypeLabel(routeType.type),
        formatKmInSystem(trackData.metrics.distance, this.units),
        !waysPending && match.name ? `${ways.length} named ways (${match.name})` : undefined,
      ].filter((part): part is string => Boolean(part));
      metaEl.setText(metaParts.join(" · "));

      this.renderChips(chipsEl, ways, features, routeType, state, dateLabel, Number(trackData.metrics.distance), waysPending, featuresPending, () => refresh());
    };

    const addWarning = (text: string) => {
      if (isStale()) return;
      warningsEl.createDiv({ cls: "places-classify-meta places-classify-meta-warning", text });
    };
    if (match.error) addWarning(match.error);
    for (const error of settings.featureErrors) addWarning(error);

    refresh();

    const waysPromise = match.service
      ? match.service.matchTrack(coordinates, { costing: settings.costing }).then(async result => {
        ways = result.ways;
        visibleFeatureCache = null;
        if (!state.waysDefaulted) {
          state.waysDefaulted = true;
          for (const id of defaultSelectionIds(ways, [])) state.checked.add(id);
        }
        // Push way geometry onto the live map without a re-render.
        await pushMapPlaces();
      }, (error: unknown) => {
        logger.warn("Track match failed", error);
        addWarning(`Track matching failed: ${getErrorMessage(error)}`);
      }).finally(() => {
        waysPending = false;
        refresh();
      })
      : Promise.resolve();

    // The features setting filters at the source: excluded kinds never become
    // chips, markers, or the default destination.
    const allowedKind = (f: FeatureCandidate) => !settings.features || settings.features.has(f.kind);
    const featuresPromise = this.overpassService.queryTrackContext(coordinates, settings.radiusMeters, containmentQueryPoints(trackData.points)).then(async context => {
      corridor = context.corridor.filter(allowedKind);
      containing = context.containing.filter(allowedKind);
      visibleFeatureCache = null;
      // Add feature markers to the live map without a re-render
      await pushMapPlaces();
    }, (error: unknown) => {
      logger.warn("Feature discovery failed", error);
      addWarning(`Feature discovery failed: ${getErrorMessage(error)}`);
    }).finally(() => {
      featuresPending = false;
      refresh();
    });

    // Destination + suffix defaults need both sources (a destination similar to a
    // matched way must be skipped; the suffix default depends on how much is checked).
    void Promise.allSettled([waysPromise, featuresPromise]).then(() => {
      if (isStale()) return;
      if (!state.destinationDefaulted) {
        state.destinationDefaulted = true;
        const destination = pickDestination(visibleFeatures().filter(f => !ways.some(w => namesAreSimilar(w.name, f.name))));
        if (destination) state.checked.add(destination.id);
      }
      if (!state.suffixDefaulted) {
        state.suffixDefaulted = true;
        if (routeSuffixLabel(routeType.type) && state.checked.size <= 1) {
          state.checked.add(ROUTE_SUFFIX_ID);
        }
      }
      refresh();
    });
  }

  private renderApplyButton(container: HTMLElement, trackInput: string, ctx: MarkdownPostProcessorContext, getName: () => string): HTMLButtonElement {
    const targetFile = this.host.tracks.resolveMarkdownTrackFile(trackInput, ctx.sourcePath);
    const button = container.createEl("button", { cls: "mod-cta", text: "Rename note" });
    const status = container.createDiv({ cls: "places-classify-action-status" });

    if (!targetFile) {
      button.disabled = true;
      button.title = "Renaming is only available for markdown track notes";
      return button;
    }

    button.addEventListener("click", () => {
      void this.renameNote(targetFile, getName(), status);
    });
    return button;
  }

  private async renameNote(file: TFile, name: string, status: HTMLElement): Promise<void> {
    status.empty();
    const sanitized = Utilities.sanitizeFilename(name);
    if (!sanitized) {
      renderErrorWithHelp(status, { icon: "⚠️", title: "Rename unavailable", message: "The composed name is empty." });
      return;
    }
    if (sanitized === file.basename) {
      status.createDiv({ cls: "places-action-status", text: `Note is already named "${sanitized}".` });
      return;
    }

    const parentPath = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const newPath = normalizePath(`${parentPath}${sanitized}.md`);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      renderErrorWithHelp(status, { icon: "⚠️", title: "Rename unavailable", message: `A note named "${sanitized}" already exists.` });
      return;
    }

    try {
      await this.app.fileManager.renameFile(file, newPath);
      status.createDiv({ cls: "places-action-status is-success", text: `Renamed note to "${sanitized}".` });
    } catch (error) {
      logger.error("Rename failed:", error);
      renderErrorWithHelp(status, { icon: "⚠️", title: "Rename failed", message: getErrorMessage(error) });
    }
  }

  private mapRequest(mapContainer: HTMLElement, ctx: MarkdownPostProcessorContext, settings: ClassifyBlockSettings, config: ResolvedMapConfig, places: MapPlace[], preserveCamera = false): HostMapSurfaceRequest {
    const source = { path: ctx.sourcePath };
    const camera = preserveCamera ? { kind: 'preserve' } as const : resolveCameraIntent(config, source);
    const plan = createMapRenderPlan({ surfaceKind: 'other', places, config, clusteringEnabled: false, source, camera });
    return {
      host: mapContainer.parentElement ?? mapContainer,
      mapContainer,
      providerName: settings.mapProvider,
      ctx,
      renderPlan: plan,
    };
  }

  private async renderMap(mapContainer: HTMLElement, ctx: MarkdownPostProcessorContext, settings: ClassifyBlockSettings, config: ResolvedMapConfig, places: MapPlace[]): Promise<boolean> {
    const rendered = await this.host.maps.renderMapSurface(this.mapRequest(mapContainer, ctx, settings, config, places));
    if (!rendered) {
      logger.debug("Classify map did not render", { provider: settings.mapProvider });
    }
    return rendered;
  }

  // One chip per name part, laid out in track order (matching the composed
  // name's "A to B to C" sequence), with the route-type suffix as the last
  // chip. Pending sources show as muted placeholders until their request
  // settles.
  private renderChips(chipsEl: HTMLElement, ways: MatchedWay[], features: FeatureCandidate[], routeType: RouteTypeResult, state: BlockSelectionState, dateLabel: string | undefined, trackKm: number, waysPending: boolean, featuresPending: boolean, onToggle: () => void): void {
    chipsEl.empty();

    interface Chip {
      id: string;
      icon: string;
      name: string;
      fraction: number;
      detail: string;
      distanceLabel?: string;
    }

    const wayFraction = (way: MatchedWay, index: number) => way.startFraction ?? (ways.length > 1 ? index / (ways.length - 1) : 0);
    // Percent of the ACTUAL track on this way. `coverage` divides by the total
    // matched length, and map matching can snap only a fraction of the track
    // (a water track snaps to little besides ferry edges).
    const trackPercent = (way: MatchedWay) => trackKm > 0 ? Math.min(100, Math.round(Number(way.lengthKm) / trackKm * 100)) : Math.round(way.coverage * 100);
    const chips: Chip[] = [
      ...ways.map((way, index) => ({
        id: wayId(way),
        icon: way.use === 'ferry' ? "⛴️" : "〰️",
        name: way.name,
        fraction: wayFraction(way, index),
        detail: way.use === 'ferry' ? `ferry route · ${trackPercent(way)}% of track` : `${trackPercent(way)}% of track`,
      })),
      ...features.map(f => ({
        id: f.id,
        icon: f.icon,
        name: f.name,
        fraction: f.trackFraction,
        detail: f.containsTrack ? "contains route" : formatMetersInSystem(meters(f.distanceMeters), this.units),
        distanceLabel: !f.containsTrack && f.distanceMeters > FAR_FEATURE_METERS ? formatMetersInSystem(meters(f.distanceMeters), this.units) : undefined,
      })),
    ].sort((a, b) => a.fraction - b.fraction);

    const suffixLabel = routeSuffixLabel(routeType.type);
    if (suffixLabel) {
      chips.push({ id: ROUTE_SUFFIX_ID, icon: "🔁", name: suffixLabel, fraction: Number.POSITIVE_INFINITY, detail: "name suffix" });
    }

    // Lead the name with the track date.
    if (dateLabel) {
      chips.unshift({ id: DATE_PREFIX_ID, icon: "📅", name: dateLabel, fraction: Number.NEGATIVE_INFINITY, detail: "track date" });
    }

    const addPending = (text: string) => {
      const pending = chipsEl.createSpan({ cls: "places-classify-chip-pending" });
      pending.createSpan({ cls: "places-loading-spinner-sm" });
      pending.createSpan({ text });
    };
    if (waysPending) {
      addPending("Loading trails & roads");
    }
    if (featuresPending) {
      addPending("Loading features");
    }
    if (chips.length === 0 && !waysPending && !featuresPending) {
      chipsEl.createDiv({ cls: "places-classify-chips-empty", text: "No named features or ways found near this track." });
      return;
    }

    for (const chip of chips) {
      const label = chipsEl.createEl("label", { cls: "places-classify-chip" });
      label.title = chip.detail;
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = state.checked.has(chip.id);
      label.toggleClass("is-checked", checkbox.checked);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.checked.add(chip.id);
        } else {
          state.checked.delete(chip.id);
        }
        label.toggleClass("is-checked", checkbox.checked);
        onToggle();
      });
      label.createSpan({ cls: "places-classify-chip-icon", text: chip.icon });
      label.createSpan({ cls: "places-classify-chip-name", text: chip.name });
      if (chip.distanceLabel) {
        label.createSpan({ cls: "places-classify-chip-distance", text: chip.distanceLabel });
      }
    }
  }
}
