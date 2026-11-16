import { App, MarkdownPostProcessorContext, TFile, normalizePath } from "obsidian";
import { formatKmInSystem, formatMetersInSystem, meters, UnitsSystem } from "places-shared/units";
import { HostMapSurfaceHandle, IPlacesHostServices, resolveHostMapConfig } from "places-shared/obsidian/services";
import { ITrackMatchService, MatchedWay, TrackMatchCosting, type ApiUsageOrigin } from "places-shared/services";
import { CodeBlockReader, IPlacesExtensionHostSettings, type ResolvedMapConfig, parseBoolean, parseShortDistanceAsMeters } from "places-shared/settings";
import { createMapRenderPlan, resolveCameraIntent, type MapRenderPlan } from "places-shared/render";
import { TrackData } from "places-shared/geo";
import { buildTrackPreviewPlace, MapPlace } from "places-shared/overlay";
import { createFloatingRefreshButton, createLoadingIndicator, renderHoverPlaceholder, RenderStalenessGuard } from "places-shared/obsidian/ui";
import { Utilities, getErrorMessage, renderErrorWithHelp, logger as rootLogger } from "places-shared/utils";
import { detectRouteType, getRouteTypeLabel, RouteTypeResult } from "./RouteTypeDetector";
import { containmentQueryPoints } from "./TrackKeyPoints";
import { OverpassTrackService } from "./OverpassTrackService";
import { TrackMatchRequestCache } from "./TrackMatchRequestCache";
import { ClassifyMapControls } from "./ClassifyMapControls";
import { composeSequenceName, defaultSelectionIds, namesAreSimilar, pickDestination, routeSuffixLabel, wayId, ROUTE_SUFFIX_ID, DATE_PREFIX_ID, SequenceItem } from "./NameComposer";
import { CandidateKind, CANDIDATE_KIND_ICONS, FeatureCandidate } from "./ClassifyTypes";
const logger = rootLogger.scope("places-classify");

const DEFAULT_CORRIDOR_RADIUS_METERS = 100;
// Cap on nearby (non-containing) features shown as chips; corridors through towns return dozens of shops.
const MAX_NEARBY_FEATURES = 20;
const TRACK_COLOR = "#3b82f6";
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

export function trackMatchFailureMessage(error: unknown): string {
  const message = getErrorMessage(error);

  if (/timed out|timeout|ERR_CONNECTION_TIMED_OUT/i.test(message)) {
    return "Track matching timed out. Reclassify to try again.";
  }

  return `Track matching failed: ${message}`;
}

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
  private readonly trackMatchRequests = new TrackMatchRequestCache();
  constructor(private app: App, private mainSettings: IPlacesExtensionHostSettings, private host: IPlacesHostServices) {}

  private get units(): UnitsSystem {
    return this.mainSettings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, refreshMatch = false): Promise<void> {
    if (renderHoverPlaceholder(el, "🏷️ Classify preview not available in hover")) return;

    createFloatingRefreshButton({
      ctx,
      buttonContainer: el.createDiv("places-floating-buttons"),
      ariaLabel: "Reclassify track",
      onRefresh: async () => {
        this.host.maps.disposeMapSurfaces(el);
        el.empty();

        await this.processCodeBlock(source, el, ctx, true);
      },
      onError: error => logger.error("Reclassify track failed:", error),
    });

    const stalenessGuard = new RenderStalenessGuard(el);

    ctx.addChild(stalenessGuard);
    const runToken = Symbol("classify-run");

    latestRunByElement.set(el, runToken);
    const isStale = () => stalenessGuard.superseded || latestRunByElement.get(el) !== runToken;

    let settings: ClassifyBlockSettings;
    let trackInput: string;
    const loading = createLoadingIndicator(el, "Loading track...");

    let trackData: TrackData;

    try {
      settings = this.parseSettings(source);
      trackInput = settings.track || `"${ctx.sourcePath}"`;
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
    this.renderProgressive(el, ctx, settings, trackInput, trackData, isStale, refreshMatch);
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

  private resolveMatchService(requested: string | undefined, origin: ApiUsageOrigin): { service?: ITrackMatchService; name?: string; error?: string } {
    const providerName = requested ?? "valhalla";
    const service = this.host.trackMatch.get(providerName, origin);

    if (service?.isAvailable()) return { service, name: providerName };
    const available = this.host.trackMatch.getNames();

    return {
      error: available.length > 0
        ? `Unknown track match provider "${providerName}". Available: ${available.join(", ")}`
        : "No track match service is installed.",
    };
  }

  private renderProgressive(el: HTMLElement, ctx: MarkdownPostProcessorContext, settings: ClassifyBlockSettings, trackInput: string, trackData: TrackData, isStale: () => boolean, refreshMatch: boolean): void {
    const coordinates = trackData.points.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
    const routeType = detectRouteType(coordinates);
    const origin = { sourcePath: ctx.sourcePath, blockType: 'places-classify' };
    const match = this.resolveMatchService(settings.matchProvider, origin);

    const stateKey = `${ctx.sourcePath}::${trackInput}`;
    const state = selectionByBlock.get(stateKey) ?? { checked: new Set<string>(), waysDefaulted: false, destinationDefaulted: false, suffixDefaulted: false, dateDefaulted: false };

    selectionByBlock.set(stateKey, state);

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
        ...features.map(f => ({ id: f.id, name: f.name, fraction: f.trackFraction, containsTrack: f.containsTrack })),
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
    const mapControlsEl = settings.showMap ? container.createDiv({ cls: "places-classify-map-controls" }) : null;
    const mapWrap: HTMLElement | null = settings.showMap ? container.createDiv({ cls: "places-classify-map-wrap" }) : null;

    const { config: mapConfig } = resolveHostMapConfig(this.host, {
      mapProvider: settings.mapProvider,
      height: settings.height,
      width: settings.width,
      showLabels: false,
      track: { defaultVisibility: "visible", directionArrows: false, outline: false, colorBy: "none" },
      poiDiscovery: false,
      ...(settings.style ? { style: settings.style } : {}),
    }, 1);

    const previewTrack = buildTrackPreviewPlace({
      name: trackData.metadata.name ?? "Track",
      icon: "📍",
      coordinates: trackData.points.map(p => [p.longitude, p.latitude]),
      color: TRACK_COLOR,
      lineStyle: "solid",
    });
    const styleTrack = (opacity: number): MapPlace => ({
      ...previewTrack,
      overlay: {
        ...previewTrack.overlay!,
        style: { ...previewTrack.overlay!.style, weight: 3, opacity },
        geojson: {
          ...previewTrack.overlay!.geojson,
          features: previewTrack.overlay!.geojson.features.map(feature => ({
            ...feature,
            properties: { ...feature.properties, 'stroke-width': 3, 'stroke-opacity': opacity },
          })),
        },
      },
    });
    const trackPlace = styleTrack(0.9);
    const fadedTrackPlace = styleTrack(0.6);

    const featurePlaces = (features: FeatureCandidate[]): MapPlace[] => features.map(f => ({
      id: f.id,
      latitude: f.latitude,
      longitude: f.longitude,
      name: f.name,
      icon: f.icon,
      subtitle: f.containsTrack ? `${KIND_LABELS[f.kind]} · contains route` : `${KIND_LABELS[f.kind]} · ${formatMetersInSystem(meters(f.distanceMeters), this.units)} from track`,
    }));

    const wayPlaces = (): MapPlace[] => ways.filter(way => wayId(way) === mapControls?.inspectedWayId && way.segments?.some(segment => segment.length > 1)).map(way => {
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
        markerEnabled: false,
        subtitle: [kindLabel, way.surface, percent !== undefined ? `${percent}% of track` : undefined].filter(Boolean).join(' · '),
        trackDefaultVisibility: 'visible',
        overlay: {
          geojson: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: { stroke: WAY_COLOR, 'stroke-width': 3, 'stroke-opacity': 0.65 },
              geometry: { type: 'MultiLineString', coordinates: segments.map(segment => segment.map(point => [point.longitude, point.latitude])) },
            }],
          },
          style: { color: WAY_COLOR, weight: 3, opacity: 0.65, style: 'solid' },
        },
      };
    });

    const pushMapPlaces = async () => {
      if (!mapWrap || isStale()) return;
      const surface = await mapReady;

      if (!surface || isStale()) return;
      const inspectedWays = wayPlaces();
      const places = mapControls?.showMapOnly ? [] : [
        inspectedWays.length ? fadedTrackPlace : trackPlace,
        ...inspectedWays,
        ...featurePlaces(visibleFeatures()),
      ];
      const updated = await surface.update(this.mapPlan(ctx, mapConfig, places, true));

      if (!updated) {
        logger.debug("Feature marker update was rejected by the map provider");
      }
    };

    const mapReady: Promise<HostMapSurfaceHandle | null> = mapWrap
      ? this.host.maps.renderMapSurface({
        host: mapWrap,
        mapContainerClass: "places-classify-map",
        height: settings.height,
        providerName: settings.mapProvider,
        ctx,
        renderPlan: this.mapPlan(ctx, mapConfig, [trackPlace]),
        isStale,
      })
      : Promise.resolve(null);
    const mapControls = mapControlsEl ? new ClassifyMapControls(mapControlsEl, () => {
      void pushMapPlaces().catch(error => logger.warn("Classify map preview update failed", error));
    }) : undefined;

    const refresh = (redrawChips = true) => {
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

      if (redrawChips) this.renderChips(chipsEl, ways, features, routeType, state, dateLabel, Number(trackData.metrics.distance), waysPending, featuresPending, () => refresh(false), mapControls);
    };

    const addWarning = (text: string) => {
      if (isStale()) return;
      warningsEl.createDiv({ cls: "places-classify-meta places-classify-meta-warning", text });
    };

    if (match.error) addWarning(match.error);
    for (const error of settings.featureErrors) addWarning(error);

    refresh();

    const waysPromise = match.service
      ? this.trackMatchRequests.match(match.service, coordinates, settings.costing, refreshMatch).then(async result => {
        ways = result.ways;
        visibleFeatureCache = null;

        if (!state.waysDefaulted) {
          state.waysDefaulted = true;
          for (const id of defaultSelectionIds(ways, [])) state.checked.add(id);
        }

        await pushMapPlaces();
      }, (error: unknown) => {
        if (isStale()) return;
        logger.warn("Track match failed", error);
        addWarning(trackMatchFailureMessage(error));
      }).finally(() => {
        waysPending = false;
        refresh();
      })
      : Promise.resolve();

    const allowedKind = (f: FeatureCandidate) => !settings.features || settings.features.has(f.kind);
    const featuresPromise = this.overpassService.queryTrackContext(coordinates, settings.radiusMeters, containmentQueryPoints(trackData.points), origin).then(async context => {
      corridor = context.corridor.filter(allowedKind);
      containing = context.containing.filter(allowedKind);
      visibleFeatureCache = null;

      await pushMapPlaces();
    }, (error: unknown) => {
      logger.warn("Feature discovery failed", error);
      addWarning(`Feature discovery failed: ${getErrorMessage(error)}`);
    }).finally(() => {
      featuresPending = false;
      refresh();
    });

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
    const button = container.createEl("button", { cls: "mod-cta places-classify-rename", text: "Rename note" });
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

  private mapPlan(ctx: MarkdownPostProcessorContext, config: ResolvedMapConfig, places: MapPlace[], preserveCamera = false): MapRenderPlan {
    const source = { path: ctx.sourcePath };
    const camera = preserveCamera ? { kind: 'preserve' } as const : resolveCameraIntent(config, source);

    return createMapRenderPlan({ surfaceKind: 'other', places, config, clusteringEnabled: false, source, camera });
  }

  private renderChips(chipsEl: HTMLElement, ways: MatchedWay[], features: FeatureCandidate[], routeType: RouteTypeResult, state: BlockSelectionState, dateLabel: string | undefined, trackKm: number, waysPending: boolean, featuresPending: boolean, onToggle: () => void, mapControls?: ClassifyMapControls): void {
    const focused = chipsEl.ownerDocument.activeElement;
    const focusedChip = focused?.closest<HTMLElement>(".places-classify-chip");
    const focusedId = focusedChip && chipsEl.contains(focusedChip) ? focusedChip.dataset.chipId : undefined;
    const focusedInspect = focused?.classList.contains("places-classify-inspect");

    mapControls?.resetChips();
    chipsEl.empty();

    interface Chip {
      id: string;
      icon: string;
      name: string;
      fraction: number;
      detail: string;
      distanceLabel?: string;
      inspectable?: boolean;
    }

    const wayFraction = (way: MatchedWay, index: number) => way.startFraction ?? (ways.length > 1 ? index / (ways.length - 1) : 0);
    const trackPercent = (way: MatchedWay) => trackKm > 0 ? Math.min(100, Math.round(Number(way.lengthKm) / trackKm * 100)) : Math.round(way.coverage * 100);
    const chips: Chip[] = [
      ...ways.map((way, index) => ({
        id: wayId(way),
        icon: way.use === 'ferry' ? "⛴️" : "〰️",
        name: way.name,
        fraction: wayFraction(way, index),
        detail: way.use === 'ferry' ? `ferry route · ${trackPercent(way)}% of track` : `${trackPercent(way)}% of track`,
        inspectable: way.segments?.some(segment => segment.length > 1),
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
      const chipEl = chipsEl.createDiv({ cls: "places-classify-chip" });

      chipEl.dataset.chipId = chip.id;
      const label = chipEl.createEl("label", { cls: "places-classify-chip-select" });

      label.title = chip.detail;
      const checkbox = label.createEl("input", { type: "checkbox" });

      checkbox.checked = state.checked.has(chip.id);
      chipEl.toggleClass("is-checked", checkbox.checked);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.checked.add(chip.id);
        } else {
          state.checked.delete(chip.id);
        }

        chipEl.toggleClass("is-checked", checkbox.checked);
        onToggle();
      });
      label.createSpan({ cls: "places-classify-chip-icon", text: chip.icon });
      label.createSpan({ cls: "places-classify-chip-name", text: chip.name });

      if (chip.distanceLabel) {
        label.createSpan({ cls: "places-classify-chip-distance", text: chip.distanceLabel });
      }

      if (chip.inspectable) mapControls?.bindWay(chipEl, chip.id, chip.name);

      if (chip.id === focusedId) {
        const target = focusedInspect ? chipEl.querySelector<HTMLButtonElement>(".places-classify-inspect") : checkbox;

        target?.focus({ preventScroll: true });
      }
    }
  }
}
