import { normalizePath, Notice, setIcon, type App } from 'obsidian';
import type * as GeoJSON from 'geojson';
import { addTrackBuilderWaypoint, appendTrackBuilderSection, appendTrackBuilderSections, clearTrackBuilderDraft, getTrackBuilderHistory, insertDirectTrackBuilderSection, prependTrackBuilderSections, redoTrackBuilderEdit, removeLastTrackBuilderSection, removeTrackBuilderWaypoint, replaceTrackBuilderContent, reverseTrackBuilderSection, replaceTrackBuilderSection, replaceTrackBuilderSections, serializeTrackBuilderGpx, trackBuilderDraftKey, trackBuilderSegments, trackBuilderWaypoints, trackDataToTrackBuilderSections, trackDataToTrackBuilderWaypoints, undoTrackBuilderEdit, updateTrackBuilderWaypoint, type TrackBuilderCoordinate, type TrackBuilderLinePosition, type TrackBuilderSection, type TrackBuilderSectionEndpoint, type TrackBuilderWaypoint } from 'places-utilities/core';
import { ensureTrackDirectionArrowImage, resolveWaypointIcon } from "places-shared/map";
import type { MapSourceContext, MapTrackLoader, TrackBuilderConfig } from "places-shared/settings";
import type { TrackData } from "places-shared/geo";
import { getErrorMessage, hashString36, logger, PLACES_EXPORTS_FOLDER, sharedRegistryMap, Utilities } from "places-shared/utils";
import { downloadOrCopy } from "places-shared/obsidian/utils";
import type { PlaceNoteHost } from "places-shared/map";
import { km } from "places-shared/units";
import { coordinateFromPosition, DistanceCalculator } from "places-shared/geo";
import type * as maplibregl from 'maplibre-gl';
import { isTrackBuilderTurnaround, uniqueTrackBuilderRayCount, type TrackBuilderScreenPoint } from './TrackBuilderDirectEndpoints';
import { areTrackBuilderJunctionSectionsCompatible, closestCompatibleTrackBuilderJunction, compatibleTrackBuilderJunctions } from './TrackBuilderJunction';
import { findTrackBuilderRecordingGaps, replaceTrackBuilderRangesWithMapSections, traceTrackBuilderMapPath, type TrackBuilderMapSnapMatch, type TrackBuilderMapSnapPoint, type TrackBuilderMapSnapReplacement } from './TrackBuilderMapSnap';
import { bestTrackBuilderContinuation, closestTrackBuilderLinePosition, localSelectionRange, normalizeTrackBuilderSelectionRanges, prioritizeTrackBuilderVertexPosition, shouldSplitTrackBuilderGesture, trackBuilderSelectionProfile, wholeTrackBuilderSectionRange, type TrackBuilderContinuationCandidate, type TrackBuilderSelectionIntensity, type TrackBuilderSelectionPoint } from './TrackBuilderSelection';
import { closestTrackBuilderProjectedPosition, createTrackBuilderCandidateIndex, trackBuilderCandidateBounds, trackBuilderCandidatesAt, type TrackBuilderCandidateIndex, type TrackBuilderCandidateBounds, type TrackBuilderProjectedCandidate } from './TrackBuilderSpatialIndex';
import { TrackBuilderWaypointModal } from './TrackBuilderWaypointModal';
import { chooseTrackEndpointContinuation, clipEndpointOverlapSamples, connectedTracePrefix, expandRepeatedFeatureBacktracks, resolveCenterBasedTraceRun, shouldBridgeNearbyTrackEndpoint, shouldKeepPreferredTrackCandidate, shouldTrimEndpointToCurrentSource, TRACK_BRIDGE_MAX_DISTANCE_METERS, type TrackOverlapSample } from './TrackBuilderTrace';
import { comparePositions, coordinateDistanceSquared, interpolateLine, positionsEqual, sectionLogData, sectionLogSummary, sliceLine } from './TrackBuilderControllerSupport';

// Between the open picker and the map's top edge.
const LAYER_PICKER_EDGE_GAP = 12;
// Below this the picker overhangs the map instead of shrinking.
const LAYER_PICKER_MIN_HEIGHT = 120;

const DRAFT_SOURCE = 'places-track-builder-draft';
const HOVER_SOURCE = 'places-track-builder-hover';
const DIRECT_PREVIEW_SOURCE = 'places-track-builder-direct-preview';
const SNAP_PREVIEW_SOURCE = 'places-track-builder-snap-preview';
const DRAFT_OUTLINE_LAYER = 'places-track-builder-draft-outline';
const DRAFT_LAYER = 'places-track-builder-draft-line';
const DRAFT_DIRECT_LAYER = 'places-track-builder-draft-direct';
const DIRECTION_LAYER = 'places-track-builder-direction';
const HOVER_LAYER = 'places-track-builder-hover-line';
const DIRECT_PREVIEW_LAYER = 'places-track-builder-direct-preview-line';
const SNAP_PREVIEW_OUTLINE_LAYER = 'places-track-builder-snap-preview-outline';
const SNAP_PREVIEW_LAYER = 'places-track-builder-snap-preview-line';
const CONTIGUOUS_MAX_SCREEN_DISTANCE_PIXELS = 2;
const CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS = 1;
const ADD_OVERLAP_SAMPLE_SPACING_PIXELS = 3;
const ADD_OVERLAP_MAX_SCREEN_DISTANCE_PIXELS = 7;
const ADD_OVERLAP_MAX_GEOGRAPHIC_DISTANCE_METERS = 20;
const DIRECT_ENDPOINT_SNAP_DISTANCE_PIXELS = 14;
const DIRECT_ENDPOINT_JOIN_TOLERANCE_METERS = 5;
const MAP_SNAP_DEFAULT_RADIUS_METERS = 20;
const MAP_SNAP_MAX_RADIUS_PIXELS = 96;
const MAP_SNAP_SAMPLE_SPACING_PIXELS = 3;
const JUNCTION_MAX_SCREEN_DISTANCE_PIXELS = 10;
const JUNCTION_MAX_GEOGRAPHIC_DISTANCE_METERS = 12;
const CONFIGURED_TRACK_STATE_KEY = Symbol.for('places.map.track-builder-configured-tracks');

interface ConfiguredTrackState {
  readonly path: string;
  readonly name?: string;
}

function configuredTrackStates(): Map<string, ConfiguredTrackState> {
  return sharedRegistryMap<string, ConfiguredTrackState>(CONFIGURED_TRACK_STATE_KEY);
}

interface TrackBuilderControllerOptions {
  readonly app: App;
  readonly map: maplibregl.Map;
  readonly Marker: typeof maplibregl.Marker;
  readonly container: HTMLElement;
  readonly source: MapSourceContext;
  readonly config: TrackBuilderConfig;
  readonly placeNoteHost?: PlaceNoteHost;
  readonly runProgrammaticCamera: (move: () => void) => void;
  readonly trackLoader?: MapTrackLoader;
}

interface DragTraceRun {
  readonly candidate: TrackBuilderSection;
  readonly start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

interface DeleteSelection {
  readonly sectionId: string;
  start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

interface TrackBuilderRange {
  start: TrackBuilderLinePosition;
  end: TrackBuilderLinePosition;
}

interface SnapSelection extends DeleteSelection {
  ranges: TrackBuilderRange[];
}

interface SnapRangePreview extends TrackBuilderMapSnapReplacement {
  readonly inputPointCount: number;
  readonly sampleCount: number;
  readonly sampleSpacingPixels: number;
  readonly matchedSampleCount: number;
  readonly candidateCount: number;
  readonly candidatePreparationMs: number;
  readonly traceMs: number;
  readonly sectionBuildMs: number;
  readonly matchedPreferredCandidate: boolean;
}

interface SnapPreview {
  readonly inputPointCount: number;
  readonly sampleCount: number;
  readonly sampleSpacingPixels: number;
  readonly matchedSampleCount: number;
  readonly candidateCount: number;
  readonly candidatePreparationMs: number;
  readonly traceMs: number;
  readonly sectionBuildMs: number;
  readonly mappedSections: readonly TrackBuilderSection[];
  readonly replacements: readonly SnapRangePreview[];
}

interface SnapGraphEdge {
  readonly to: string;
  readonly weight: number;
  readonly candidate?: TrackBuilderSection;
  readonly start?: TrackBuilderLinePosition;
  readonly end?: TrackBuilderLinePosition;
}

type SnapCandidate = TrackBuilderProjectedCandidate<TrackBuilderSection>;
type SnapCandidateIndex = TrackBuilderCandidateIndex<TrackBuilderSection>;

interface DirectEndpointAnchor {
  readonly id: string;
  readonly sectionId?: string;
  readonly endpoint?: 'start' | 'end';
  readonly coordinate: TrackBuilderCoordinate;
}

interface DraftOverlapContact {
  readonly section: TrackBuilderSection;
  readonly position: TrackBuilderLinePosition;
  readonly coordinate: TrackBuilderCoordinate;
  readonly screenDistancePixels: number;
  readonly geographicDistanceMeters: number;
}

interface ClippedAddedSection {
  readonly section: TrackBuilderSection;
  readonly startContact?: DraftOverlapContact;
  readonly endContact?: DraftOverlapContact;
}

interface SelectableLayerGroup {
  readonly sourceLayer?: string;
  readonly layers: readonly { id: string; count: number }[];
}

type TrackBuilderMode = 'idle' | 'build' | 'delete' | 'direct' | 'join' | 'snap' | 'waypoint';

export class TrackBuilderController {
  private readonly key: string;
  private readonly toolbar: HTMLElement;
  private readonly status: HTMLElement;
  private selectionIntensity: TrackBuilderSelectionIntensity = 3;
  private selectionIntensityControl?: HTMLElement;
  private selectionIntensityOutput?: HTMLOutputElement;
  private readonly selectableLayers: Set<string>;
  private layerSelectionCustomized = false;
  private layerPicker?: HTMLElement;
  private layerPickerButton?: HTMLButtonElement;
  private mode: TrackBuilderMode = 'idle';
  private get active(): boolean { return this.mode === 'build'; }
  private get deleting(): boolean { return this.mode === 'delete'; }
  private get direct(): boolean { return this.mode === 'direct' || this.mode === 'join'; }
  private get snapping(): boolean { return this.mode === 'snap'; }
  private get joining(): boolean { return this.mode === 'join'; }
  private get waypointing(): boolean { return this.mode === 'waypoint'; }
  private snapSelection?: SnapSelection;
  private snapActions?: HTMLElement;
  private snapApplyButton?: HTMLButtonElement;
  private snapWholeButton?: HTMLButtonElement;
  private snapRadiusMeters: number;
  private snapRadiusOutput?: HTMLOutputElement;
  private snapTargetOutput?: HTMLOutputElement;
  private snapPreferredCandidate?: TrackBuilderSection;
  private snapPreview?: SnapPreview;
  private snapPreviewError?: string;
  private directAnchor?: DirectEndpointAnchor | { readonly coordinate: TrackBuilderCoordinate };
  private waypointActions?: HTMLElement;
  private selectedWaypointId?: string;
  private waypointMarkers: Array<{ readonly id: string; readonly marker: maplibregl.Marker }> = [];
  private deleteSelections: DeleteSelection[] = [];
  private deleteActions?: HTMLElement;
  private importedName?: string;
  private destroyed = false;
  private candidate?: TrackBuilderSection;
  private candidateSelection: TrackBuilderSection[] = [];
  private candidateStartsNewPiece = false;
  private candidatePoint?: maplibregl.Point;
  private statusHoldUntil = 0;
  private statusHoldTimer?: number;
  private adjacencyCandidateCache?: { readonly signature: string; readonly expiresAt: number; readonly sections: TrackBuilderSection[] };
  private handleMarkers: maplibregl.Marker[] = [];
  private readonly candidateDistances = new Map<string, number>();
  private cancelActiveDrag?: () => void;
  private readonly onMouseMove = (event: maplibregl.MapMouseEvent) => this.handleMouseMove(event);
  private readonly onClick = (event: maplibregl.MapMouseEvent) => this.handleClick(event);
  private readonly onMoveEnd = () => {
    this.adjacencyCandidateCache = undefined;
    if (this.snapping && this.snapSelection) this.updateSnapPreview();
    if (this.layerPicker && !this.layerPicker.hidden) this.renderLayerPicker();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (this.layerPicker?.hidden || this.toolbar.contains(event.target as Node)) return;
    this.setLayerPickerOpen(false);
  };

  constructor(private readonly options: TrackBuilderControllerOptions) {
    this.key = trackBuilderDraftKey(options.source, options.config.id);
    this.snapRadiusMeters = options.config.snapRadiusMeters ?? MAP_SNAP_DEFAULT_RADIUS_METERS;
    this.selectableLayers = new Set(options.config.selectableLayers);
    this.toolbar = options.container.createDiv({ cls: 'places-track-builder-controls' });
    this.status = this.toolbar.createSpan({ cls: 'places-track-builder-status' });
  }

  setup(): void {
    this.addSourcesAndLayers();
    const buildControl = this.toolbar.createDiv({ cls: 'places-track-builder-build-control' });

    this.addButton('route', 'Build track', () => this.setMode(this.active ? 'idle' : 'build'), 'places-track-builder-toggle', buildControl);
    this.createSelectionIntensityControl(buildControl);
    this.createLayerPicker();
    this.addButton('move-up-right', 'Draw direct line', () => this.setMode(this.direct ? 'idle' : 'direct'), 'places-track-builder-direct');
    this.addButton('git-merge', 'Join two track endpoints', () => this.setMode(this.joining ? 'idle' : 'join'), 'places-track-builder-join');
    const snapControl = this.toolbar.createDiv({ cls: 'places-track-builder-snap-control' });

    this.addButton('magnet', 'Snap a GPX portion to visible roads or trails', () => this.setMode(this.snapping ? 'idle' : 'snap'), 'places-track-builder-snap', snapControl);
    this.createSnapActions(snapControl);
    this.addButton('undo-2', 'Undo selection', () => { undoTrackBuilderEdit(this.key); this.render(); });
    this.addButton('redo-2', 'Redo selection', () => { redoTrackBuilderEdit(this.key); this.render(); });
    this.addButton('arrow-left-right', 'Reverse track direction', () => this.reverseDirection());
    this.addButton('minus', 'Remove last section', () => { removeLastTrackBuilderSection(this.key); this.render(); });
    const waypointControl = this.toolbar.createDiv({ cls: 'places-track-builder-waypoint-control' });

    this.addButton('map-pin', 'Add, move, or edit waypoints', () => this.setMode(this.waypointing ? 'idle' : 'waypoint'), 'places-track-builder-waypoint', waypointControl);
    this.waypointActions = waypointControl.createDiv({ cls: 'places-track-builder-waypoint-actions', attr: { 'aria-label': 'Waypoint actions' } });
    this.addButton('pencil', 'Edit the selected waypoint', () => this.editSelectedWaypoint(), 'places-track-builder-waypoint-edit', this.waypointActions);
    this.addButton('trash', 'Delete the selected waypoint', () => this.deleteSelectedWaypoint(), 'places-track-builder-waypoint-delete', this.waypointActions);
    const deleteControl = this.toolbar.createDiv({ cls: 'places-track-builder-delete-control' });

    this.addButton('eraser', 'Delete or trim a section', () => this.setMode(this.deleting ? 'idle' : 'delete'), 'places-track-builder-delete', deleteControl);
    this.deleteActions = deleteControl.createDiv({ cls: 'places-track-builder-delete-actions', attr: { 'aria-label': 'Delete selection actions' } });
    this.addButton('maximize-2', 'Select the whole section', () => this.selectWholeDeleteSections(), 'places-track-builder-delete-whole', this.deleteActions);
    this.addButton('check', 'Delete selected section or trimmed portion', () => this.applyDeleteSelection(), 'places-track-builder-delete-apply', this.deleteActions);
    this.addButton('x', 'Cancel delete selection', () => this.clearDeleteSelection(), 'places-track-builder-delete-cancel', this.deleteActions);
    this.addButton('trash-2', 'Clear track', () => { clearTrackBuilderDraft(this.key); this.render(); });
    const exportControl = this.toolbar.createDiv({ cls: 'places-track-builder-export-control' });

    this.addButton('download', 'Save as GPX', () => void this.exportGpx(), 'places-track-builder-export-gpx', exportControl);
    if (this.options.placeNoteHost) this.addButton('file-plus-2', 'Create track note', () => void this.createTrackNote(), 'places-track-builder-export-note', exportControl);
    this.options.map.on('mousemove', this.onMouseMove);
    this.options.map.on('click', this.onClick);
    this.options.map.on('moveend', this.onMoveEnd);
    this.options.container.ownerDocument.addEventListener('keydown', this.onKeyDown);
    this.options.container.ownerDocument.addEventListener('pointerdown', this.onDocumentPointerDown);
    logger.scope('TrackBuilder').debug('track builder ready', {
      draftKey: this.key,
      source: this.options.source,
      config: this.options.config,
      restoredSections: getTrackBuilderHistory(this.key).draft.sections.map(sectionLogData),
    });
    this.render();
    const configuredTracks = this.options.config.tracks.length > 0
      ? this.options.config.tracks
      : this.currentNoteTrackSetting();

    if (configuredTracks.length > 0) void this.loadConfiguredTracks(configuredTracks);
  }

  // Use this Markdown note's stored track when an empty builder block is embedded in it.
  private currentNoteTrackSetting(): readonly string[] {
    const sourcePath = this.options.source.path;

    if (!sourcePath?.toLowerCase().endsWith('.md')) return [];
    const file = this.options.app.vault.getFileByPath(normalizePath(sourcePath));

    if (!file) return [];
    const frontmatter = this.options.app.metadataCache.getFileCache(file)?.frontmatter;

    if (!frontmatter?.['Overlay Source'] && !frontmatter?.['Overlay Cache']) return [];

    return [sourcePath];
  }

  destroy(): void {
    this.destroyed = true;
    if (this.statusHoldTimer !== undefined) window.clearTimeout(this.statusHoldTimer);
    this.options.map.off('mousemove', this.onMouseMove);
    this.options.map.off('click', this.onClick);
    this.options.map.off('moveend', this.onMoveEnd);
    this.options.container.ownerDocument.removeEventListener('keydown', this.onKeyDown);
    this.options.container.ownerDocument.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.options.container.classList.remove('places-track-builder-active');
    this.clearHandleMarkers();
    this.clearWaypointMarkers();
    this.toolbar.remove();
  }

  private addSourcesAndLayers(): void {
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    this.options.map.addSource(DRAFT_SOURCE, { type: 'geojson', data: empty });
    this.options.map.addSource(HOVER_SOURCE, { type: 'geojson', data: empty });
    this.options.map.addSource(DIRECT_PREVIEW_SOURCE, { type: 'geojson', data: empty });
    this.options.map.addSource(SNAP_PREVIEW_SOURCE, { type: 'geojson', data: empty });
    this.options.map.addLayer({ id: DRAFT_OUTLINE_LAYER, type: 'line', source: DRAFT_SOURCE, filter: ['!=', ['get', 'routingMode'], 'direct'], paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
    this.options.map.addLayer({ id: DRAFT_LAYER, type: 'line', source: DRAFT_SOURCE, filter: ['!=', ['get', 'routingMode'], 'direct'], paint: { 'line-color': '#7c3aed', 'line-width': 4 } });
    this.options.map.addLayer({ id: DRAFT_DIRECT_LAYER, type: 'line', source: DRAFT_SOURCE, filter: ['==', ['get', 'routingMode'], 'direct'], paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [2, 1.5] } });
    const directionImage = ensureTrackDirectionArrowImage(this.options.map);

    this.options.map.addLayer({ id: DIRECTION_LAYER, type: 'symbol', source: DRAFT_SOURCE, layout: { 'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 10, 340, 14, 260, 18, 180], 'icon-image': directionImage, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 12, 1.05, 14, 1.4, 16, 1.875], 'icon-anchor': 'center', 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-keep-upright': false, 'icon-allow-overlap': false, 'icon-ignore-placement': true, 'icon-padding': 8 }, paint: { 'icon-color': '#7c3aed', 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.25 } });
    this.options.map.addLayer({
      id: HOVER_LAYER,
      type: 'line',
      source: HOVER_SOURCE,
      paint: {
        // "new-piece" is a build hover that reaches no open end: clicking it
        // starts a separate segment rather than extending the route, and gets
        // a color of its own rather than the amber that means "continues here".
        'line-color': ['case',
          ['==', ['get', 'action'], 'delete'], '#ef4444',
          ['==', ['get', 'action'], 'new-piece'], '#ec4899',
          ['==', ['get', 'action'], 'snap'], '#0891b2',
          '#f59e0b',
        ],
        'line-width': 5,
        'line-opacity': 0.9,
      },
    });
    this.options.map.addLayer({ id: DIRECT_PREVIEW_LAYER, type: 'line', source: DIRECT_PREVIEW_SOURCE, paint: { 'line-color': '#f59e0b', 'line-width': 5, 'line-opacity': 0.9, 'line-dasharray': [2, 1.5] } });
    this.options.map.addLayer({ id: SNAP_PREVIEW_OUTLINE_LAYER, type: 'line', source: SNAP_PREVIEW_SOURCE, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 } });
    this.options.map.addLayer({ id: SNAP_PREVIEW_LAYER, type: 'line', source: SNAP_PREVIEW_SOURCE, paint: { 'line-color': '#16a34a', 'line-width': 5, 'line-opacity': 0.95, 'line-dasharray': [2, 1.25] } });
  }

  private addButton(icon: string, label: string, action: () => void, className = '', parent: HTMLElement = this.toolbar): HTMLButtonElement {
    const button = parent.createEl('button', { cls: `clickable-icon ${className}`.trim(), attr: { type: 'button', 'aria-label': label, title: label } });

    setIcon(button, icon);
    button.addEventListener('click', event => { event.stopPropagation(); action(); });

    return button;
  }

  private createLayerPicker(): void {
    const control = this.toolbar.createDiv({ cls: 'places-track-builder-layer-control' });

    this.layerPickerButton = this.addButton('layers-3', 'Choose selectable map layers', () => {
      this.setLayerPickerOpen(this.layerPicker?.hidden !== false);
    }, 'places-track-builder-layers', control);
    this.layerPicker = control.createDiv({
      cls: 'places-track-builder-layer-picker',
      attr: { role: 'dialog', 'aria-label': 'Selectable map layers' },
    });
    this.layerPicker.addEventListener('click', event => event.stopPropagation());
    this.layerPicker.hidden = true;
  }

  private setLayerPickerOpen(open: boolean): void {
    if (!this.layerPicker) return;
    this.layerPicker.hidden = !open;
    this.layerPickerButton?.classList.toggle('is-active', open);
    this.layerPickerButton?.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.renderLayerPicker();
    this.constrainLayerPickerHeight();
  }

  // The picker opens upward (the toolbar sits on the map's bottom edge);
  // capped at the space above it, the list scrolls inside the map.
  private constrainLayerPickerHeight(): void {
    if (!this.layerPicker || !this.layerPickerButton) return;
    const mapTop = this.options.map.getContainer().getBoundingClientRect().top;
    const available = this.layerPickerButton.getBoundingClientRect().top - mapTop - LAYER_PICKER_EDGE_GAP;

    this.layerPicker.style.setProperty('--places-layer-picker-max-height', `${Math.max(LAYER_PICKER_MIN_HEIGHT, Math.round(available))}px`);
  }

  private discoverSelectableLayerGroups(): SelectableLayerGroup[] {
    const counts = new Map<string, number>();

    for (const feature of this.options.map.queryRenderedFeatures()) {
      if (feature.geometry.type !== 'LineString' && feature.geometry.type !== 'MultiLineString') continue;
      const id = feature.layer?.id;

      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const groups = new Map<string, { sourceLayer?: string; layers: { id: string; count: number }[] }>();

    for (const styleLayer of this.options.map.getStyle().layers ?? []) {
      if (styleLayer.type !== 'line' || styleLayer.id.startsWith('places-')) continue;
      const sourceLayer = 'source-layer' in styleLayer && typeof styleLayer['source-layer'] === 'string'
        ? styleLayer['source-layer']
        : undefined;
      const key = sourceLayer ?? '';
      const group = groups.get(key) ?? { sourceLayer, layers: [] };

      group.layers.push({ id: styleLayer.id, count: counts.get(styleLayer.id) ?? 0 });
      groups.set(key, group);
    }

    return [...groups.values()]
      .map(group => ({ ...group, layers: group.layers.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)) }))
      .sort((a, b) => {
        const aCount = a.layers.reduce((sum, layer) => sum + layer.count, 0);
        const bCount = b.layers.reduce((sum, layer) => sum + layer.count, 0);

        return bCount - aCount || (a.sourceLayer ?? 'Other').localeCompare(b.sourceLayer ?? 'Other');
      });
  }

  private renderLayerPicker(): void {
    if (!this.layerPicker) return;
    this.layerPicker.empty();
    const header = this.layerPicker.createDiv({ cls: 'places-track-builder-layer-picker-header' });

    header.createEl('strong', { text: 'Selectable layers' });
    header.createSpan({ text: 'Visible feature counts' });
    this.addButton(
      'clipboard-copy',
      'Copy this selection as a selectableLayers setting',
      () => this.copySelectableLayersSetting(),
      'places-track-builder-layer-copy',
      header,
    );
    const groups = this.discoverSelectableLayerGroups();

    if (groups.length === 0) {
      this.layerPicker.createDiv({ cls: 'places-track-builder-layer-empty', text: 'No selectable line layers are available in this style.' });

      return;
    }

    for (const group of groups) {
      const section = this.layerPicker.createDiv({ cls: 'places-track-builder-layer-group' });

      if (group.sourceLayer) {
        this.createLayerCheckbox(
          section,
          group.sourceLayer,
          group.sourceLayer,
          group.layers.reduce((sum, layer) => sum + layer.count, 0),
          true,
          group.layers.map(layer => layer.id),
        );
      } else {
        section.createDiv({ cls: 'places-track-builder-layer-group-title', text: 'Rendered layers' });
      }

      const children = section.createDiv({ cls: 'places-track-builder-layer-children' });

      for (const layer of group.layers) {
        this.createLayerCheckbox(children, layer.id, layer.id, layer.count, false, group.layers.map(item => item.id), group.sourceLayer);
      }
    }
  }

  // The block is not rewritten in place: a tool only knows the fence's line
  // number from when it rendered, and that number goes stale as soon as the
  // note is edited above it.
  private copySelectableLayersSetting(): void {
    // An empty, never-customized set means "everything"; copy the expansion
    // rather than an empty list.
    const selected = !this.layerSelectionCustomized && this.selectableLayers.size === 0
      ? this.discoverSelectableLayerGroups().flatMap(group => group.sourceLayer ? [group.sourceLayer] : group.layers.map(layer => layer.id))
      : [...this.selectableLayers];

    if (selected.length === 0) {
      new Notice('Select at least one layer to copy a setting.');

      return;
    }

    const quoted = selected.map(layer => (/^[A-Za-z0-9_-]+$/.test(layer) ? layer : `"${layer}"`));
    const setting = `selectableLayers: [${quoted.join(', ')}]`;

    void navigator.clipboard.writeText(setting).then(
      () => new Notice(`Copied: ${setting}`),
      () => new Notice('Could not copy the setting to the clipboard.'),
    );
    logger.scope('TrackBuilder').debug('selectable layers copied', { draftKey: this.key, setting });
  }

  private createLayerCheckbox(parent: HTMLElement, value: string, label: string, count: number, group: boolean, siblingLayerIds: readonly string[], sourceLayer?: string): void {
    const row = parent.createEl('label', { cls: `places-track-builder-layer-row${group ? ' is-group' : ''}` });
    const input = row.createEl('input', { type: 'checkbox' });

    input.checked = (!this.layerSelectionCustomized && this.selectableLayers.size === 0)
      || this.selectableLayers.has(value)
      || (!group && sourceLayer !== undefined && this.selectableLayers.has(sourceLayer));
    row.createSpan({ cls: 'places-track-builder-layer-name', text: label });
    row.createSpan({ cls: 'places-track-builder-layer-count', text: String(count), attr: { title: `${count} visible line features` } });
    input.addEventListener('change', () => {
      if (!this.layerSelectionCustomized && this.selectableLayers.size === 0) {
        for (const discovered of this.discoverSelectableLayerGroups()) {
          discovered.layers.forEach(layer => this.selectableLayers.add(layer.id));
        }
      }

      this.layerSelectionCustomized = true;

      if (group) {
        if (input.checked) {
          siblingLayerIds.forEach(id => this.selectableLayers.delete(id));
          this.selectableLayers.add(value);
        } else {
          this.selectableLayers.delete(value);
        }
      } else {
        if (sourceLayer && this.selectableLayers.delete(sourceLayer)) {
          siblingLayerIds.filter(id => id !== value).forEach(id => this.selectableLayers.add(id));
        }

        if (input.checked) this.selectableLayers.add(value);
        else this.selectableLayers.delete(value);
      }

      this.adjacencyCandidateCache = undefined;
      this.candidate = undefined;
      this.candidateSelection = [];
      this.candidateStartsNewPiece = false;
      this.setSourceData(HOVER_SOURCE, []);
      logger.scope('TrackBuilder').debug('selectable layers changed', {
        draftKey: this.key,
        selectableLayers: [...this.selectableLayers],
      });
      this.renderLayerPicker();
      this.render();
    });
  }

  private createSelectionIntensityControl(parent: HTMLElement): void {
    const control = parent.createDiv({ cls: 'places-track-builder-selection-intensity', attr: { 'aria-label': 'Selection intensity' } });

    control.addEventListener('click', event => event.stopPropagation());
    control.createSpan({ cls: 'places-track-builder-selection-intensity-label', text: 'Selection' });
    const input = control.createEl('input', {
      cls: 'places-track-builder-selection-intensity-input',
      attr: {
        type: 'range',
        min: '1',
        max: '5',
        step: '1',
        value: String(this.selectionIntensity),
        'aria-label': 'Selection intensity',
      },
    });

    this.selectionIntensityOutput = control.createEl('output', { cls: 'places-track-builder-selection-intensity-output' });
    input.addEventListener('input', () => {
      this.selectionIntensity = Math.max(1, Math.min(5, Number(input.value))) as TrackBuilderSelectionIntensity;
      this.updateSelectionIntensityOutput();
      this.refreshCandidateSelection();
    });
    this.selectionIntensityControl = control;
    control.hidden = true;
    this.updateSelectionIntensityOutput();
  }

  private updateSelectionIntensityOutput(): void {
    const label = trackBuilderSelectionProfile(this.selectionIntensity).label;

    if (this.selectionIntensityOutput) this.selectionIntensityOutput.value = label;
    if (this.active) this.status.setText(label);
  }

  private createSnapActions(parent: HTMLElement): void {
    this.snapActions = parent.createDiv({ cls: 'places-track-builder-snap-actions', attr: { 'aria-label': 'Map feature snapping actions' } });
    this.snapActions.addEventListener('click', event => event.stopPropagation());
    this.snapActions.createSpan({ cls: 'places-track-builder-snap-radius-label', text: 'Distance' });
    const radiusInput = this.snapActions.createEl('input', {
      cls: 'places-track-builder-snap-radius-input',
      attr: {
        type: 'range',
        min: '5',
        max: String(Math.max(100, Math.ceil(this.snapRadiusMeters / 10) * 10)),
        step: '5',
        value: String(this.snapRadiusMeters),
        'aria-label': 'Snap distance in meters',
      },
    });

    this.snapRadiusOutput = this.snapActions.createEl('output', { cls: 'places-track-builder-snap-radius-output' });
    radiusInput.addEventListener('input', () => {
      this.snapRadiusMeters = Number(radiusInput.value);
      this.updateSnapActionOutputs();
      this.updateSnapSelectionDisplay('Release the distance slider to update the preview.');
      this.updateSnapStatus();
    });
    radiusInput.addEventListener('change', () => this.updateSnapPreview());
    this.snapActions.createSpan({ cls: 'places-track-builder-snap-target-label', text: 'Path' });
    this.snapTargetOutput = this.snapActions.createEl('output', { cls: 'places-track-builder-snap-target-output' });
    this.snapActions.createSpan({ cls: 'places-track-builder-snap-target-help', text: 'Click a nearby map path to prefer it' });
    const buttons = this.snapActions.createDiv({ cls: 'places-track-builder-snap-action-buttons' });

    this.snapWholeButton = this.addButton('maximize-2', 'Select the whole section', () => this.selectWholeSnapSection(), 'places-track-builder-snap-whole', buttons);
    this.addButton('scan-search', 'Find and select the largest recording gap', () => this.selectLargestRecordingGap(), 'places-track-builder-snap-gap', buttons);
    this.snapApplyButton = this.addButton('check', 'Apply the green snap preview', () => this.applySnapSelection(), 'places-track-builder-snap-apply', buttons);
    this.addButton('x', 'Cancel snapping', () => this.setMode('idle'), 'places-track-builder-snap-cancel', buttons);
    this.snapActions.hidden = true;
    this.updateSnapActionOutputs();
  }

  private updateSnapActionOutputs(): void {
    if (this.snapRadiusOutput) this.snapRadiusOutput.value = `${this.snapRadiusMeters} m`;

    if (this.snapTargetOutput) {
      const properties = this.snapPreferredCandidate?.sourceProperties;
      const target = this.snapPreferredCandidate?.name
        ?? (typeof properties?.ref === 'string' ? properties.ref : undefined)
        ?? (typeof properties?.class === 'string' ? properties.class : undefined)
        ?? (typeof properties?.subclass === 'string' ? properties.subclass : undefined)
        ?? 'Closest path';

      this.snapTargetOutput.value = target;
      this.snapTargetOutput.title = target;
    }
  }

  private setMode(mode: TrackBuilderMode): void {
    this.mode = mode;
    this.snapSelection = undefined;
    this.clearSnapPreview();
    this.directAnchor = undefined;
    this.deleteSelections = [];
    this.selectedWaypointId = undefined;
    if (this.waypointActions) this.waypointActions.hidden = true;
    this.candidate = undefined;
    this.candidateSelection = [];
    this.candidateStartsNewPiece = false;
    this.candidatePoint = undefined;
    this.releaseStatusHold();
    this.setSourceData(HOVER_SOURCE, []);
    this.setSourceData(DIRECT_PREVIEW_SOURCE, []);

    this.options.container.classList.toggle('places-track-builder-active', mode !== 'idle');
    if (this.selectionIntensityControl) this.selectionIntensityControl.hidden = !this.active;
    const buttons = { build: 'toggle', delete: 'delete', direct: 'direct', join: 'join', snap: 'snap', waypoint: 'waypoint' };

    for (const [buttonMode, suffix] of Object.entries(buttons)) {
      this.toolbar.querySelector(`.places-track-builder-${suffix}`)?.classList.toggle('is-active', mode === buttonMode);
    }

    this.render();
  }

  private selectedWaypoint(): TrackBuilderWaypoint | undefined {
    if (!this.selectedWaypointId) return undefined;

    return trackBuilderWaypoints(getTrackBuilderHistory(this.key).draft)
      .find(waypoint => waypoint.id === this.selectedWaypointId);
  }

  private addWaypointAt(coordinate: TrackBuilderCoordinate): void {
    const existing = trackBuilderWaypoints(getTrackBuilderHistory(this.key).draft);
    const waypoint: TrackBuilderWaypoint = {
      id: `waypoint:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      coordinate,
      name: `Waypoint ${existing.length + 1}`,
    };

    addTrackBuilderWaypoint(this.key, waypoint);
    this.selectedWaypointId = waypoint.id;
    logger.scope('TrackBuilder').debug('waypoint added', { draftKey: this.key, waypoint });
    this.render();
  }

  private editSelectedWaypoint(): void {
    const waypoint = this.selectedWaypoint();

    if (!waypoint) return;
    new TrackBuilderWaypointModal(
      this.options.app,
      waypoint,
      edit => {
        updateTrackBuilderWaypoint(this.key, { ...waypoint, ...edit });
        logger.scope('TrackBuilder').debug('waypoint edited', { draftKey: this.key, waypointId: waypoint.id, edit });
        this.render();
      },
      () => this.deleteSelectedWaypoint(),
    ).open();
  }

  private deleteSelectedWaypoint(): void {
    const waypoint = this.selectedWaypoint();

    if (!waypoint) return;
    removeTrackBuilderWaypoint(this.key, waypoint.id);
    this.selectedWaypointId = undefined;
    logger.scope('TrackBuilder').debug('waypoint deleted', { draftKey: this.key, waypointId: waypoint.id });
    this.render();
  }

  private clearSnapSelection(): void {
    this.snapSelection = undefined;
    this.clearSnapPreview();
    this.setSourceData(HOVER_SOURCE, []);
    this.render();
  }

  private clearSnapPreview(): void {
    this.snapPreferredCandidate = undefined;
    this.snapPreview = undefined;
    this.snapPreviewError = undefined;
    this.updateSnapActionOutputs();
    this.setSourceData(SNAP_PREVIEW_SOURCE, []);
  }

  private clearDeleteSelection(): void {
    this.deleteSelections = [];
    this.setSourceData(HOVER_SOURCE, []);
    this.render();
  }

  private directSection(start: TrackBuilderCoordinate, end: TrackBuilderCoordinate, id?: string): TrackBuilderSection {
    const coordinates: TrackBuilderCoordinate[] = [start, end];
    const sectionId = id ?? `track-direct:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;

    return {
      id: sectionId,
      sourceFeatureKey: sectionId,
      layerId: 'track-builder-direct',
      sourceProperties: { routingMode: 'direct' },
      coordinates,
      sourceCoordinates: coordinates,
      startPosition: { segmentIndex: 0, t: 0 },
      endPosition: { segmentIndex: 0, t: 1 },
    };
  }

  private directEndpointAnchors(): DirectEndpointAnchor[] {
    const sections = getTrackBuilderHistory(this.key).draft.sections;
    const anchors: DirectEndpointAnchor[] = [];
    const endpointRays = sections.flatMap(section => {
      if (section.coordinates.length < 2) return [];

      return [
        {
          coordinate: section.coordinates[0],
          neighbor: section.coordinates[1],
        },
        {
          coordinate: section.coordinates[section.coordinates.length - 1],
          neighbor: section.coordinates[section.coordinates.length - 2],
        },
      ];
    });
    const isGeometricLeaf = (coordinate: TrackBuilderCoordinate): boolean => {
      const origin = this.options.map.project(coordinate as [number, number]);
      const rays: TrackBuilderScreenPoint[] = endpointRays.flatMap(candidate => {
        if (DistanceCalculator.haversineDistanceMeters(coordinate[1], coordinate[0], candidate.coordinate[1], candidate.coordinate[0]) > DIRECT_ENDPOINT_JOIN_TOLERANCE_METERS) return [];
        const neighbor = this.options.map.project(candidate.neighbor as [number, number]);

        return [[neighbor.x - origin.x, neighbor.y - origin.y] as TrackBuilderScreenPoint];
      });

      return uniqueTrackBuilderRayCount(rays) <= 1;
    };

    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];

      if (section.coordinates.length < 2) continue;
      const start = section.coordinates[0];
      const end = section.coordinates[section.coordinates.length - 1];
      const previous = sections[index - 1];
      const next = sections[index + 1];
      const startIsOpen = !previous
        || Boolean(section.breakBefore)
        || DistanceCalculator.haversineDistanceMeters(
          previous.coordinates[previous.coordinates.length - 1][1], previous.coordinates[previous.coordinates.length - 1][0],
          start[1], start[0],
        ) > DIRECT_ENDPOINT_JOIN_TOLERANCE_METERS;
      const endIsOpen = !next
        || Boolean(next.breakBefore)
        || DistanceCalculator.haversineDistanceMeters(end[1], end[0], next.coordinates[0][1], next.coordinates[0][0]) > DIRECT_ENDPOINT_JOIN_TOLERANCE_METERS;

      if (startIsOpen || isGeometricLeaf(start)) anchors.push({ id: `${section.id}:start`, sectionId: section.id, endpoint: 'start', coordinate: start });
      if (endIsOpen || isGeometricLeaf(end)) anchors.push({ id: `${section.id}:end`, sectionId: section.id, endpoint: 'end', coordinate: end });

      const projected = section.coordinates.map(coordinate => {
        const point = this.options.map.project(coordinate as [number, number]);

        return [point.x, point.y] as TrackBuilderScreenPoint;
      });

      for (let coordinateIndex = 1; coordinateIndex < projected.length - 1; coordinateIndex++) {
        if (!isTrackBuilderTurnaround(projected[coordinateIndex - 1], projected[coordinateIndex], projected[coordinateIndex + 1])) continue;
        const coordinate = section.coordinates[coordinateIndex];

        if (anchors.some(anchor => DistanceCalculator.haversineDistanceMeters(anchor.coordinate[1], anchor.coordinate[0], coordinate[1], coordinate[0]) <= DIRECT_ENDPOINT_JOIN_TOLERANCE_METERS)) continue;
        anchors.push({ id: `${section.id}:turnaround:${coordinateIndex}`, coordinate });
      }
    }

    return anchors;
  }

  private findDirectEndpointAt(point: maplibregl.Point): DirectEndpointAnchor | undefined {
    let best: { anchor: DirectEndpointAnchor; distance: number } | undefined;

    for (const anchor of this.directEndpointAnchors()) {
      const projected = this.options.map.project(anchor.coordinate as [number, number]);
      const distance = Math.hypot(point.x - projected.x, point.y - projected.y);

      if (distance <= DIRECT_ENDPOINT_SNAP_DISTANCE_PIXELS && (!best || distance < best.distance)) best = { anchor, distance };
    }

    return best?.anchor;
  }

  private selectDirectAnchor(anchor: DirectEndpointAnchor): void {
    this.directAnchor = anchor;
    this.setSourceData(DIRECT_PREVIEW_SOURCE, []);
    logger.scope('TrackBuilder').debug('direct line anchor selected', {
      draftKey: this.key,
      anchorId: anchor.id,
      sectionId: anchor.sectionId,
      endpoint: anchor.endpoint,
      coordinate: anchor.coordinate,
    });
    this.render();
  }

  private commitDirectLine(coordinate: TrackBuilderCoordinate, destination?: DirectEndpointAnchor): void {
    const anchor = this.directAnchor;

    if (!anchor || DistanceCalculator.haversineDistanceMeters(anchor.coordinate[1], anchor.coordinate[0], coordinate[1], coordinate[0]) < 0.05) return;
    const anchorReference: TrackBuilderSectionEndpoint | undefined = 'id' in anchor && anchor.sectionId && anchor.endpoint
      ? { sectionId: anchor.sectionId, endpoint: anchor.endpoint }
      : undefined;
    const destinationReference: TrackBuilderSectionEndpoint | undefined = destination?.sectionId && destination.endpoint
      ? { sectionId: destination.sectionId, endpoint: destination.endpoint }
      : undefined;
    const startsAtSectionStart = anchorReference?.endpoint === 'start';
    let section = startsAtSectionStart
      ? this.directSection(coordinate, anchor.coordinate)
      : this.directSection(anchor.coordinate, coordinate);
    let insertAnchor = anchorReference;
    let insertDestination = destinationReference;

    if (!anchorReference && destinationReference) {
      if (destinationReference.endpoint === 'end') section = reverseTrackBuilderSection(section);
      insertAnchor = destinationReference;
      insertDestination = undefined;
    } else if (!anchorReference && getTrackBuilderHistory(this.key).draft.sections.length > 0) {
      section = { ...section, breakBefore: true };
    }

    insertDirectTrackBuilderSection(this.key, section, insertAnchor, insertDestination);
    logger.scope('TrackBuilder').debug('direct line committed', {
      draftKey: this.key,
      anchor: anchorReference ?? { coordinate: anchor.coordinate },
      destination: destinationReference ?? { coordinate },
      section: sectionLogData(section),
    });
    this.setSourceData(DIRECT_PREVIEW_SOURCE, []);
    this.directAnchor = destination
      ? undefined
      : {
        sectionId: section.id,
        endpoint: startsAtSectionStart ? 'start' : 'end',
        coordinate,
      };
    this.render();
  }

  private handleMouseMove(event: maplibregl.MapMouseEvent): void {
    if (this.direct) {
      if (!this.directAnchor) {
        this.setSourceData(DIRECT_PREVIEW_SOURCE, []);

        return;
      }

      const destination = this.findDirectEndpointAt(event.point);

      if (this.joining && !destination) {
        this.setSourceData(DIRECT_PREVIEW_SOURCE, []);

        return;
      }

      const coordinate: TrackBuilderCoordinate = destination?.coordinate ?? [event.lngLat.lng, event.lngLat.lat];

      if (DistanceCalculator.haversineDistanceMeters(
        this.directAnchor.coordinate[1], this.directAnchor.coordinate[0],
        coordinate[1], coordinate[0],
      ) < 0.05) {
        this.setSourceData(DIRECT_PREVIEW_SOURCE, []);

        return;
      }

      this.setSourceData(DIRECT_PREVIEW_SOURCE, [this.directSection(this.directAnchor.coordinate, coordinate, 'preview')]);

      return;
    }

    if (this.waypointing) return;

    if (this.snapping) {
      if (this.snapSelection) return;
      const section = this.findDraftSectionAt(event.point);
      const previews = section
        ? [this.snapPreviewSection(section, this.localSelectionAtPoint(section, event.point))]
        : [];

      this.setSourceData(HOVER_SOURCE, previews, 'snap');

      return;
    }

    if (this.deleting) {
      const section = this.findDraftSectionAt(event.point);
      const selected = new Set(this.deleteSelections.map(selection => selection.sectionId));
      const previews = this.deletePreviewSections();

      if (section && !selected.has(section.id)) {
        const selection = this.localSelectionAtPoint(section, event.point);

        previews.push(this.deletePreviewSection(section, selection));
      }

      this.setSourceData(HOVER_SOURCE, previews, 'delete');

      return;
    }

    if (!this.active) return;
    this.candidate = this.findCandidateAt(event.point);
    this.candidatePoint = event.point;
    this.refreshCandidateSelection();
  }

  private handleClick(event: maplibregl.MapMouseEvent): void {
    if (this.direct) {
      event.preventDefault();
      const endpoint = this.findDirectEndpointAt(event.point);

      if (!this.directAnchor) {
        if (endpoint) this.selectDirectAnchor(endpoint);
        else if (this.joining) this.status.setText('Join segments · choose a highlighted endpoint');
        else {
          this.directAnchor = { coordinate: [event.lngLat.lng, event.lngLat.lat] };
          this.render();
        }

        return;
      }

      if (this.joining && !endpoint) {
        this.status.setText('Join segments · choose another highlighted endpoint');

        return;
      }

      const coordinate: TrackBuilderCoordinate = endpoint?.coordinate ?? [event.lngLat.lng, event.lngLat.lat];

      this.commitDirectLine(coordinate, endpoint);
      if (this.joining) this.setMode('idle');

      return;
    }

    if (this.waypointing) {
      event.preventDefault();
      this.addWaypointAt([event.lngLat.lng, event.lngLat.lat]);

      return;
    }

    if (this.snapping) {
      if (this.snapSelection) {
        const preferred = this.findCandidateAt(event.point, undefined, 10);

        if (preferred) {
          event.preventDefault();
          this.snapPreferredCandidate = preferred;
          this.updateSnapActionOutputs();
          this.render();
          logger.scope('TrackBuilder').debug('snap preview path preferred', {
            draftKey: this.key,
            pointer: [event.lngLat.lng, event.lngLat.lat],
            candidate: sectionLogData(preferred),
            selection: this.snapSelection,
            radiusMeters: this.snapRadiusMeters,
          });

          return;
        }
      }

      const section = this.findDraftSectionAt(event.point);

      if (!section) return;
      event.preventDefault();

      if (this.snapSelection?.sectionId === section.id) {
        logger.scope('TrackBuilder').debug('snap range deselected', {
          draftKey: this.key,
          pointer: [event.lngLat.lng, event.lngLat.lat],
          sectionId: section.id,
          selection: this.snapSelection,
        });
        this.snapSelection = undefined;
        this.clearSnapPreview();
      } else {
        const selected = this.localSelectionAtPoint(section, event.point);

        this.snapSelection = {
          ...selected,
          ranges: [{ start: selected.start, end: selected.end }],
        };
        this.clearSnapPreview();
        logger.scope('TrackBuilder').debug('snap range selected', {
          draftKey: this.key,
          pointer: [event.lngLat.lng, event.lngLat.lat],
          sectionId: section.id,
          layerId: section.layerId,
          selection: this.snapSelection,
          source: 'rendered-map',
        });
      }

      this.render();

      return;
    }

    if (this.deleting) {
      const section = this.findDraftSectionAt(event.point);

      if (!section) return;
      event.preventDefault();
      const existingIndex = this.deleteSelections.findIndex(selection => selection.sectionId === section.id);

      if (existingIndex >= 0) {
        const [selection] = this.deleteSelections.splice(existingIndex, 1);

        logger.scope('TrackBuilder').debug('delete range deselected', {
          draftKey: this.key,
          pointer: [event.lngLat.lng, event.lngLat.lat],
          sectionId: section.id,
          selection,
          selectedCount: this.deleteSelections.length,
        });
        this.render();

        return;
      }

      const selection = this.localSelectionAtPoint(section, event.point);

      this.deleteSelections.push(selection);
      logger.scope('TrackBuilder').debug('delete range selected', {
        draftKey: this.key,
        pointer: [event.lngLat.lng, event.lngLat.lat],
        section: sectionLogData(section),
        selection,
        selectedCount: this.deleteSelections.length,
      });
      this.render();

      return;
    }

    if (!this.active) return;
    const candidate = this.candidate ?? this.findCandidateAt(event.point);

    if (!candidate) return;
    event.preventDefault();
    const selection = this.candidate === candidate && this.candidateSelection.length > 0
      ? this.candidateSelection
      : this.selectionForCandidate(candidate, event.point);

    if (selection.length > 1) {
      this.commitAddedSelection(selection, event);
      this.render();

      return;
    }

    const section = selection[0] ?? this.sectionBetween(candidate, { segmentIndex: 0, t: 0 }, { segmentIndex: candidate.coordinates.length - 2, t: 1 });
    const clipped = this.clipAddedSectionAgainstDraft(section, event.point);

    if (!clipped) {
      logger.scope('TrackBuilder').debug('feature click ignored because it is already covered by the draft', {
        draftKey: this.key,
        pointer: [event.lngLat.lng, event.lngLat.lat],
        candidate: sectionLogData(candidate),
      });

      return;
    }

    const oriented = this.orientAddedSection(clipped);
    const committed = oriented.section;

    logger.scope('TrackBuilder').debug('feature clicked', {
      draftKey: this.key,
      pointer: [event.lngLat.lng, event.lngLat.lat],
      pointerDistancePixels: this.candidateDistances.get(candidate.id),
      candidate: sectionLogData(candidate),
      committed: sectionLogData(committed),
    });
    this.commitAddedSection(oriented);
    this.render();
  }

  private findCandidateAt(point: maplibregl.Point, preferred?: TrackBuilderSection, maximumDistance = Number.POSITIVE_INFINITY, candidateIndex?: SnapCandidateIndex): TrackBuilderSection | undefined {
    const tolerance = 10;
    const indexed = candidateIndex
      ? trackBuilderCandidatesAt(candidateIndex, [point.x, point.y])
      : undefined;
    const candidates = indexed?.map(candidate => candidate.candidate)
      ?? this.candidateSections(this.options.map.queryRenderedFeatures([
        [point.x - tolerance, point.y - tolerance],
        [point.x + tolerance, point.y + tolerance],
      ]));
    let closest: { section: TrackBuilderSection; distance: number } | undefined;

    for (const section of candidates) {
      const projected = indexed?.find(candidate => candidate.candidate.id === section.id);
      const distance = projected
        ? closestTrackBuilderProjectedPosition([point.x, point.y], projected.points).distance
        : this.screenDistance(point, section.coordinates);

      this.candidateDistances.set(section.id, distance);
      if (!closest || distance < closest.distance) closest = { section, distance };
    }

    if (preferred) {
      const indexedPreferred = indexed?.find(candidate => candidate.candidate.id === preferred.id);
      const preferredDistance = indexedPreferred
        ? closestTrackBuilderProjectedPosition([point.x, point.y], indexedPreferred.points).distance
        : this.screenDistance(point, preferred.sourceCoordinates ?? preferred.coordinates);

      if (shouldKeepPreferredTrackCandidate(preferredDistance, closest?.distance ?? Number.POSITIVE_INFINITY, maximumDistance)) {
        this.candidateDistances.set(preferred.id, preferredDistance);

        return preferred;
      }
    }

    return closest && closest.distance <= maximumDistance ? closest.section : undefined;
  }

  private candidateSections(features: readonly maplibregl.MapGeoJSONFeature[]): TrackBuilderSection[] {
    const sections = new Map<string, TrackBuilderSection>();

    for (const feature of features) {
      const layerId = feature.layer?.id ?? '';

      if (layerId.startsWith('places-') || layerId.startsWith('track-') || layerId.startsWith('geojson-') || layerId.startsWith('heatmap')) continue;
      if (layerId.includes('casing')) continue;
      if (!this.matchesSelectableFeature(layerId, feature.sourceLayer)) continue;
      if (feature.geometry.type !== 'LineString' && feature.geometry.type !== 'MultiLineString') continue;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

      for (const rawCoordinates of lines) {
        const coordinates = rawCoordinates.filter(coordinate => coordinate.length >= 2).map(coordinate => [coordinate[0], coordinate[1]] as TrackBuilderCoordinate);

        if (coordinates.length < 2) continue;
        const layerId = feature.layer?.id ?? '';
        const id = hashString36(JSON.stringify([feature.source, feature.sourceLayer, feature.id, coordinates]));
        const section: TrackBuilderSection = { id, coordinates, sourceCoordinates: coordinates, layerId, sourceLayer: feature.sourceLayer, featureId: feature.id, name: feature.properties?.name as string | undefined, sourceProperties: feature.properties };

        sections.set(id, section);
      }
    }

    return [...sections.values()];
  }

  private matchesSelectableFeature(layerId: string, sourceLayer?: string): boolean {
    if (!this.layerSelectionCustomized
      && this.selectableLayers.size === 1
      && this.selectableLayers.has('transportation')) {
      // OpenMapTiles calls its network source layer `transportation`; Mapbox
      // styles expose the equivalent hiking/road geometry through `road` and
      // provider-specific road/path layer IDs.
      const normalizedLayer = layerId.toLowerCase();
      const normalizedSource = sourceLayer?.toLowerCase() ?? '';

      return normalizedSource === 'transportation'
        || normalizedSource === 'road'
        || normalizedLayer.includes('road')
        || normalizedLayer.includes('path')
        || normalizedLayer.includes('trail');
    }

    if (!this.layerSelectionCustomized && this.selectableLayers.size === 0) return true;

    return this.selectableLayers.has(layerId) || this.selectableLayers.has(sourceLayer ?? '');
  }

  private refreshCandidateSelection(): void {
    if (!this.active || !this.candidate || !this.candidatePoint) {
      const wasStartingNewPiece = this.candidateStartsNewPiece;

      this.candidateSelection = [];
      this.candidateStartsNewPiece = false;
      this.setSourceData(HOVER_SOURCE, []);
      // Pointing away from every feature has to retire the "not connected"
      // label, which nothing else would repaint until the next render.
      if (wasStartingNewPiece) this.updateStatus();

      return;
    }

    this.candidateSelection = this.selectionForCandidate(this.candidate, this.candidatePoint);
    this.candidateStartsNewPiece = this.selectionStartsNewPiece(this.candidateSelection);
    this.setSourceData(HOVER_SOURCE, this.candidateSelection, this.candidateStartsNewPiece ? 'new-piece' : undefined);
    this.updateStatus();
  }

  private routeAttachmentAnchors(): TrackBuilderCoordinate[] {
    const sections = getTrackBuilderHistory(this.key).draft.sections;

    if (sections.length === 0) return [];
    const lastCoordinate = (section: TrackBuilderSection) => section.coordinates[section.coordinates.length - 1];
    const anchors: TrackBuilderCoordinate[] = [sections[0].coordinates[0], lastCoordinate(sections[sections.length - 1])];

    for (let index = 0; index + 1 < sections.length; index++) {
      const leftEnd = lastCoordinate(sections[index]);
      const rightStart = sections[index + 1].coordinates[0];

      if (DistanceCalculator.haversineDistanceMeters(leftEnd[1], leftEnd[0], rightStart[1], rightStart[0]) > CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS) anchors.push(leftEnd, rightStart);
    }

    return anchors;
  }

  // Whether clicking this hover would certainly start a separate piece rather
  // than extend the route. Deliberately one-sided: clipping and endpoint
  // bridging can still pull an end onto an anchor, and a candidate passing
  // anywhere within bridging distance stays unmarked. The pink hover
  // always means "separate piece"; amber does not promise the reverse, and the
  // held message after the click covers the remainder.
  private selectionStartsNewPiece(selection: readonly TrackBuilderSection[]): boolean {
    const anchors = this.routeAttachmentAnchors();

    if (anchors.length === 0 || selection.length === 0) return false;

    return !anchors.some(anchor => selection.some(section =>
      this.coordinateLineConnection(anchor, section.coordinates).geographicDistanceMeters <= TRACK_BRIDGE_MAX_DISTANCE_METERS));
  }

  private projectedSelectionPoints(section: TrackBuilderSection): TrackBuilderSelectionPoint[] {
    return (section.sourceCoordinates ?? section.coordinates).map(coordinate => {
      const point = this.options.map.project(coordinate as [number, number]);

      return [point.x, point.y];
    });
  }

  private selectionForCandidate(candidate: TrackBuilderSection, point: maplibregl.Point): TrackBuilderSection[] {
    const coordinates = candidate.sourceCoordinates ?? candidate.coordinates;
    const profile = trackBuilderSelectionProfile(this.selectionIntensity);

    if (profile.localHalfLengthPixels !== undefined) {
      const center = this.positionOnLine(point, coordinates);
      const range = localSelectionRange(this.projectedSelectionPoints(candidate), center, profile.localHalfLengthPixels);

      return [this.sectionBetween(candidate, range.start, range.end)];
    }

    const whole = this.sectionBetween(candidate, { segmentIndex: 0, t: 0 }, { segmentIndex: coordinates.length - 2, t: 1 });

    if (profile.adjacentHops === 0) return [whole];

    return this.expandAdjacentSelection(whole, profile.adjacentHops);
  }

  private adjacencyCandidates(): TrackBuilderSection[] {
    const center = this.options.map.getCenter();
    const signature = [
      this.options.map.getZoom().toFixed(4),
      center.lng.toFixed(5),
      center.lat.toFixed(5),
      this.options.map.getBearing().toFixed(2),
      this.options.map.getPitch().toFixed(2),
    ].join(':');
    const now = Date.now();

    if (this.adjacencyCandidateCache?.signature === signature && this.adjacencyCandidateCache.expiresAt > now) {
      return this.adjacencyCandidateCache.sections;
    }

    const sections = this.candidateSections(this.options.map.queryRenderedFeatures());

    this.adjacencyCandidateCache = { signature, expiresAt: now + 750, sections };

    return sections;
  }

  private inwardSelectionReference(section: TrackBuilderSection, endpoint: 'start' | 'end'): TrackBuilderSelectionPoint {
    const points = section.coordinates.map(coordinate => {
      const point = this.options.map.project(coordinate as [number, number]);

      return [point.x, point.y] as TrackBuilderSelectionPoint;
    });
    const anchor = endpoint === 'start' ? points[0] : points[points.length - 1];
    const indexes = endpoint === 'start'
      ? Array.from({ length: points.length - 1 }, (_, index) => index + 1)
      : Array.from({ length: points.length - 1 }, (_, index) => points.length - 2 - index);

    return indexes.map(index => points[index]).find(point => Math.hypot(point[0] - anchor[0], point[1] - anchor[1]) >= 4)
      ?? points[endpoint === 'start' ? Math.min(1, points.length - 1) : Math.max(0, points.length - 2)];
  }

  private continuationCandidates(sections: readonly TrackBuilderSection[], excluded: ReadonlySet<string>): TrackBuilderContinuationCandidate<TrackBuilderSection>[] {
    return sections
      .filter(section => !excluded.has(section.id))
      .map(section => ({ key: section.id, value: section, points: this.projectedSelectionPoints(section) }));
  }

  private expandAdjacentSelection(seed: TrackBuilderSection, hops: number): TrackBuilderSection[] {
    const chain = [seed];
    const candidates = this.adjacencyCandidates();
    const used = new Set([seed.sourceFeatureKey ?? seed.id, seed.id]);

    for (let hop = 0; hop < hops; hop++) {
      const leftSection = chain[0];
      const leftAnchor = leftSection.coordinates[0];
      const leftPoint = this.options.map.project(leftAnchor as [number, number]);
      const left = bestTrackBuilderContinuation(
        [leftPoint.x, leftPoint.y],
        this.inwardSelectionReference(leftSection, 'start'),
        this.continuationCandidates(candidates, used),
      );

      if (left) {
        used.add(left.candidate.key);
        const added = this.sectionBetween(left.candidate.value, left.outer, left.connection);
        const coordinates = [...added.coordinates];

        coordinates[coordinates.length - 1] = leftAnchor;
        chain.unshift({ ...added, coordinates, endCoordinateOverride: leftAnchor, breakBefore: false });
      }

      const rightSection = chain[chain.length - 1];
      const rightAnchor = rightSection.coordinates[rightSection.coordinates.length - 1];
      const rightPoint = this.options.map.project(rightAnchor as [number, number]);
      const right = bestTrackBuilderContinuation(
        [rightPoint.x, rightPoint.y],
        this.inwardSelectionReference(rightSection, 'end'),
        this.continuationCandidates(candidates, used),
      );

      if (right) {
        used.add(right.candidate.key);
        const added = this.sectionBetween(right.candidate.value, right.connection, right.outer);
        const coordinates = [...added.coordinates];

        coordinates[0] = rightAnchor;
        chain.push({ ...added, coordinates, startCoordinateOverride: rightAnchor, breakBefore: false });
      }

      if (!left && !right) break;
    }

    return chain;
  }

  private commitAddedSelection(selection: readonly TrackBuilderSection[], event: maplibregl.MapMouseEvent): void {
    let additions = selection.flatMap(section => {
      const clipped = this.clipAddedSectionAgainstDraft(section);

      return clipped ? [clipped] : [];
    });

    if (additions.length === 0) {
      logger.scope('TrackBuilder').debug('expanded feature selection ignored because it is already covered by the draft', {
        draftKey: this.key,
        pointer: [event.lngLat.lng, event.lngLat.lat],
        intensity: this.selectionIntensity,
        candidates: selection.map(sectionLogData),
      });

      return;
    }

    const existing = getTrackBuilderHistory(this.key).draft.sections;
    const previousCoordinates = existing[existing.length - 1]?.coordinates;
    const previousEnd = previousCoordinates?.[previousCoordinates.length - 1];

    if (previousEnd) {
      const firstStart = additions[0].section.coordinates[0];
      const lastCoordinates = additions[additions.length - 1].section.coordinates;
      const lastEnd = lastCoordinates[lastCoordinates.length - 1];

      if (DistanceCalculator.haversineDistanceMeters(previousEnd[1], previousEnd[0], lastEnd[1], lastEnd[0]) < DistanceCalculator.haversineDistanceMeters(previousEnd[1], previousEnd[0], firstStart[1], firstStart[0])) {
        additions = additions.reverse().map(added => ({
          section: reverseTrackBuilderSection(added.section),
          startContact: added.endContact,
          endContact: added.startContact,
        }));
      }
    }

    const first = additions[0];
    const last = additions[additions.length - 1];
    const startIndex = first.startContact ? existing.findIndex(section => section.id === first.startContact!.section.id) : -1;
    const endIndex = last.endContact ? existing.findIndex(section => section.id === last.endContact!.section.id) : -1;
    const startsAtLeftEnd = startIndex >= 0 && DistanceCalculator.haversineDistanceMeters(
      first.startContact!.coordinate[1], first.startContact!.coordinate[0],
      existing[startIndex].coordinates[existing[startIndex].coordinates.length - 1][1], existing[startIndex].coordinates[existing[startIndex].coordinates.length - 1][0],
    ) <= 1;
    const endsAtRightStart = endIndex >= 0 && DistanceCalculator.haversineDistanceMeters(
      last.endContact!.coordinate[1], last.endContact!.coordinate[0],
      existing[endIndex].coordinates[0][1], existing[endIndex].coordinates[0][0],
    ) <= 1;
    const committed = additions.map((added, index) => ({ ...added.section, breakBefore: index === 0 ? added.section.breakBefore : false }));

    if (startsAtLeftEnd && endsAtRightStart && endIndex === startIndex + 1) {
      const next = [...existing];

      next.splice(endIndex, 0, ...committed.map(section => ({ ...section, breakBefore: false })));
      next[endIndex + committed.length] = { ...next[endIndex + committed.length], breakBefore: false };
      replaceTrackBuilderSections(this.key, next);
    } else {
      if (previousEnd && DistanceCalculator.haversineDistanceMeters(
        previousEnd[1], previousEnd[0],
        committed[0].coordinates[0][1], committed[0].coordinates[0][0],
      ) > CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS) {
        this.startNewPiece(committed, 'selection');

        return;
      }

      appendTrackBuilderSections(this.key, committed);
    }

    logger.scope('TrackBuilder').debug('expanded feature selection committed', {
      draftKey: this.key,
      pointer: [event.lngLat.lng, event.lngLat.lat],
      intensity: this.selectionIntensity,
      committedSections: committed.map(sectionLogData),
    });
  }

  private findDraftSectionAt(point: maplibregl.Point): TrackBuilderSection | undefined {
    const features = this.options.map.queryRenderedFeatures(point, { layers: [DRAFT_LAYER] });
    const id: unknown = features[0]?.properties?.id;

    return typeof id === 'string'
      ? getTrackBuilderHistory(this.key).draft.sections.find(section => section.id === id)
      : undefined;
  }

  private screenDistance(point: maplibregl.Point, coordinates: readonly TrackBuilderCoordinate[]): number {
    let minimum = Number.POSITIVE_INFINITY;

    for (let index = 1; index < coordinates.length; index++) {
      const a = this.options.map.project(coordinates[index - 1] as [number, number]);
      const b = this.options.map.project(coordinates[index] as [number, number]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const denominator = dx * dx + dy * dy;
      const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator));

      minimum = Math.min(minimum, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
    }

    return minimum;
  }

  private render(): void {
    const history = getTrackBuilderHistory(this.key);
    const sectionIds = new Set(history.draft.sections.map(section => section.id));

    if (this.directAnchor && 'sectionId' in this.directAnchor && (this.directAnchor.sectionId === undefined || !sectionIds.has(this.directAnchor.sectionId))) {
      this.directAnchor = undefined;
      this.setSourceData(DIRECT_PREVIEW_SOURCE, []);
    }

    this.deleteSelections = this.deleteSelections.filter(selection => sectionIds.has(selection.sectionId));

    if (this.snapSelection && !sectionIds.has(this.snapSelection.sectionId)) {
      this.snapSelection = undefined;
      this.clearSnapPreview();
    }

    const waypoints = trackBuilderWaypoints(history.draft);

    if (this.selectedWaypointId && !waypoints.some(waypoint => waypoint.id === this.selectedWaypointId)) {
      this.selectedWaypointId = undefined;
    }

    this.setSourceData(DRAFT_SOURCE, history.draft.sections);
    this.renderHandleMarkers(history.draft.sections);
    this.renderWaypointMarkers(waypoints);
    if (this.waypointActions) this.waypointActions.hidden = !this.waypointing || !this.selectedWaypointId;
    this.updateDeletePreview();
    this.updateSnapPreview();
    if (this.deleteActions) this.deleteActions.hidden = this.deleteSelections.length === 0;
    if (this.snapActions) this.snapActions.hidden = !this.snapping;

    if (this.snapApplyButton) {
      this.snapApplyButton.disabled = !this.snapPreview;
      this.snapApplyButton.title = this.snapPreview
        ? 'Apply the green snap preview'
        : this.snapPreviewError ?? 'A connected preview is required before this can be applied.';
    }

    if (this.snapWholeButton) this.snapWholeButton.disabled = !this.snapSelection;
    this.updateStatus();
  }

  // A held message wins until it expires: `handleClick` renders as soon as a
  // commit returns; without the hold a refusal would explain itself and be
  // overwritten in the same tick.
  private updateStatus(): void {
    if (this.statusHoldUntil > Date.now()) return;
    const history = getTrackBuilderHistory(this.key);

    if (this.waypointing) {
      const waypoints = trackBuilderWaypoints(history.draft);
      const selected = this.selectedWaypoint();

      this.status.setText(selected
        ? `Waypoint · ${selected.name ?? 'unnamed'}`
        : `Waypoints · ${waypoints.length} placed`);
      this.status.setAttribute('title', selected
        ? 'Drag the marker to move it, or use the edit and delete buttons. Every change is undoable.'
        : 'Click the map to add a waypoint, or click an existing marker to select it. Waypoints are saved alongside the track in the GPX.');
    } else if (this.snapping) {
      this.updateSnapStatus();
    } else if (this.active && this.candidateStartsNewPiece) {
      this.status.setText(`${trackBuilderSelectionProfile(this.selectionIntensity).label} · separate piece`);
      this.status.setAttribute('title', 'The pink feature reaches neither open end of the route, so clicking it starts a separate piece. Pieces export as their own GPX track segments until Join two track endpoints connects them.');
    } else {
      // Runs on every pointer move while building; only the idle summary
      // needs the segment count.
      const summary = () => {
        const segmentCount = trackBuilderSegments(history.draft).length;

        return `${history.draft.sections.length} section${history.draft.sections.length === 1 ? '' : 's'} · ${segmentCount} segment${segmentCount === 1 ? '' : 's'}`;
      };

      this.status.setText(this.direct
      ? this.joining
        ? this.directAnchor
          ? 'Join segments · choose second endpoint'
          : 'Join segments · choose first endpoint'
        : this.directAnchor
          ? 'Direct line · click destination'
          : history.draft.sections.length > 0
            ? 'Direct line · choose endpoint'
            : 'Direct line · click start point'
      : this.active
        ? trackBuilderSelectionProfile(this.selectionIntensity).label
        : summary());
      this.status.setAttribute('title', this.direct
      ? this.joining
        ? 'Choose the two highlighted endpoints on either side of the recording gap. The join is a straight section and can be undone.'
        : this.directAnchor
        ? 'Click anywhere for a straight segment, or click another highlighted endpoint to bridge a gap. Direct lines do not verify passability.'
        : 'Choose a highlighted open endpoint. With an empty draft, click anywhere to set the first point.'
      : this.deleting
      ? this.deleteSelections.length > 0
        ? 'Drag either red boundary to adjust the portion, or choose Whole section. Apply once to delete every red selection.'
        : 'The red hover is the local portion a click will select. Click it, then drag either red boundary to adjust the deletion.'
      : this.active
        ? 'Adjust selection intensity: Local and Extended select around the pointer, Feature selects the whole rendered feature, and higher settings follow the best connected continuation through one or two adjacent features.'
        : 'Activate track building to select roads and trails.');
    }
  }

  // Append geometry that reaches no open end as a separate piece, which exports
  // as its own GPX track segment until Join two track endpoints connects it.
  // `breakBefore` is explicit rather than relying on the distance rule: a new
  // piece that happens to start near the route's end still stays separate.
  private startNewPiece(sections: readonly TrackBuilderSection[], kind: 'feature' | 'selection'): void {
    const pieces = [{ ...sections[0], breakBefore: true }, ...sections.slice(1)];

    appendTrackBuilderSections(this.key, pieces);
    logger.scope('TrackBuilder').debug('new piece started', {
      draftKey: this.key,
      kind,
      sections: pieces.map(sectionLogData),
    });
    this.holdStatus(
      'Started a separate piece',
      'This does not touch the route, so it was added as its own segment. Use Join two track endpoints, or Draw direct line, to connect it.',
    );
  }

  // Show a message that outlives the render following the action that produced
  // it. A refusal otherwise leaves no trace the user can see.
  private holdStatus(text: string, title: string, durationMs = 4000): void {
    this.status.setText(text);
    this.status.setAttribute('title', title);
    this.status.classList.add('is-held');
    this.statusHoldUntil = Date.now() + durationMs;
    if (this.statusHoldTimer !== undefined) window.clearTimeout(this.statusHoldTimer);
    this.statusHoldTimer = window.setTimeout(() => {
      this.statusHoldTimer = undefined;
      this.releaseStatusHold();
    }, durationMs);
  }

  private releaseStatusHold(): void {
    if (this.statusHoldTimer !== undefined) {
      window.clearTimeout(this.statusHoldTimer);
      this.statusHoldTimer = undefined;
    }

    if (this.statusHoldUntil === 0) return;
    this.statusHoldUntil = 0;
    this.status.classList.remove('is-held');
    if (!this.destroyed) this.updateStatus();
  }

  private updateSnapStatus(): void {
    if (!this.snapping) return;

    if (!this.snapSelection) {
      this.status.setText('Snap GPX · click a section');
      this.status.title = 'Click a loaded GPX section to select a local range. Snapping follows visible map line features and does not call a routing or map-matching API.';

      return;
    }

    if (!this.snapPreview) {
      this.status.setText(this.snapPreviewError ? 'Preview unavailable' : 'No snap preview');
      this.status.title = this.snapPreviewError ?? 'No connected selectable map path was found within the chosen distance.';

      return;
    }

    const count = this.snapPreview.mappedSections.length;

    this.status.setText(`Preview · ${count} feature${count === 1 ? '' : 's'}`);
    this.status.title = this.snapPreferredCandidate
      ? 'The green line is the proposed snap. Click another nearby road or trail to prefer it, adjust the cyan boundaries or distance, then apply.'
      : 'The green line is the proposed snap. If nearby paths overlap, click the road or trail to prefer, then apply.';
  }

  private updateDeletePreview(): void {
    if (!this.deleting || this.deleteSelections.length === 0) {
      if (this.deleting) this.setSourceData(HOVER_SOURCE, []);

      return;
    }

    this.setSourceData(HOVER_SOURCE, this.deletePreviewSections(), 'delete');
  }

  private deletePreviewSections(): TrackBuilderSection[] {
    const sections = getTrackBuilderHistory(this.key).draft.sections;

    return this.deleteSelections.flatMap(selection => {
      const section = sections.find(candidate => candidate.id === selection.sectionId);

      if (!section) return [];

      return [this.deletePreviewSection(section, selection)];
    });
  }

  private localSelectionAtPoint(section: TrackBuilderSection, point: maplibregl.Point): DeleteSelection {
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const center = this.clampPositionToSection(this.positionOnLine(point, sourceCoordinates), section);
    const range = this.centeredSelectionRange(section, center);

    return { sectionId: section.id, start: range.start, end: range.end };
  }

  private selectWholeDeleteSections(): void {
    const sections = getTrackBuilderHistory(this.key).draft.sections;

    for (const selection of this.deleteSelections) {
      const section = sections.find(candidate => candidate.id === selection.sectionId);

      if (!section) continue;
      const range = wholeTrackBuilderSectionRange(section);

      selection.start = range.start;
      selection.end = range.end;
    }

    logger.scope('TrackBuilder').debug('delete selections expanded to whole sections', {
      draftKey: this.key,
      selections: this.deleteSelections,
    });
    this.render();
  }

  private deletePreviewSection(section: TrackBuilderSection, selection: DeleteSelection): TrackBuilderSection {
    const preview = this.sectionBetween(section, selection.start, selection.end);

    return { ...preview, id: `delete:${section.id}` };
  }

  private snapPreviewSection(section: TrackBuilderSection, selection: TrackBuilderRange, index = 0): TrackBuilderSection {
    const preview = this.sectionBetween(section, selection.start, selection.end);

    return { ...preview, id: `snap:${section.id}:${index}` };
  }

  private snapPreviewSections(section: TrackBuilderSection, selection: SnapSelection): TrackBuilderSection[] {
    return selection.ranges.map((range, index) => this.snapPreviewSection(section, range, index));
  }

  private updateSnapPreview(): void {
    if (!this.snapping || !this.snapSelection) {
      if (this.snapping) {
        this.snapPreview = undefined;
        this.snapPreviewError = undefined;
        this.setSourceData(HOVER_SOURCE, []);
        this.setSourceData(SNAP_PREVIEW_SOURCE, []);
      }

      return;
    }

    const section = getTrackBuilderHistory(this.key).draft.sections.find(candidate => candidate.id === this.snapSelection?.sectionId);

    if (section) this.normalizeSnapSelection(section, this.snapSelection);
    this.setSourceData(HOVER_SOURCE, section ? this.snapPreviewSections(section, this.snapSelection) : [], 'snap');
    const startedAt = performance.now();

    try {
      this.snapPreview = section ? this.createSnapPreview(section, this.snapSelection) : undefined;
      this.snapPreviewError = undefined;
      this.setSourceData(SNAP_PREVIEW_SOURCE, this.snapPreview?.mappedSections ?? []);
    } catch (error) {
      this.snapPreview = undefined;
      this.snapPreviewError = getErrorMessage(error);
      this.setSourceData(SNAP_PREVIEW_SOURCE, []);
    }

    if (this.snapApplyButton) {
      this.snapApplyButton.disabled = !this.snapPreview;
      this.snapApplyButton.title = this.snapPreview
        ? 'Apply the green snap preview'
        : this.snapPreviewError ?? 'A connected preview is required before this can be applied.';
    }

    this.updateSnapStatus();
    logger.scope('TrackBuilder').debug('snap preview updated', {
      draftKey: this.key,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      radiusMeters: this.snapRadiusMeters,
      candidateCount: this.snapPreview?.candidateCount,
      inputPointCount: this.snapPreview?.inputPointCount,
      sampleCount: this.snapPreview?.sampleCount,
      sampleSpacingPixels: this.snapPreview?.sampleSpacingPixels,
      matchedSampleCount: this.snapPreview?.matchedSampleCount,
      mappedSectionCount: this.snapPreview?.mappedSections.length,
      candidatePreparationMs: this.snapPreview?.candidatePreparationMs,
      traceMs: this.snapPreview?.traceMs,
      sectionBuildMs: this.snapPreview?.sectionBuildMs,
      error: this.snapPreviewError,
    });
  }

  private updateSnapSelectionDisplay(message?: string): void {
    if (!this.snapping || !this.snapSelection) return;
    const section = getTrackBuilderHistory(this.key).draft.sections.find(candidate => candidate.id === this.snapSelection?.sectionId);

    this.snapPreview = undefined;
    this.snapPreviewError = message;
    this.setSourceData(HOVER_SOURCE, section ? this.snapPreviewSections(section, this.snapSelection) : [], 'snap');
    this.setSourceData(SNAP_PREVIEW_SOURCE, []);
    if (this.snapApplyButton) this.snapApplyButton.disabled = true;
    this.updateSnapStatus();
  }

  private normalizeSnapSelection(section: TrackBuilderSection, selection: SnapSelection): void {
    const ranges = normalizeTrackBuilderSelectionRanges(selection.ranges)
      .map(range => ({
        start: this.clampPositionToSection(range.start, section),
        end: this.clampPositionToSection(range.end, section),
      }))
      .filter(range => !positionsEqual(range.start, range.end));

    if (ranges.length === 0) return;
    selection.ranges = ranges;
    const source = section.sourceCoordinates ?? section.coordinates;
    const sectionStart = section.startPosition ?? { segmentIndex: 0, t: 0 };
    const sectionEnd = section.endPosition ?? { segmentIndex: source.length - 2, t: 1 };
    const first = ranges[0];
    const last = ranges[ranges.length - 1];

    if (comparePositions(sectionStart, sectionEnd) <= 0) {
      selection.start = first.start;
      selection.end = last.end;
    } else {
      selection.start = last.end;
      selection.end = first.start;
    }
  }

  private selectWholeSnapSection(): void {
    if (!this.snapSelection) return;
    const section = getTrackBuilderHistory(this.key).draft.sections.find(candidate => candidate.id === this.snapSelection?.sectionId);

    if (!section) return;
    const source = section.sourceCoordinates ?? section.coordinates;

    this.snapSelection = {
      sectionId: section.id,
      start: section.startPosition ?? { segmentIndex: 0, t: 0 },
      end: section.endPosition ?? { segmentIndex: source.length - 2, t: 1 },
      ranges: [{
        start: section.startPosition ?? { segmentIndex: 0, t: 0 },
        end: section.endPosition ?? { segmentIndex: source.length - 2, t: 1 },
      }],
    };
    this.render();
  }

  private selectLargestRecordingGap(): void {
    const candidates = getTrackBuilderHistory(this.key).draft.sections.flatMap(section =>
      findTrackBuilderRecordingGaps(section).map(gap => ({ section, gap })));
    const selected = candidates.sort((left, right) => right.gap.elapsedSeconds - left.gap.elapsedSeconds)[0];

    if (!selected) {
      this.status.setText('No timed recording gap found');
      this.status.title = 'A repairable gap needs timestamps at both ends, at least 60 seconds elapsed, and at least 100 meters between recorded points.';

      return;
    }

    this.snapSelection = {
      sectionId: selected.section.id,
      start: selected.gap.start,
      end: selected.gap.end,
      ranges: [{ start: selected.gap.start, end: selected.gap.end }],
    };
    this.snapPreferredCandidate = undefined;
    this.render();
    this.status.setText(`Gap selected · ${Math.round(selected.gap.elapsedSeconds)} s`);
    this.status.title = `The endpoints are ${Math.round(selected.gap.directDistanceMeters)} m apart. Adjust the snap distance or preferred path, then apply the green preview.`;
  }

  private applySnapSelection(): void {
    const selection = this.snapSelection;

    if (!selection) return;
    const section = getTrackBuilderHistory(this.key).draft.sections.find(candidate => candidate.id === selection.sectionId);

    if (!section) return;

    try {
      const preview = this.snapPreview ?? this.createSnapPreview(section, selection);
      const currentSections = getTrackBuilderHistory(this.key).draft.sections;
      const next = replaceTrackBuilderRangesWithMapSections(
        currentSections,
        section.id,
        preview.replacements,
      );

      if (next.length === currentSections.length && next.every((candidate, index) => candidate === currentSections[index])) {
        throw new Error('The selected track range could not be replaced.');
      }

      replaceTrackBuilderSections(this.key, next);
      logger.scope('TrackBuilder').debug('snap range committed', {
        draftKey: this.key,
        section: sectionLogSummary(section),
        selection,
        source: 'rendered-map',
        radiusMeters: this.snapRadiusMeters,
        inputPointCount: preview.inputPointCount,
        sampleCount: preview.sampleCount,
        matchedSampleCount: preview.matchedSampleCount,
        mappedSections: preview.mappedSections.map(sectionLogData),
      });
      this.setMode('idle');
      this.status.setText(`Snapped to ${preview.mappedSections.length} visible map feature${preview.mappedSections.length === 1 ? '' : 's'}`);
    } catch (error) {
      const message = getErrorMessage(error);

      logger.scope('TrackBuilder').error('snap range failed', {
        draftKey: this.key,
        sectionId: section.id,
        source: 'rendered-map',
        error: message,
      });
      this.render();
      this.status.setText('Snap failed');
      this.status.title = message;
    }
  }

  private createSnapPreview(section: TrackBuilderSection, selection: SnapSelection): SnapPreview {
    const ranges = selection.ranges.filter(range => !positionsEqual(range.start, range.end));

    if (ranges.length === 0) throw new Error('Drag a boundary to select a non-empty track range.');
    const replacements = ranges.map(range => this.createSnapRangePreview(section, range));

    if (this.snapPreferredCandidate && !replacements.some(replacement => replacement.matchedPreferredCandidate)) {
      throw new Error('The chosen path does not cover this selection within the current snap distance. Increase the distance or choose another path.');
    }

    return {
      inputPointCount: replacements.reduce((sum, replacement) => sum + replacement.inputPointCount, 0),
      sampleCount: replacements.reduce((sum, replacement) => sum + replacement.sampleCount, 0),
      sampleSpacingPixels: Math.max(...replacements.map(replacement => replacement.sampleSpacingPixels)),
      matchedSampleCount: replacements.reduce((sum, replacement) => sum + replacement.matchedSampleCount, 0),
      candidateCount: replacements.reduce((sum, replacement) => sum + replacement.candidateCount, 0),
      candidatePreparationMs: replacements.reduce((sum, replacement) => sum + replacement.candidatePreparationMs, 0),
      traceMs: replacements.reduce((sum, replacement) => sum + replacement.traceMs, 0),
      sectionBuildMs: replacements.reduce((sum, replacement) => sum + replacement.sectionBuildMs, 0),
      mappedSections: replacements.flatMap(replacement => replacement.mappedSections),
      replacements,
    };
  }

  private createSnapRangePreview(section: TrackBuilderSection, selection: TrackBuilderRange): SnapRangePreview {
    const source = section.sourceCoordinates ?? section.coordinates;
    const originalStart = section.startPosition ?? { segmentIndex: 0, t: 0 };
    const originalEnd = section.endPosition ?? { segmentIndex: source.length - 2, t: 1 };
    const low = comparePositions(selection.start, selection.end) <= 0 ? selection.start : selection.end;
    const high = comparePositions(selection.start, selection.end) <= 0 ? selection.end : selection.start;
    const selectedStart = comparePositions(originalStart, originalEnd) <= 0 ? low : high;
    const selectedEnd = comparePositions(originalStart, originalEnd) <= 0 ? high : low;
    const coordinates = sliceLine(source, selectedStart, selectedEnd);
    const projected = coordinates.map(coordinate => {
      const point = this.options.map.project(coordinate as [number, number]);

      return { x: point.x, y: point.y };
    });
    const radiusPixels = this.mapSnapRadiusPixels(projected[Math.floor(projected.length / 2)]);
    const candidatePreparationStartedAt = performance.now();
    const candidateIndex = this.mapSnapCandidates(projected, radiusPixels);
    const candidatePreparationMs = performance.now() - candidatePreparationStartedAt;
    const sampleSpacingPixels = Math.max(MAP_SNAP_SAMPLE_SPACING_PIXELS, Math.min(12, radiusPixels / 3));
    const connectivity = new Map<string, boolean>();
    const traceStartedAt = performance.now();
    const trace = traceTrackBuilderMapPath<TrackBuilderSection>(
      projected,
      (point, preferred) => this.findMapSnapMatch(point, candidateIndex, radiusPixels, preferred),
      candidate => candidate.id,
      (left, right) => {
        const key = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`;
        const cached = connectivity.get(key);

        if (cached !== undefined) return cached;
        const connected = this.resolveSectionConnection(left, right).connected;

        connectivity.set(key, connected);

        return connected;
      },
      sampleSpacingPixels,
    );
    const traceMs = performance.now() - traceStartedAt;
    // A two-point repair range is only a chord used to locate its endpoints; it
    // does not describe the route between them. A partially matched chord can
    // cross an unrelated trail and must not become the preview. Only use
    // the sampling trace when it continuously covers the complete selection.
    // Otherwise route through the connected visible network, which also honors
    // the user's preferred line and avoids retained recorded geometry.
    const traceFullyCovered = trace.startMatched
      && trace.endMatched
      && trace.matchedSampleCount === trace.sampleCount;
    const graphRuns = !traceFullyCovered
      ? this.routeVisibleSnapNetwork(coordinates[0], coordinates[coordinates.length - 1], radiusPixels)
      : undefined;

    if (!traceFullyCovered && !graphRuns) {
      throw new Error('No connected visible road or trail joins the selected endpoints. Keep the complete path on screen, increase the distance, or choose additional selectable layers.');
    }

    const sectionBuildStartedAt = performance.now();
    const runs = graphRuns ?? trace.runs;
    const mappedSections = this.buildTraceSections(runs, section, 'end', false, coordinates[0], true, Boolean(graphRuns));
    const sectionBuildMs = performance.now() - sectionBuildStartedAt;

    if (mappedSections.length === 0) throw new Error('No connected road or trail geometry was found under the selected range.');

    return {
      start: selection.start,
      end: selection.end,
      inputPointCount: coordinates.length,
      sampleCount: trace.sampleCount,
      sampleSpacingPixels: Math.round(sampleSpacingPixels * 10) / 10,
      matchedSampleCount: trace.matchedSampleCount,
      candidateCount: candidateIndex.candidates.length,
      candidatePreparationMs: Math.round(candidatePreparationMs * 10) / 10,
      traceMs: Math.round(traceMs * 10) / 10,
      sectionBuildMs: Math.round(sectionBuildMs * 10) / 10,
      mappedSections,
      matchedPreferredCandidate: Boolean(this.snapPreferredCandidate
        && runs.some(run => run.candidate.id === this.snapPreferredCandidate?.id)),
    };
  }

  private routeVisibleSnapNetwork(startCoordinate: TrackBuilderCoordinate, endCoordinate: TrackBuilderCoordinate, corridorRadiusPixels: number): DragTraceRun[] | undefined {
    const sections = this.candidateSections(this.options.map.queryRenderedFeatures());

    if (this.snapPreferredCandidate && !sections.some(section => section.id === this.snapPreferredCandidate?.id)) {
      sections.push(this.snapPreferredCandidate);
    }

    if (sections.length === 0) {
      logger.scope('TrackBuilder').debug('visible snap network has no selectable candidates', {
        draftKey: this.key,
        selectableLayers: [...this.selectableLayers],
        customized: this.layerSelectionCustomized,
      });

      return undefined;
    }

    const positions = new Map<number, Map<string, TrackBuilderLinePosition>>();
    const keyForPosition = (candidateIndex: number, position: TrackBuilderLinePosition): string => {
      const offset = Math.round((position.segmentIndex + position.t) * 1e8) / 1e8;
      let candidatePositions = positions.get(candidateIndex);

      if (!candidatePositions) positions.set(candidateIndex, candidatePositions = new Map<string, TrackBuilderLinePosition>());
      const key = `${candidateIndex}:${offset}`;

      candidatePositions.set(key, position);

      return key;
    };
    const graph = new Map<string, SnapGraphEdge[]>();
    const addEdge = (from: string, edge: SnapGraphEdge): void => {
      const edges = graph.get(from) ?? [];

      edges.push(edge);
      graph.set(from, edges);
    };
    const anchor = (coordinate: TrackBuilderCoordinate, virtualKey: string): number => {
      let count = 0;

      for (let index = 0; index < sections.length; index++) {
        const candidateCoordinates = sections[index].sourceCoordinates ?? sections[index].coordinates;
        const connection = this.coordinateLineConnection(coordinate, candidateCoordinates);

        if (connection.geographicDistanceMeters > this.snapRadiusMeters) continue;
        const key = keyForPosition(index, connection.position);

        addEdge(virtualKey, { to: key, weight: connection.geographicDistanceMeters });
        addEdge(key, { to: virtualKey, weight: connection.geographicDistanceMeters });
        count++;
      }

      return count;
    };
    const startAnchorCount = anchor(startCoordinate, 'start');
    const endAnchorCount = anchor(endCoordinate, 'end');

    if (startAnchorCount === 0 || endAnchorCount === 0) {
      logger.scope('TrackBuilder').debug('visible snap network endpoint unmatched', {
        draftKey: this.key,
        candidateCount: sections.length,
        startAnchorCount,
        endAnchorCount,
        radiusMeters: this.snapRadiusMeters,
        layers: [...new Set(sections.map(section => `${section.sourceLayer ?? ''}/${section.layerId}`))],
      });

      return undefined;
    }

    let junctionCount = 0;

    for (let left = 0; left < sections.length; left++) {
      for (let right = left + 1; right < sections.length; right++) {
        const resolution = this.resolveSectionConnection(sections[left], sections[right]);

        if (!resolution.connected) continue;
        const connections = compatibleTrackBuilderJunctions(
          sections[left],
          sections[right],
          coordinate => {
            const point = this.options.map.project(coordinate as [number, number]);

            return [point.x, point.y];
          },
          (a, b) => DistanceCalculator.haversineDistanceMeters(a[1], a[0], b[1], b[0]),
          JUNCTION_MAX_SCREEN_DISTANCE_PIXELS,
          JUNCTION_MAX_GEOGRAPHIC_DISTANCE_METERS,
          this.options.config.respectGradeSeparation,
        );

        connections.push(resolution.connection);
        const pairKeys = new Set<string>();

        for (const connection of connections) {
          const leftKey = keyForPosition(left, connection.a);
          const rightKey = keyForPosition(right, connection.b);
          const pairKey = `${leftKey}>${rightKey}`;

          if (pairKeys.has(pairKey)) continue;
          pairKeys.add(pairKey);
          addEdge(leftKey, { to: rightKey, weight: connection.geographicDistanceMeters });
          addEdge(rightKey, { to: leftKey, weight: connection.geographicDistanceMeters });
          junctionCount++;
        }
      }
    }

    let corridorPenalizedEdgeCount = 0;

    for (const [candidateIndex, candidatePositions] of positions) {
      const ordered = [...candidatePositions.entries()].sort((left, right) => this.positionOffset(left[1]) - this.positionOffset(right[1]));
      const coordinates = sections[candidateIndex].sourceCoordinates ?? sections[candidateIndex].coordinates;

      for (let index = 1; index < ordered.length; index++) {
        const [leftKey, leftPosition] = ordered[index - 1];
        const [rightKey, rightPosition] = ordered[index];
        const range = sliceLine(coordinates, leftPosition, rightPosition);
        const distance = this.coordinatePathDistance(range);
        const deviation = this.maximumPathDeviationPixels(range, startCoordinate, endCoordinate);
        const normalizedDeviation = deviation / Math.max(1, corridorRadiusPixels);
        const weight = distance * (1 + normalizedDeviation * normalizedDeviation);

        if (deviation > corridorRadiusPixels) corridorPenalizedEdgeCount++;
        addEdge(leftKey, { to: rightKey, weight, candidate: sections[candidateIndex], start: leftPosition, end: rightPosition });
        addEdge(rightKey, { to: leftKey, weight, candidate: sections[candidateIndex], start: rightPosition, end: leftPosition });
      }
    }

    const preferredIndexes = new Set<number>();

    if (this.snapPreferredCandidate) {
      sections.forEach((section, index) => {
        if (section.id === this.snapPreferredCandidate?.id) preferredIndexes.add(index);
      });
    }

    const requiresPreferred = preferredIndexes.size > 0;
    const stateKey = (node: string, visitedPreferred: boolean): string => `${node}\u0000${visitedPreferred ? 1 : 0}`;
    const stateNode = (state: string): string => state.slice(0, state.lastIndexOf('\u0000'));
    const stateVisited = (state: string): boolean => state.endsWith('\u00001');
    const startState = stateKey('start', !requiresPreferred);
    const endState = stateKey('end', true);
    const distance = new Map<string, number>([[startState, 0]]);
    const previous = new Map<string, { from: string; edge: SnapGraphEdge }>();
    const pending = new Set<string>([startState]);

    while (pending.size > 0) {
      let current: string | undefined;
      let currentDistance = Number.POSITIVE_INFINITY;

      for (const key of pending) {
        const value = distance.get(key) ?? Number.POSITIVE_INFINITY;

        if (value < currentDistance) { current = key; currentDistance = value; }
      }

      if (!current || !Number.isFinite(currentDistance)) break;
      pending.delete(current);
      if (current === endState) break;
      const node = stateNode(current);

      for (const edge of graph.get(node) ?? []) {
        const destinationIndex = Number.parseInt(edge.to.split(':', 1)[0], 10);
        const visitedPreferred = stateVisited(current)
          || (edge.candidate !== undefined && edge.candidate.id === this.snapPreferredCandidate?.id)
          || preferredIndexes.has(destinationIndex);
        const nextState = stateKey(edge.to, visitedPreferred);
        const nextDistance = currentDistance + edge.weight;

        if (nextDistance >= (distance.get(nextState) ?? Number.POSITIVE_INFINITY)) continue;
        distance.set(nextState, nextDistance);
        previous.set(nextState, { from: current, edge });
        pending.add(nextState);
      }
    }

    if (!previous.has(endState)) {
      logger.scope('TrackBuilder').debug('visible snap network is disconnected', {
        draftKey: this.key,
        candidateCount: sections.length,
        startAnchorCount,
        endAnchorCount,
        junctionCount,
        graphNodeCount: graph.size,
        corridorPenalizedEdgeCount,
        corridorRadiusPixels: Math.round(corridorRadiusPixels * 10) / 10,
        layers: [...new Set(sections.map(section => `${section.sourceLayer ?? ''}/${section.layerId}`))],
      });

      return undefined;
    }

    const edges: SnapGraphEdge[] = [];
    let cursor = endState;

    while (cursor !== startState) {
      const step = previous.get(cursor);

      if (!step) return undefined;
      edges.push(step.edge);
      cursor = step.from;
    }

    edges.reverse();
    const routeDistanceMeters = edges.reduce((total, edge) => {
      if (!edge.candidate || !edge.start || !edge.end) return total + edge.weight;
      const coordinates = edge.candidate.sourceCoordinates ?? edge.candidate.coordinates;

      return total + this.coordinatePathDistance(sliceLine(coordinates, edge.start, edge.end));
    }, 0);
    const runs: DragTraceRun[] = [];

    for (const edge of edges) {
      if (!edge.candidate || !edge.start || !edge.end) continue;
      const last = runs[runs.length - 1];

      if (last?.candidate.id === edge.candidate.id && positionsEqual(last.end, edge.start)) last.end = edge.end;
      else runs.push({ candidate: edge.candidate, start: edge.start, end: edge.end });
    }

    logger.scope('TrackBuilder').debug('visible snap network route resolved', {
      draftKey: this.key,
      candidateCount: sections.length,
      junctionCount,
      corridorPenalizedEdgeCount,
      corridorRadiusPixels: Math.round(corridorRadiusPixels * 10) / 10,
      distanceMeters: Math.round(routeDistanceMeters),
      routeCost: Math.round((distance.get(endState) ?? 0) * 10) / 10,
      runCount: runs.length,
      runs: runs.map(run => ({
        id: run.candidate.id,
        layerId: run.candidate.layerId,
        sourceLayer: run.candidate.sourceLayer,
        start: run.start,
        end: run.end,
        startCoordinate: interpolateLine(run.candidate.sourceCoordinates ?? run.candidate.coordinates, run.start),
        endCoordinate: interpolateLine(run.candidate.sourceCoordinates ?? run.candidate.coordinates, run.end),
      })),
    });

    return runs.length > 0 ? runs : undefined;
  }

  private coordinatePathDistance(points: readonly TrackBuilderCoordinate[]): number {
    let distance = 0;

    for (let index = 1; index < points.length; index++) distance += DistanceCalculator.haversineDistanceMeters(points[index - 1][1], points[index - 1][0], points[index][1], points[index][0]);

    return distance;
  }

  private maximumPathDeviationPixels(points: readonly TrackBuilderCoordinate[], start: TrackBuilderCoordinate, end: TrackBuilderCoordinate): number {
    const a = this.options.map.project(start as [number, number]);
    const b = this.options.map.project(end as [number, number]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let maximum = 0;

    for (const coordinate of points) {
      const point = this.options.map.project(coordinate as [number, number]);
      const t = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));

      maximum = Math.max(maximum, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
    }

    return maximum;
  }

  private mapSnapRadiusPixels(point: TrackBuilderMapSnapPoint): number {
    const lngLat = this.options.map.unproject(point as maplibregl.Point);
    const offset = this.options.map.project([lngLat.lng, lngLat.lat + this.snapRadiusMeters / 111_320]);

    return Math.max(4, Math.min(MAP_SNAP_MAX_RADIUS_PIXELS, Math.hypot(offset.x - point.x, offset.y - point.y)));
  }

  private mapSnapCandidates(points: readonly TrackBuilderMapSnapPoint[], radiusPixels: number): SnapCandidateIndex {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const sections = this.candidateSections(this.options.map.queryRenderedFeatures([
      [minX - radiusPixels, minY - radiusPixels],
      [maxX + radiusPixels, maxY + radiusPixels],
    ]));

    if (this.snapPreferredCandidate && !sections.some(section => section.id === this.snapPreferredCandidate?.id)) {
      sections.push(this.snapPreferredCandidate);
    }

    return this.createCandidateIndex(sections, radiusPixels, { minX, minY, maxX, maxY });
  }

  private visibleCandidateIndex(radiusPixels: number): SnapCandidateIndex {
    return this.createCandidateIndex(
      this.candidateSections(this.options.map.queryRenderedFeatures()),
      radiusPixels,
    );
  }

  private createCandidateIndex(sections: readonly TrackBuilderSection[], radiusPixels: number, bounds?: TrackBuilderCandidateBounds): SnapCandidateIndex {
    const candidates = sections.map(section => {
      const projected = (section.sourceCoordinates ?? section.coordinates).map(coordinate => {
        const point = this.options.map.project(coordinate as [number, number]);

        return [point.x, point.y] as TrackBuilderSelectionPoint;
      });

      return {
        candidate: section,
        points: projected,
        bounds: trackBuilderCandidateBounds(projected),
      };
    });

    return createTrackBuilderCandidateIndex(candidates, radiusPixels, bounds);
  }

  private findMapSnapMatch(point: TrackBuilderMapSnapPoint, candidateIndex: SnapCandidateIndex, radiusPixels: number, preferred?: TrackBuilderSection): TrackBuilderMapSnapMatch<TrackBuilderSection> | undefined {
    const radiusMeters = this.snapRadiusMeters;
    const lngLat = this.options.map.unproject(point as maplibregl.Point);
    const candidates = trackBuilderCandidatesAt(candidateIndex, [point.x, point.y]);

    const match = (candidate: SnapCandidate): (TrackBuilderMapSnapMatch<TrackBuilderSection> & {
      readonly screenDistancePixels: number;
    }) | undefined => {
      if (point.x < candidate.bounds.minX - radiusPixels
        || point.x > candidate.bounds.maxX + radiusPixels
        || point.y < candidate.bounds.minY - radiusPixels
        || point.y > candidate.bounds.maxY + radiusPixels) return undefined;

      const candidateCoordinates = candidate.candidate.sourceCoordinates ?? candidate.candidate.coordinates;
      const closest = closestTrackBuilderProjectedPosition([point.x, point.y], candidate.points);
      const position = closest.position;
      const coordinate = interpolateLine(candidateCoordinates, position);
      const screenDistancePixels = closest.distance;

      if (screenDistancePixels > radiusPixels || DistanceCalculator.haversineDistanceMeters(lngLat.lat, lngLat.lng, coordinate[1], coordinate[0]) > radiusMeters) return undefined;

      return { candidate: candidate.candidate, position, screenDistancePixels };
    };

    let closest: ReturnType<typeof match>;

    for (const candidate of candidates) {
      const candidateMatch = match(candidate);

      if (candidateMatch && (!closest || candidateMatch.screenDistancePixels < closest.screenDistancePixels)) closest = candidateMatch;
    }

    const chosen = this.snapPreferredCandidate
      ? candidates.find(candidate => candidate.candidate.id === this.snapPreferredCandidate?.id)
      : undefined;
    const chosenMatch = chosen ? match(chosen) : undefined;

    if (chosenMatch) return chosenMatch;
    const previous = preferred ? candidates.find(candidate => candidate.candidate.id === preferred.id) : undefined;
    const preferredMatch = previous ? match(previous) : undefined;

    if (preferredMatch && shouldKeepPreferredTrackCandidate(
      preferredMatch.screenDistancePixels,
      closest?.screenDistancePixels ?? Number.POSITIVE_INFINITY,
      radiusPixels,
    )) {
      return preferredMatch;
    }

    return closest;
  }

  private clampPositionToSection(position: TrackBuilderLinePosition, section: TrackBuilderSection): TrackBuilderLinePosition {
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const start = section.startPosition ?? { segmentIndex: 0, t: 0 };
    const end = section.endPosition ?? { segmentIndex: sourceCoordinates.length - 2, t: 1 };
    const low = comparePositions(start, end) <= 0 ? start : end;
    const high = comparePositions(start, end) <= 0 ? end : start;

    if (comparePositions(position, low) < 0) return low;
    if (comparePositions(position, high) > 0) return high;

    return position;
  }

  // A local snap selection around the click, both handles visibly apart.
  private centeredSelectionRange(section: TrackBuilderSection, center: TrackBuilderLinePosition): { start: TrackBuilderLinePosition; end: TrackBuilderLinePosition } {
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const sectionStart = section.startPosition ?? { segmentIndex: 0, t: 0 };
    const sectionEnd = section.endPosition ?? { segmentIndex: sourceCoordinates.length - 2, t: 1 };
    const lowBound = Math.min(this.positionOffset(sectionStart), this.positionOffset(sectionEnd));
    const highBound = Math.max(this.positionOffset(sectionStart), this.positionOffset(sectionEnd));
    const centerOffset = Math.max(lowBound, Math.min(highBound, this.positionOffset(center)));
    let low = Math.max(lowBound, Math.floor(centerOffset));
    let high = Math.min(highBound, Math.ceil(centerOffset));

    // Dense GPX points can be sub-pixel apart. Expand symmetrically until the
    // circle centers are usable, while remaining inside the committed section.
    while (this.positionScreenDistance(sourceCoordinates, low, high) < 32 && (low > lowBound || high < highBound)) {
      if (low > lowBound) low = Math.max(lowBound, low - 1);
      if (high < highBound) high = Math.min(highBound, high + 1);
    }

    const lowPosition = this.offsetPosition(low, sourceCoordinates.length);
    const highPosition = this.offsetPosition(high, sourceCoordinates.length);

    return comparePositions(sectionStart, sectionEnd) <= 0
      ? { start: lowPosition, end: highPosition }
      : { start: highPosition, end: lowPosition };
  }

  private reverseDirection(): void {
    const sections = getTrackBuilderHistory(this.key).draft.sections;

    if (sections.length === 0) {
      this.status.setText('Nothing to reverse');

      return;
    }

    const reversed = sections.map((section, oldIndex) => ({ section, oldIndex }))
      .reverse()
      .map(({ section, oldIndex }, index) => ({
        ...reverseTrackBuilderSection(section),
        breakBefore: index === 0 ? undefined : sections[oldIndex + 1]?.breakBefore || undefined,
      }));

    this.deleteSelections = [];
    this.snapSelection = undefined;
    replaceTrackBuilderSections(this.key, reversed);
    logger.scope('TrackBuilder').debug('track direction reversed', {
      draftKey: this.key,
      sections: reversed.map(sectionLogData),
    });
    this.render();
    this.status.setText('Track direction reversed');
  }

  private positionOffset(position: TrackBuilderLinePosition): number {
    return position.segmentIndex + position.t;
  }

  private offsetPosition(offset: number, coordinateCount: number): TrackBuilderLinePosition {
    const maximum = coordinateCount - 1;
    const clamped = Math.max(0, Math.min(maximum, offset));

    if (clamped >= maximum) return { segmentIndex: maximum - 1, t: 1 };
    const segmentIndex = Math.floor(clamped);

    return { segmentIndex, t: clamped - segmentIndex };
  }

  private positionScreenDistance(coordinates: readonly TrackBuilderCoordinate[], a: number, b: number): number {
    const first = this.options.map.project(interpolateLine(coordinates, this.offsetPosition(a, coordinates.length)) as [number, number]);
    const second = this.options.map.project(interpolateLine(coordinates, this.offsetPosition(b, coordinates.length)) as [number, number]);

    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private applyDeleteSelection(): void {
    if (this.deleteSelections.length === 0) return;
    const history = getTrackBuilderHistory(this.key);
    const originalOrder = new Map(history.draft.sections.map((section, index) => [section.id, index]));
    const selections = [...this.deleteSelections]
      .filter(selection => originalOrder.has(selection.sectionId))
      .sort((a, b) => originalOrder.get(b.sectionId)! - originalOrder.get(a.sectionId)!);
    let sections = [...history.draft.sections];
    const committed: Array<{ selection: DeleteSelection; section: TrackBuilderSection; retained: TrackBuilderSection[] }> = [];

    for (const selection of selections) {
      const result = this.deleteSelectionFromSections(sections, selection);

      sections = result.sections;
      if (result.section) committed.push({ selection, section: result.section, retained: result.retained });
    }

    logger.scope('TrackBuilder').debug('delete ranges committed', {
      draftKey: this.key,
      count: committed.length,
      deletions: committed.map(({ selection, section, retained }) => ({
        section: sectionLogData(section),
        selection,
        retained: retained.map(sectionLogData),
        wholeSectionDeleted: retained.length === 0,
      })),
    });
    if (committed.length > 0) replaceTrackBuilderSections(this.key, sections);
    this.deleteSelections = [];
    this.render();
  }

  private deleteSelectionFromSections(sections: TrackBuilderSection[], selection: DeleteSelection): {
    sections: TrackBuilderSection[];
    section?: TrackBuilderSection;
    retained: TrackBuilderSection[];
  } {
    const sectionIndex = sections.findIndex(section => section.id === selection.sectionId);

    if (sectionIndex < 0) return { sections, retained: [] };
    const section = sections[sectionIndex];
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const originalStart = section.startPosition ?? { segmentIndex: 0, t: 0 };
    const originalEnd = section.endPosition ?? { segmentIndex: sourceCoordinates.length - 2, t: 1 };
    const selectedLow = comparePositions(selection.start, selection.end) <= 0 ? selection.start : selection.end;
    const selectedHigh = comparePositions(selection.start, selection.end) <= 0 ? selection.end : selection.start;

    if (positionsEqual(selectedLow, selectedHigh)) return { sections, retained: [] };

    const retained: TrackBuilderSection[] = [];

    if (comparePositions(originalStart, originalEnd) <= 0) {
      if (!positionsEqual(originalStart, selectedLow) && comparePositions(originalStart, selectedLow) < 0) retained.push(this.trimmedPiece(section, originalStart, selectedLow, 'before'));
      if (!positionsEqual(selectedHigh, originalEnd) && comparePositions(selectedHigh, originalEnd) < 0) retained.push(this.trimmedPiece(section, selectedHigh, originalEnd, 'after'));
    } else {
      if (!positionsEqual(selectedHigh, originalStart) && comparePositions(selectedHigh, originalStart) < 0) retained.push(this.trimmedPiece(section, originalStart, selectedHigh, 'before'));
      if (!positionsEqual(originalEnd, selectedLow) && comparePositions(originalEnd, selectedLow) < 0) retained.push(this.trimmedPiece(section, selectedLow, originalEnd, 'after'));
    }

    const deletesRouteStart = positionsEqual(originalStart, selectedLow) || positionsEqual(originalStart, selectedHigh);
    const deletesRouteEnd = positionsEqual(originalEnd, selectedLow) || positionsEqual(originalEnd, selectedHigh);

    if (retained.length === 2) retained[1] = { ...retained[1], breakBefore: true };
    else if (retained.length === 1 && deletesRouteStart) retained[0] = { ...retained[0], breakBefore: true };

    const next = [...sections];

    next.splice(sectionIndex, 1, ...retained);

    if (retained.length > 0 && deletesRouteEnd && next[sectionIndex + retained.length]) {
      next[sectionIndex + retained.length] = { ...next[sectionIndex + retained.length], breakBefore: true };
    }

    return { sections: retained.length === 0 ? this.reconnectDeletionSeam(next, sectionIndex - 1) : next, section, retained };
  }

  private trimmedPiece(section: TrackBuilderSection, start: TrackBuilderLinePosition, end: TrackBuilderLinePosition, suffix: string): TrackBuilderSection {
    const piece = this.sectionBetween(section, start, end);
    const coordinates = [...piece.coordinates];
    const preserveStart = section.startPosition && positionsEqual(start, section.startPosition) ? section.startCoordinateOverride : undefined;
    const preserveEnd = section.endPosition && positionsEqual(end, section.endPosition) ? section.endCoordinateOverride : undefined;

    if (preserveStart) coordinates[0] = preserveStart;
    if (preserveEnd) coordinates[coordinates.length - 1] = preserveEnd;

    return {
      ...piece,
      id: `${section.id}:trim-${suffix}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      coordinates,
      startCoordinateOverride: preserveStart,
      endCoordinateOverride: preserveEnd,
    };
  }

  private reconnectDeletionSeam(sections: TrackBuilderSection[], leftIndex: number): TrackBuilderSection[] {
    const left = sections[leftIndex];
    const right = sections[leftIndex + 1];

    if (!right) return sections;

    const disconnected = () => {
      const copy = [...sections];

      copy[leftIndex + 1] = { ...right, breakBefore: true };

      return copy;
    };

    if (!left?.sourceCoordinates || !left.startPosition || !left.endPosition || !right.sourceCoordinates || !right.startPosition || !right.endPosition) return disconnected();
    const connection = this.closestLineConnection(left.sourceCoordinates, right.sourceCoordinates);
    const leftJunction = interpolateLine(left.sourceCoordinates, connection.a);
    const rightJunction = interpolateLine(right.sourceCoordinates, connection.b);
    const leftEnd = left.coordinates[left.coordinates.length - 1];
    const rightStart = right.coordinates[0];
    const nearExistingEnds = DistanceCalculator.haversineDistanceMeters(leftEnd[1], leftEnd[0], leftJunction[1], leftJunction[0]) <= 20 && DistanceCalculator.haversineDistanceMeters(rightStart[1], rightStart[0], rightJunction[1], rightJunction[0]) <= 20;
    const sourceFeaturesMeet = connection.screenDistancePixels <= 2 && connection.geographicDistanceMeters <= 1;

    if (!nearExistingEnds || !sourceFeaturesMeet) {
      logger.scope('TrackBuilder').debug('delete seam left disconnected', {
        draftKey: this.key,
        left: left.id,
        right: right.id,
        connection,
        leftEndpointDistanceMeters: DistanceCalculator.haversineDistanceMeters(leftEnd[1], leftEnd[0], leftJunction[1], leftJunction[0]),
        rightEndpointDistanceMeters: DistanceCalculator.haversineDistanceMeters(rightStart[1], rightStart[0], rightJunction[1], rightJunction[0]),
      });

      return disconnected();
    }

    const common: TrackBuilderCoordinate = [
      (leftJunction[0] + rightJunction[0]) / 2,
      (leftJunction[1] + rightJunction[1]) / 2,
    ];
    const connected = [...sections];

    connected[leftIndex] = this.resizeCommittedSection(left, left.startPosition, connection.a, left.startCoordinateOverride, common);
    connected[leftIndex + 1] = { ...this.resizeCommittedSection(right, connection.b, right.endPosition, common, right.endCoordinateOverride), breakBefore: false };
    logger.scope('TrackBuilder').debug('delete seam reconnected', {
      draftKey: this.key,
      left: left.id,
      right: right.id,
      connection,
      common,
    });

    return connected;
  }

  private resizeCommittedSection(
    section: TrackBuilderSection,
    start: TrackBuilderLinePosition,
    end: TrackBuilderLinePosition,
    startOverride?: TrackBuilderCoordinate,
    endOverride?: TrackBuilderCoordinate,
  ): TrackBuilderSection {
    const coordinates = sliceLine(section.sourceCoordinates ?? section.coordinates, start, end);

    if (startOverride) coordinates[0] = startOverride;
    if (endOverride) coordinates[coordinates.length - 1] = endOverride;

    return { ...section, startPosition: start, endPosition: end, startCoordinateOverride: startOverride, endCoordinateOverride: endOverride, coordinates };
  }

  private orientNewSection(section: TrackBuilderSection): TrackBuilderSection {
    const sections = getTrackBuilderHistory(this.key).draft.sections;
    const previousCoordinates = sections[sections.length - 1]?.coordinates;
    const previousEnd = previousCoordinates?.[previousCoordinates.length - 1];

    if (!previousEnd || !section.startPosition || !section.endPosition) return section;
    const start = section.coordinates[0];
    const end = section.coordinates[section.coordinates.length - 1];

    if (coordinateDistanceSquared(previousEnd, start) <= coordinateDistanceSquared(previousEnd, end)) return section;

    return reverseTrackBuilderSection(section);
  }

  // A rendered road/trail feature often includes geometry already present in the draft. Keep the
  // new middle/tail only, stopping exactly where its endpoint overlap meets the existing draft.
  // Interior point crossings are not clipped.
  private clipAddedSectionAgainstDraft(section: TrackBuilderSection, pointer?: maplibregl.Point): ClippedAddedSection | undefined {
    const existing = getTrackBuilderHistory(this.key).draft.sections;

    if (existing.length === 0) return { section };
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const continuation = pointer ? this.continuationFromDraftEndpoint(section, existing, pointer) : undefined;

    if (continuation) return continuation;
    const samples = this.overlapSamples(sourceCoordinates, existing);
    const clip = clipEndpointOverlapSamples(samples);

    if (!clip) return samples.some(sample => !sample.coveredBy) ? this.connectAddedSectionEndpoints(section, existing) : undefined;
    if (!clip.startTransition && !clip.endTransition) return this.connectAddedSectionEndpoints(section, existing);

    const startOffset = clip.startTransition
      ? this.refineOverlapTransition(sourceCoordinates, existing, clip.startTransition.coveredOffset, clip.startTransition.uncoveredOffset)
      : 0;
    const endOffset = clip.endTransition
      ? this.refineOverlapTransition(sourceCoordinates, existing, clip.endTransition.coveredOffset, clip.endTransition.uncoveredOffset)
      : sourceCoordinates.length - 1;

    if (endOffset - startOffset <= 1e-6) return undefined;

    const start = this.offsetPosition(startOffset, sourceCoordinates.length);
    const end = this.offsetPosition(endOffset, sourceCoordinates.length);
    const clipped = this.sectionBetween(section, start, end);
    const coordinates = [...clipped.coordinates];
    // Use the known-covered side of the transition. Rechecking the refined midpoint can land a
    // fraction outside the tolerance and lose a junction that was already positively identified.
    const startContact = clip.startTransition
      ? this.closestDraftOverlap(
        interpolateLine(sourceCoordinates, this.offsetPosition(clip.startTransition.coveredOffset, sourceCoordinates.length)),
        existing,
        clip.startTransition.coveredBy,
      )
      : undefined;
    const endContact = clip.endTransition
      ? this.closestDraftOverlap(
        interpolateLine(sourceCoordinates, this.offsetPosition(clip.endTransition.coveredOffset, sourceCoordinates.length)),
        existing,
        clip.endTransition.coveredBy,
      )
      : undefined;

    if (startContact) coordinates[0] = startContact.coordinate;
    if (endContact) coordinates[coordinates.length - 1] = endContact.coordinate;

    const result: TrackBuilderSection = {
      ...clipped,
      coordinates,
      startCoordinateOverride: startContact?.coordinate,
      endCoordinateOverride: endContact?.coordinate,
    };

    logger.scope('TrackBuilder').debug('added feature clipped against existing draft', {
      draftKey: this.key,
      sourceSectionId: section.id,
      clip,
      startPosition: start,
      endPosition: end,
      startContact: startContact ? { sectionId: startContact.section.id, coordinate: startContact.coordinate } : undefined,
      endContact: endContact ? { sectionId: endContact.section.id, coordinate: endContact.coordinate } : undefined,
    });

    return this.connectAddedSectionEndpoints(result, existing, startContact, endContact);
  }

  private continuationFromDraftEndpoint(section: TrackBuilderSection, existing: readonly TrackBuilderSection[], pointer: maplibregl.Point): ClippedAddedSection | undefined {
    const source = section.sourceCoordinates ?? section.coordinates;
    const first = existing[0];
    const last = existing[existing.length - 1];
    const routeStart = first?.coordinates[0];
    const routeEnd = last?.coordinates[last.coordinates.length - 1];

    if (!routeStart || !routeEnd || source.length < 2) return undefined;
    const pointerPosition = this.positionOnLine(pointer, source);
    const endpoints = [
      { endpoint: 'start' as const, section: first, coordinate: routeStart },
      { endpoint: 'end' as const, section: last, coordinate: routeEnd },
    ];
    const candidates = endpoints.map(endpoint => {
      const endpointPoint = this.options.map.project(endpoint.coordinate as [number, number]);
      const connection = this.positionOnLine(endpointPoint, source, pointerPosition);
      const connectionCoordinate = interpolateLine(source, connection);
      const connectionPoint = this.options.map.project(connectionCoordinate as [number, number]);

      return {
        ...endpoint,
        connection,
        connectionCoordinate,
        screenDistancePixels: Math.hypot(endpointPoint.x - connectionPoint.x, endpointPoint.y - connectionPoint.y),
        geographicDistanceMeters: DistanceCalculator.haversineDistanceMeters(
          endpoint.coordinate[1], endpoint.coordinate[0],
          connectionCoordinate[1], connectionCoordinate[0],
        ),
      };
    });
    const selected = chooseTrackEndpointContinuation(
      candidates,
      pointerPosition,
      ADD_OVERLAP_MAX_SCREEN_DISTANCE_PIXELS,
      ADD_OVERLAP_MAX_GEOGRAPHIC_DISTANCE_METERS,
    );

    if (!selected) return undefined;
    const { connection, coordinate: endpointCoordinate } = selected;

    const sourceStart = { segmentIndex: 0, t: 0 };
    const sourceEnd = { segmentIndex: source.length - 2, t: 1 };
    const outwardEnd = comparePositions(pointerPosition, connection) >= 0 ? sourceEnd : sourceStart;
    const continued = this.sectionBetween(section, connection, outwardEnd);
    const coordinates = [...continued.coordinates];

    coordinates[0] = endpointCoordinate;
    const contact: DraftOverlapContact = {
      section: selected.section,
      position: selected.endpoint === 'start'
        ? selected.section.startPosition ?? { segmentIndex: 0, t: 0 }
        : selected.section.endPosition ?? { segmentIndex: selected.section.coordinates.length - 2, t: 1 },
      coordinate: endpointCoordinate,
      screenDistancePixels: selected.screenDistancePixels,
      geographicDistanceMeters: selected.geographicDistanceMeters,
    };

    logger.scope('TrackBuilder').debug('candidate continued from draft endpoint', {
      draftKey: this.key,
      sourceSectionId: section.id,
      endpoint: selected.endpoint,
      endpointSectionId: selected.section.id,
      connection,
      pointerPosition,
      outwardEnd,
      screenDistancePixels: selected.screenDistancePixels,
      geographicDistanceMeters: selected.geographicDistanceMeters,
    });

    return {
      section: {
        ...continued,
        coordinates,
        startCoordinateOverride: endpointCoordinate,
        breakBefore: false,
      },
      startContact: contact,
    };
  }

  private connectAddedSectionEndpoints(section: TrackBuilderSection, existing: readonly TrackBuilderSection[], confirmedStart?: DraftOverlapContact, confirmedEnd?: DraftOverlapContact): ClippedAddedSection {
    const coordinates = [...section.coordinates];
    const startContact = confirmedStart ?? this.closestAlignedDraftEndpoint(coordinates, 'start', existing);
    const endContact = confirmedEnd ?? this.closestAlignedDraftEndpoint(coordinates, 'end', existing);

    if (startContact) coordinates[0] = startContact.coordinate;
    if (endContact) coordinates[coordinates.length - 1] = endContact.coordinate;

    return {
      section: {
        ...section,
        coordinates,
        startCoordinateOverride: startContact?.coordinate ?? section.startCoordinateOverride,
        endCoordinateOverride: endContact?.coordinate ?? section.endCoordinateOverride,
      },
      startContact,
      endContact,
    };
  }

  private closestAlignedDraftEndpoint(coordinates: readonly TrackBuilderCoordinate[], endpoint: 'start' | 'end', existing: readonly TrackBuilderSection[]): DraftOverlapContact | undefined {
    if (coordinates.length < 2) return undefined;
    const endpointIndex = endpoint === 'start' ? 0 : coordinates.length - 1;
    const referenceIndex = endpoint === 'start'
      ? Math.min(coordinates.length - 1, 3)
      : Math.max(0, coordinates.length - 4);
    const coordinate = coordinates[endpointIndex];
    const point = this.options.map.project(coordinate as [number, number]);
    const reference = this.options.map.project(coordinates[referenceIndex] as [number, number]);
    const tangentX = point.x - reference.x;
    const tangentY = point.y - reference.y;
    const tangentLength = Math.hypot(tangentX, tangentY);

    if (tangentLength < 1e-6) return undefined;

    let best: DraftOverlapContact | undefined;

    for (const section of existing) {
      if (section.coordinates.length < 2) continue;

      for (const side of ['start', 'end'] as const) {
        const target = side === 'start' ? section.coordinates[0] : section.coordinates[section.coordinates.length - 1];
        const targetPoint = this.options.map.project(target as [number, number]);
        const dx = targetPoint.x - point.x;
        const dy = targetPoint.y - point.y;
        const targetLength = Math.hypot(dx, dy);

        if (targetLength < 1e-6) {
          return {
            section,
            position: side === 'start' ? { segmentIndex: 0, t: 0 } : { segmentIndex: section.coordinates.length - 2, t: 1 },
            coordinate: target,
            screenDistancePixels: 0,
            geographicDistanceMeters: 0,
          };
        }

        const distanceMeters = DistanceCalculator.haversineDistanceMeters(coordinate[1], coordinate[0], target[1], target[0]);
        const alignmentCosine = (tangentX * dx + tangentY * dy) / (tangentLength * targetLength);

        if (!shouldBridgeNearbyTrackEndpoint(distanceMeters, alignmentCosine)) continue;
        const candidate: DraftOverlapContact = {
          section,
          position: side === 'start' ? { segmentIndex: 0, t: 0 } : { segmentIndex: section.coordinates.length - 2, t: 1 },
          coordinate: target,
          screenDistancePixels: targetLength,
          geographicDistanceMeters: distanceMeters,
        };

        if (!best || candidate.geographicDistanceMeters < best.geographicDistanceMeters) best = candidate;
      }
    }

    if (best) {
      logger.scope('TrackBuilder').debug('added feature endpoint bridged to nearby draft endpoint', {
        draftKey: this.key,
        endpoint,
        from: coordinate,
        to: best.coordinate,
        sectionId: best.section.id,
        screenDistancePixels: best.screenDistancePixels,
        geographicDistanceMeters: best.geographicDistanceMeters,
      });
    }

    return best;
  }

  private orientAddedSection(clipped: ClippedAddedSection): ClippedAddedSection {
    const sections = getTrackBuilderHistory(this.key).draft.sections;
    const startIndex = clipped.startContact ? sections.findIndex(section => section.id === clipped.startContact!.section.id) : -1;
    const endIndex = clipped.endContact ? sections.findIndex(section => section.id === clipped.endContact!.section.id) : -1;

    if (startIndex >= 0 && endIndex >= 0 && endIndex + 1 === startIndex) {
      return { section: reverseTrackBuilderSection(clipped.section), startContact: clipped.endContact, endContact: clipped.startContact };
    }

    if (startIndex >= 0 && endIndex === startIndex + 1) return clipped;
    const section = this.orientNewSection(clipped.section);

    return section === clipped.section
      ? clipped
      : { section, startContact: clipped.endContact, endContact: clipped.startContact };
  }

  private commitAddedSection(added: ClippedAddedSection): void {
    const sections = getTrackBuilderHistory(this.key).draft.sections;
    const startIndex = added.startContact ? sections.findIndex(section => section.id === added.startContact!.section.id) : -1;
    const endIndex = added.endContact ? sections.findIndex(section => section.id === added.endContact!.section.id) : -1;
    const startsAtLeftEnd = startIndex >= 0 && DistanceCalculator.haversineDistanceMeters(
      added.startContact!.coordinate[1], added.startContact!.coordinate[0],
      sections[startIndex].coordinates[sections[startIndex].coordinates.length - 1][1], sections[startIndex].coordinates[sections[startIndex].coordinates.length - 1][0],
    ) <= 1;
    const endsAtRightStart = endIndex >= 0 && DistanceCalculator.haversineDistanceMeters(
      added.endContact!.coordinate[1], added.endContact!.coordinate[0],
      sections[endIndex].coordinates[0][1], sections[endIndex].coordinates[0][0],
    ) <= 1;

    if (startsAtLeftEnd && endsAtRightStart && endIndex === startIndex + 1) {
      const next = [...sections];

      next.splice(endIndex, 0, { ...added.section, breakBefore: false });
      next[endIndex + 1] = { ...next[endIndex + 1], breakBefore: false };
      replaceTrackBuilderSections(this.key, next);
      logger.scope('TrackBuilder').debug('added feature inserted between adjacent draft sections', {
        draftKey: this.key,
        leftSectionId: sections[startIndex].id,
        addedSectionId: added.section.id,
        rightSectionId: sections[endIndex].id,
      });

      return;
    }

    const firstCoordinates = sections[0]?.coordinates;
    const routeStart = firstCoordinates?.[0];
    const addedStart = added.section.coordinates[0];
    const addedEnd = added.section.coordinates[added.section.coordinates.length - 1];

    if (routeStart) {
      const startDistance = DistanceCalculator.haversineDistanceMeters(routeStart[1], routeStart[0], addedStart[1], addedStart[0]);
      const endDistance = DistanceCalculator.haversineDistanceMeters(routeStart[1], routeStart[0], addedEnd[1], addedEnd[0]);

      if (Math.min(startDistance, endDistance) <= CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS) {
        const prepended = startDistance <= endDistance ? reverseTrackBuilderSection(added.section) : added.section;

        prependTrackBuilderSections(this.key, [{ ...prepended, breakBefore: prepended.breakBefore }]);
        logger.scope('TrackBuilder').debug('connected feature prepended at route start', {
          draftKey: this.key,
          routeStart,
          added: sectionLogData(prepended),
          distanceMeters: Math.min(startDistance, endDistance),
        });

        return;
      }
    }

    const previousCoordinates = sections[sections.length - 1]?.coordinates;
    const previousEnd = previousCoordinates?.[previousCoordinates.length - 1];

    if (previousEnd && DistanceCalculator.haversineDistanceMeters(
      previousEnd[1], previousEnd[0],
      added.section.coordinates[0][1], added.section.coordinates[0][0],
    ) > CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS) {
      this.startNewPiece([added.section], 'feature');

      return;
    }

    appendTrackBuilderSection(this.key, added.section);
  }

  private overlapSamples(coordinates: readonly TrackBuilderCoordinate[], existing: readonly TrackBuilderSection[]): TrackOverlapSample[] {
    const samples: TrackOverlapSample[] = [];

    for (let index = 1; index < coordinates.length; index++) {
      const a = this.options.map.project(coordinates[index - 1] as [number, number]);
      const b = this.options.map.project(coordinates[index] as [number, number]);
      const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / ADD_OVERLAP_SAMPLE_SPACING_PIXELS));
      const firstStep = index === 1 ? 0 : 1;

      for (let step = firstStep; step <= count; step++) {
        const t = step / count;
        const coordinate: TrackBuilderCoordinate = [
          coordinates[index - 1][0] + (coordinates[index][0] - coordinates[index - 1][0]) * t,
          coordinates[index - 1][1] + (coordinates[index][1] - coordinates[index - 1][1]) * t,
        ];

        samples.push({
          offset: index - 1 + t,
          coveredBy: this.closestDraftOverlap(coordinate, existing)?.section.id,
        });
      }
    }

    return samples;
  }

  private refineOverlapTransition(coordinates: readonly TrackBuilderCoordinate[], existing: readonly TrackBuilderSection[], coveredOffset: number, uncoveredOffset: number): number {
    let covered = coveredOffset;
    let uncovered = uncoveredOffset;

    for (let iteration = 0; iteration < 10; iteration++) {
      const middle = (covered + uncovered) / 2;
      const coordinate = interpolateLine(coordinates, this.offsetPosition(middle, coordinates.length));

      if (this.closestDraftOverlap(coordinate, existing)) covered = middle;
      else uncovered = middle;
    }

    return (covered + uncovered) / 2;
  }

  private closestDraftOverlap(coordinate: TrackBuilderCoordinate, existing: readonly TrackBuilderSection[], preferredSectionId?: string): DraftOverlapContact | undefined {
    const point = this.options.map.project(coordinate as [number, number]);
    let best: DraftOverlapContact | undefined;

    for (const section of existing) {
      if (preferredSectionId && section.id !== preferredSectionId) continue;
      if (section.coordinates.length < 2) continue;
      const position = this.positionOnLine(point, section.coordinates);
      const projected = interpolateLine(section.coordinates, position);
      const projectedPoint = this.options.map.project(projected as [number, number]);
      const candidate: DraftOverlapContact = {
        section,
        position,
        coordinate: projected,
        screenDistancePixels: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y),
        geographicDistanceMeters: DistanceCalculator.haversineDistanceMeters(coordinate[1], coordinate[0], projected[1], projected[0]),
      };

      if (candidate.screenDistancePixels > ADD_OVERLAP_MAX_SCREEN_DISTANCE_PIXELS
        || candidate.geographicDistanceMeters > ADD_OVERLAP_MAX_GEOGRAPHIC_DISTANCE_METERS) continue;

      if (!best || candidate.screenDistancePixels < best.screenDistancePixels) best = candidate;
    }

    return best;
  }

  private sectionBetween(section: TrackBuilderSection, start: TrackBuilderLinePosition, end: TrackBuilderLinePosition): TrackBuilderSection {
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;

    return { ...section, id: `${section.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, sourceFeatureKey: section.sourceFeatureKey ?? section.id, sourceCoordinates, startPosition: start, endPosition: end, coordinates: sliceLine(sourceCoordinates, start, end) };
  }

  private positionOnLine(point: maplibregl.Point, coordinates: readonly TrackBuilderCoordinate[], reference?: TrackBuilderLinePosition): TrackBuilderLinePosition {
    const projected = coordinates.map(coordinate => {
      const screenPoint = this.options.map.project(coordinate as [number, number]);

      return [screenPoint.x, screenPoint.y] as TrackBuilderSelectionPoint;
    });

    return prioritizeTrackBuilderVertexPosition(
      projected,
      closestTrackBuilderLinePosition([point.x, point.y], projected, reference),
    );
  }

  private closestLineConnection(a: readonly TrackBuilderCoordinate[], b: readonly TrackBuilderCoordinate[]): {
    readonly a: TrackBuilderLinePosition;
    readonly b: TrackBuilderLinePosition;
    readonly screenDistancePixels: number;
    readonly geographicDistanceMeters: number;
  } {
    let best: { a: TrackBuilderLinePosition; b: TrackBuilderLinePosition; screenDistancePixels: number; geographicDistanceMeters: number } | undefined;
    const consider = (aPosition: TrackBuilderLinePosition, bPosition: TrackBuilderLinePosition) => {
      const aCoordinate = interpolateLine(a, aPosition);
      const bCoordinate = interpolateLine(b, bPosition);
      const aPoint = this.options.map.project(aCoordinate as [number, number]);
      const bPoint = this.options.map.project(bCoordinate as [number, number]);
      const candidate = {
        a: aPosition,
        b: bPosition,
        screenDistancePixels: Math.hypot(aPoint.x - bPoint.x, aPoint.y - bPoint.y),
        geographicDistanceMeters: DistanceCalculator.haversineDistanceMeters(aCoordinate[1], aCoordinate[0], bCoordinate[1], bCoordinate[0]),
      };

      if (!best || candidate.screenDistancePixels < best.screenDistancePixels) best = candidate;
    };
    const cross = (x1: number, y1: number, x2: number, y2: number) => x1 * y2 - y1 * x2;

    for (let aIndex = 1; aIndex < a.length; aIndex++) {
      const aStart = this.options.map.project(a[aIndex - 1] as [number, number]);
      const aEnd = this.options.map.project(a[aIndex] as [number, number]);
      const aDx = aEnd.x - aStart.x;
      const aDy = aEnd.y - aStart.y;

      for (let bIndex = 1; bIndex < b.length; bIndex++) {
        const bStart = this.options.map.project(b[bIndex - 1] as [number, number]);
        const bEnd = this.options.map.project(b[bIndex] as [number, number]);
        const bDx = bEnd.x - bStart.x;
        const bDy = bEnd.y - bStart.y;
        const denominator = cross(aDx, aDy, bDx, bDy);

        if (Math.abs(denominator) < 1e-9) continue;
        const offsetX = bStart.x - aStart.x;
        const offsetY = bStart.y - aStart.y;
        const aT = cross(offsetX, offsetY, bDx, bDy) / denominator;
        const bT = cross(offsetX, offsetY, aDx, aDy) / denominator;

        if (aT < -1e-6 || aT > 1 + 1e-6 || bT < -1e-6 || bT > 1 + 1e-6) continue;
        consider(
          { segmentIndex: aIndex - 1, t: Math.max(0, Math.min(1, aT)) },
          { segmentIndex: bIndex - 1, t: Math.max(0, Math.min(1, bT)) },
        );
      }
    }

    a.forEach((coordinate, index) => {
      const aPosition = index === a.length - 1 ? { segmentIndex: index - 1, t: 1 } : { segmentIndex: index, t: 0 };

      consider(aPosition, this.positionOnLine(this.options.map.project(coordinate as [number, number]), b));
    });
    b.forEach((coordinate, index) => {
      const bPosition = index === b.length - 1 ? { segmentIndex: index - 1, t: 1 } : { segmentIndex: index, t: 0 };

      consider(this.positionOnLine(this.options.map.project(coordinate as [number, number]), a), bPosition);
    });

    return best!;
  }

  private coordinateLineConnection(coordinate: TrackBuilderCoordinate, line: readonly TrackBuilderCoordinate[]): {
    readonly position: TrackBuilderLinePosition;
    readonly screenDistancePixels: number;
    readonly geographicDistanceMeters: number;
  } {
    const point = this.options.map.project(coordinate as [number, number]);
    const position = this.positionOnLine(point, line);
    const projected = interpolateLine(line, position);
    const projectedPoint = this.options.map.project(projected as [number, number]);

    return {
      position,
      screenDistancePixels: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y),
      geographicDistanceMeters: DistanceCalculator.haversineDistanceMeters(coordinate[1], coordinate[0], projected[1], projected[0]),
    };
  }

  private isContiguousConnection(connection: { readonly screenDistancePixels: number; readonly geographicDistanceMeters: number }): boolean {
    return connection.screenDistancePixels <= CONTIGUOUS_MAX_SCREEN_DISTANCE_PIXELS
      && connection.geographicDistanceMeters <= CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS;
  }

  private resolveSectionConnection(a: TrackBuilderSection, b: TrackBuilderSection): {
    readonly connection: {
      readonly a: TrackBuilderLinePosition;
      readonly b: TrackBuilderLinePosition;
      readonly screenDistancePixels: number;
      readonly geographicDistanceMeters: number;
    };
    readonly connected: boolean;
    readonly clusteredJunction: boolean;
  } {
    const exact = this.closestLineConnection(
      a.sourceCoordinates ?? a.coordinates,
      b.sourceCoordinates ?? b.coordinates,
    );
    const gradeCompatible = !this.options.config.respectGradeSeparation
      || areTrackBuilderJunctionSectionsCompatible(a, b);

    if (gradeCompatible && this.isContiguousConnection(exact)) {
      return { connection: exact, connected: true, clusteredJunction: false };
    }

    const junction = closestCompatibleTrackBuilderJunction(
      a,
      b,
      coordinate => {
        const point = this.options.map.project(coordinate as [number, number]);

        return [point.x, point.y];
      },
      (a, b) => DistanceCalculator.haversineDistanceMeters(a[1], a[0], b[1], b[0]),
      JUNCTION_MAX_SCREEN_DISTANCE_PIXELS,
      JUNCTION_MAX_GEOGRAPHIC_DISTANCE_METERS,
      this.options.config.respectGradeSeparation,
    );

    return junction
      ? { connection: junction, connected: true, clusteredJunction: true }
      : { connection: exact, connected: false, clusteredJunction: false };
  }

  private resolveSectionAnchorConnection(
    anchor: TrackBuilderCoordinate,
    source: TrackBuilderSection,
    candidate: TrackBuilderSection,
  ): {
    readonly position: TrackBuilderLinePosition;
    readonly screenDistancePixels: number;
    readonly geographicDistanceMeters: number;
    readonly connected: boolean;
    readonly clusteredJunction: boolean;
  } {
    const candidateCoordinates = candidate.sourceCoordinates ?? candidate.coordinates;
    const exact = this.coordinateLineConnection(anchor, candidateCoordinates);
    const gradeCompatible = !this.options.config.respectGradeSeparation
      || areTrackBuilderJunctionSectionsCompatible(source, candidate);

    if (gradeCompatible && this.isContiguousConnection(exact)) {
      return { ...exact, connected: true, clusteredJunction: false };
    }

    const junction = closestCompatibleTrackBuilderJunction(
      source,
      candidate,
      coordinate => {
        const point = this.options.map.project(coordinate as [number, number]);

        return [point.x, point.y];
      },
      (a, b) => DistanceCalculator.haversineDistanceMeters(a[1], a[0], b[1], b[0]),
      JUNCTION_MAX_SCREEN_DISTANCE_PIXELS,
      JUNCTION_MAX_GEOGRAPHIC_DISTANCE_METERS,
      this.options.config.respectGradeSeparation,
    );

    if (junction) {
      const sourceCoordinates = source.sourceCoordinates ?? source.coordinates;
      const sourceJunction = interpolateLine(sourceCoordinates, junction.a);
      const anchorPoint = this.options.map.project(anchor as [number, number]);
      const junctionPoint = this.options.map.project(sourceJunction as [number, number]);
      const anchorScreenDistance = Math.hypot(anchorPoint.x - junctionPoint.x, anchorPoint.y - junctionPoint.y);
      const anchorGeographicDistance = DistanceCalculator.haversineDistanceMeters(anchor[1], anchor[0], sourceJunction[1], sourceJunction[0]);

      if (anchorScreenDistance <= JUNCTION_MAX_SCREEN_DISTANCE_PIXELS
        && anchorGeographicDistance <= JUNCTION_MAX_GEOGRAPHIC_DISTANCE_METERS) {
        return {
          position: junction.b,
          screenDistancePixels: junction.screenDistancePixels,
          geographicDistanceMeters: junction.geographicDistanceMeters,
          connected: true,
          clusteredJunction: true,
        };
      }
    }

    return { ...exact, connected: false, clusteredJunction: false };
  }

  private renderHandleMarkers(sections: readonly TrackBuilderSection[]): void {
    this.clearHandleMarkers();

    if (this.direct) {
      for (const anchor of this.directEndpointAnchors()) this.handleMarkers.push(this.createDirectEndpointMarker(anchor));

      return;
    }

    if (this.snapping && this.snapSelection) {
      const selected = sections.find(section => section.id === this.snapSelection?.sectionId);

      if (selected) {
        this.handleMarkers.push(this.createRangeMarker(selected, this.snapSelection, 'start', 'snap'));
        this.handleMarkers.push(this.createRangeMarker(selected, this.snapSelection, 'end', 'snap'));
      }

      return;
    }

    if (this.deleting && this.deleteSelections.length > 0) {
      for (const selection of this.deleteSelections) {
        const selected = sections.find(section => section.id === selection.sectionId);

        if (!selected) continue;
        this.handleMarkers.push(this.createRangeMarker(selected, selection, 'start', 'delete'));
        this.handleMarkers.push(this.createRangeMarker(selected, selection, 'end', 'delete'));
      }

      return;
    }

    const first = sections[0];
    const last = sections[sections.length - 1];

    if (first?.sourceCoordinates && first.startPosition) this.handleMarkers.push(this.createEndpointMarker(first, 'start'));
    if (last?.sourceCoordinates && last.endPosition) this.handleMarkers.push(this.createEndpointMarker(last, 'end'));
  }

  private createDirectEndpointMarker(anchor: DirectEndpointAnchor): maplibregl.Marker {
    const element = this.options.container.createEl('button');

    element.className = `places-track-builder-handle is-${anchor.endpoint ?? 'leaf'} is-direct`;
    element.type = 'button';
    const selected = this.directAnchor && 'id' in this.directAnchor && this.directAnchor.id === anchor.id;

    element.classList.toggle('is-selected', Boolean(selected));
    element.setAttribute('aria-label', selected ? 'Selected direct-line endpoint' : 'Use as direct-line endpoint');
    element.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();

      if (!this.directAnchor) this.selectDirectAnchor(anchor);
      else this.commitDirectLine(anchor.coordinate, anchor);
    });

    return new this.options.Marker({ element, anchor: 'center' })
      .setLngLat(anchor.coordinate as [number, number])
      .addTo(this.options.map);
  }

  private createRangeMarker(section: TrackBuilderSection, selection: DeleteSelection, boundary: 'start' | 'end', action: 'delete' | 'snap'): maplibregl.Marker {
    const sourceCoordinates = section.sourceCoordinates ?? section.coordinates;
    const position = selection[boundary];
    const initialCoordinate = interpolateLine(sourceCoordinates, position);
    const element = this.options.container.createDiv();

    element.className = `places-track-builder-handle is-${action} is-${action}-${boundary}`;
    element.setAttribute('aria-label', `Drag ${boundary} of portion to ${action}`);
    const marker = new this.options.Marker({ element, draggable: true, anchor: 'center' })
      .setLngLat(initialCoordinate as [number, number])
      .addTo(this.options.map);
    let projectedSource: TrackBuilderSelectionPoint[] = [];
    let projectedOffsets: number[] = [];
    let previousDragPoint = this.options.map.project(initialCoordinate as [number, number]);
    let previousSnapPosition = position;
    let draggedSnapRanges: TrackBuilderRange[] = [];

    marker.on('dragstart', () => {
      if (action === 'snap') {
        const snapSelection = selection as SnapSelection;

        projectedSource = sourceCoordinates.map(coordinate => {
          const point = this.options.map.project(coordinate as [number, number]);

          return [point.x, point.y] as TrackBuilderSelectionPoint;
        });
        projectedOffsets = [0];

        for (let index = 1; index < projectedSource.length; index++) {
          const previous = projectedSource[index - 1];
          const current = projectedSource[index];

          projectedOffsets.push(projectedOffsets[index - 1] + Math.hypot(current[0] - previous[0], current[1] - previous[1]));
        }

        previousDragPoint = this.options.map.project(marker.getLngLat());
        previousSnapPosition = selection[boundary];
        draggedSnapRanges = snapSelection.ranges.map(range => ({ ...range }));
        this.updateSnapSelectionDisplay('Release the boundary to update the preview.');
      }

      logger.scope('TrackBuilder').debug(`${action} boundary drag started`, {
        draftKey: this.key,
        boundary,
        sectionId: section.id,
        position: selection[boundary],
      });
    });
    marker.on('drag', () => {
      const stillSelected = action === 'delete'
        ? this.deleteSelections.includes(selection)
        : this.snapSelection === selection;

      if (!stillSelected) return;
      const pointer = this.options.map.project(marker.getLngLat());

      if (action === 'delete') {
        const projected = this.positionOnLine(pointer, sourceCoordinates, selection[boundary]);
        const clamped = this.clampPositionToSection(projected, section);

        selection[boundary] = clamped;
        marker.setLngLat(interpolateLine(sourceCoordinates, clamped) as [number, number]);
        this.updateDeletePreview();

        return;
      }

      const snapSelection = selection as SnapSelection;
      const distance = Math.hypot(pointer.x - previousDragPoint.x, pointer.y - previousDragPoint.y);
      const sampleCount = Math.max(1, Math.ceil(distance / 4));
      let sampleStart: TrackBuilderSelectionPoint = [previousDragPoint.x, previousDragPoint.y];

      for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex++) {
        const fraction = sampleIndex / sampleCount;
        const sample: TrackBuilderSelectionPoint = [
          previousDragPoint.x + (pointer.x - previousDragPoint.x) * fraction,
          previousDragPoint.y + (pointer.y - previousDragPoint.y) * fraction,
        ];
        const projected = closestTrackBuilderLinePosition(sample, projectedSource, previousSnapPosition);
        const clamped = this.clampPositionToSection(projected, section);
        const sourceArcPixels = Math.abs(this.projectedPositionOffset(projectedSource, projectedOffsets, clamped)
          - this.projectedPositionOffset(projectedSource, projectedOffsets, previousSnapPosition));
        const previousScreen = this.projectedPositionPoint(projectedSource, previousSnapPosition);
        const currentScreen = this.projectedPositionPoint(projectedSource, clamped);
        const directScreenPixels = Math.hypot(currentScreen[0] - previousScreen[0], currentScreen[1] - previousScreen[1]);
        const pointerStepPixels = Math.hypot(sample[0] - sampleStart[0], sample[1] - sampleStart[1]);

        if (shouldSplitTrackBuilderGesture(sourceArcPixels, directScreenPixels, pointerStepPixels)) {
          const range = { start: clamped, end: clamped };

          if (boundary === 'end') draggedSnapRanges.push(range);
          else draggedSnapRanges.unshift(range);
        } else {
          const activeRange = boundary === 'end'
            ? draggedSnapRanges[draggedSnapRanges.length - 1]
            : draggedSnapRanges[0];

          if (activeRange) activeRange[boundary] = clamped;
        }

        previousSnapPosition = clamped;
        sampleStart = sample;
      }

      selection[boundary] = previousSnapPosition;
      snapSelection.ranges = draggedSnapRanges;
      previousDragPoint = pointer;
      marker.setLngLat(interpolateLine(sourceCoordinates, previousSnapPosition) as [number, number]);
      this.updateSnapSelectionDisplay('Release the boundary to update the preview.');
    });
    marker.on('dragend', () => {
      const stillSelected = action === 'delete'
        ? this.deleteSelections.includes(selection)
        : this.snapSelection === selection;

      if (!stillSelected) return;
      if (action === 'snap') this.normalizeSnapSelection(section, selection as SnapSelection);
      logger.scope('TrackBuilder').debug(`${action} boundary adjusted`, {
        draftKey: this.key,
        boundary,
        sectionId: section.id,
        selection,
      });

      if (action === 'delete') this.updateDeletePreview();
      else this.updateSnapPreview();
    });

    return marker;
  }

  private projectedPositionOffset(points: readonly TrackBuilderSelectionPoint[], offsets: readonly number[], position: TrackBuilderLinePosition): number {
    const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
    const a = points[index];
    const b = points[index + 1];

    return offsets[index] + Math.hypot(b[0] - a[0], b[1] - a[1]) * position.t;
  }

  private projectedPositionPoint(points: readonly TrackBuilderSelectionPoint[], position: TrackBuilderLinePosition): TrackBuilderSelectionPoint {
    const index = Math.max(0, Math.min(points.length - 2, position.segmentIndex));
    const a = points[index];
    const b = points[index + 1];

    return [a[0] + (b[0] - a[0]) * position.t, a[1] + (b[1] - a[1]) * position.t];
  }

  private createEndpointMarker(section: TrackBuilderSection, endpoint: 'start' | 'end'): maplibregl.Marker {
    const element = this.options.container.createDiv();

    element.className = `places-track-builder-handle is-${endpoint}`;
    element.setAttribute('aria-label', `Drag ${endpoint} of selected section`);
    const initialCoordinate = endpoint === 'start'
      ? section.startCoordinateOverride ?? interpolateLine(section.sourceCoordinates!, section.startPosition!)
      : section.endCoordinateOverride ?? interpolateLine(section.sourceCoordinates!, section.endPosition!);
    const marker = new this.options.Marker({ element, draggable: true, anchor: 'center' })
      .setLngLat(initialCoordinate as [number, number])
      .addTo(this.options.map);
    let preview = section;
    let trace: DragTraceRun[] = [];
    let lastTraceCoordinate: TrackBuilderCoordinate | undefined;
    let lastRejectedTransition = '';
    let lastEquivalentSourceCandidate = '';
    let previousDragPoint = this.options.map.project(initialCoordinate as [number, number]);
    let dragCandidateIndex: SnapCandidateIndex | undefined;
    let canceled = false;

    marker.on('dragstart', () => {
      canceled = false;
      trace = [];
      lastTraceCoordinate = undefined;
      lastRejectedTransition = '';
      lastEquivalentSourceCandidate = '';
      previousDragPoint = this.options.map.project(initialCoordinate as [number, number]);
      dragCandidateIndex = this.visibleCandidateIndex(10);
      logger.scope('TrackBuilder').debug('endpoint drag started', {
        draftKey: this.key,
        endpoint,
        coordinate: initialCoordinate,
        section: sectionLogData(section),
        indexedCandidates: dragCandidateIndex.candidates.length,
      });

      this.cancelActiveDrag = () => {
        canceled = true;
        trace = [];
        marker.setLngLat(initialCoordinate as [number, number]);
        this.setSourceData(HOVER_SOURCE, []);
        this.setSourceData(DRAFT_SOURCE, getTrackBuilderHistory(this.key).draft.sections);
        this.status.setText('Drag canceled');
        logger.scope('TrackBuilder').debug('endpoint drag canceled', { draftKey: this.key, endpoint, sectionId: section.id });
      };
    });
    marker.on('drag', () => {
      if (canceled) return;
      const rawLngLat = marker.getLngLat();
      const rawCoordinate: TrackBuilderCoordinate = [rawLngLat.lng, rawLngLat.lat];
      const dragPoint = this.options.map.project(rawLngLat);
      const distance = Math.hypot(dragPoint.x - previousDragPoint.x, dragPoint.y - previousDragPoint.y);
      const sampleCount = Math.max(1, Math.min(100, Math.ceil(distance / 3)));
      let returnedToSource: TrackBuilderLinePosition | undefined;

      for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex++) {
        const fraction = sampleIndex / sampleCount;
        const samplePoint = {
          x: previousDragPoint.x + (dragPoint.x - previousDragPoint.x) * fraction,
          y: previousDragPoint.y + (dragPoint.y - previousDragPoint.y) * fraction,
        } as maplibregl.Point;
        const candidate = this.findCandidateAt(samplePoint, trace[trace.length - 1]?.candidate, 8, dragCandidateIndex);

        if (candidate) {
          const candidateCoordinates = candidate.sourceCoordinates ?? candidate.coordinates;
          const candidatePosition = this.positionOnLine(samplePoint, candidateCoordinates);
          const candidateCoordinate = interpolateLine(candidateCoordinates, candidatePosition);
          const sourceConnection = this.coordinateLineConnection(candidateCoordinate, section.sourceCoordinates!);
          const matchingIdentity = this.isSectionSource(candidate, section);

          if (shouldTrimEndpointToCurrentSource(
            matchingIdentity,
            sourceConnection.screenDistancePixels,
            sourceConnection.geographicDistanceMeters,
            CONTIGUOUS_MAX_SCREEN_DISTANCE_PIXELS,
            CONTIGUOUS_MAX_GEOGRAPHIC_DISTANCE_METERS,
          )) {
            returnedToSource = sourceConnection.position;
            trace = [];
            lastTraceCoordinate = undefined;
            lastRejectedTransition = '';

            if (!matchingIdentity && lastEquivalentSourceCandidate !== candidate.id) {
              lastEquivalentSourceCandidate = candidate.id;
              logger.scope('TrackBuilder').debug('endpoint drag matched equivalent source geometry', {
                draftKey: this.key,
                endpoint,
                sourceSectionId: section.id,
                sourceFeatureKey: section.sourceFeatureKey,
                candidateFeatureKey: candidate.id,
                ...sourceConnection,
              });
            }

            continue;
          }
        }

        const tracing = trace.length > 0 || Boolean(candidate);

        if (!candidate || !tracing) continue;
        returnedToSource = undefined;
        let position = this.positionOnLine(samplePoint, candidate.sourceCoordinates ?? candidate.coordinates);
        const last = trace[trace.length - 1];

        if (last?.candidate.id === candidate.id) {
          last.end = position;
          lastTraceCoordinate = interpolateLine(candidate.sourceCoordinates ?? candidate.coordinates, position);
        } else {
          const candidateCoordinates = candidate.sourceCoordinates ?? candidate.coordinates;
          const resolution = last
            ? this.resolveSectionConnection(last.candidate, candidate)
            : this.resolveSectionAnchorConnection(initialCoordinate, section, candidate);
          const connection = 'connection' in resolution ? resolution.connection : resolution;

          if (!resolution.connected) {
            const transition = `${last?.candidate.id ?? section.id}:${candidate.id}`;

            if (transition !== lastRejectedTransition) {
              lastRejectedTransition = transition;
              logger.scope('TrackBuilder').debug('drag candidate rejected as disconnected', {
                draftKey: this.key,
                endpoint,
                from: last?.candidate.id ?? section.id,
                to: candidate.id,
                ...connection,
              });
            }

            continue;
          }

          if (resolution.clusteredJunction) {
            position = 'connection' in resolution ? resolution.connection.b : resolution.position;
          }

          lastRejectedTransition = '';
          trace.push({ candidate, start: position, end: position });
          lastTraceCoordinate = interpolateLine(candidateCoordinates, position);
          const sampledPointer = this.options.map.unproject(samplePoint);

          logger.scope('TrackBuilder').debug('drag entered feature', {
            draftKey: this.key,
            endpoint,
            rawPointer: rawCoordinate,
            sampledPointer: [sampledPointer.lng, sampledPointer.lat],
            projectedCoordinate: lastTraceCoordinate,
            position,
            candidate: sectionLogData(candidate),
            pointerDistancePixels: this.candidateDistances.get(candidate.id),
            traceIndex: trace.length - 1,
            clusteredJunction: resolution.clusteredJunction,
          });
        }
      }

      previousDragPoint = dragPoint;

      if (returnedToSource) {
        preview = this.endpointPreview(section, endpoint, returnedToSource);
        const sections = getTrackBuilderHistory(this.key).draft.sections.map(current => current.id === section.id ? preview : current);

        this.setSourceData(DRAFT_SOURCE, sections);
        marker.setLngLat((endpoint === 'start' ? preview.coordinates[0] : preview.coordinates[preview.coordinates.length - 1]) as [number, number]);
        this.setSourceData(HOVER_SOURCE, []);

        return;
      }

      if (trace.length > 0 && lastTraceCoordinate) {
        marker.setLngLat(lastTraceCoordinate as [number, number]);
        this.setSourceData(HOVER_SOURCE, this.buildTraceSections(trace, section, endpoint));

        return;
      }

      const position = this.positionOnLine(this.options.map.project(marker.getLngLat()), section.sourceCoordinates!);

      preview = this.endpointPreview(section, endpoint, position);
      const sections = getTrackBuilderHistory(this.key).draft.sections.map(current => current.id === section.id ? preview : current);

      this.setSourceData(DRAFT_SOURCE, sections);
      marker.setLngLat((endpoint === 'start' ? preview.coordinates[0] : preview.coordinates[preview.coordinates.length - 1]) as [number, number]);
    });
    marker.on('dragend', () => {
      this.cancelActiveDrag = undefined;
      dragCandidateIndex = undefined;
      this.setSourceData(HOVER_SOURCE, []);

      if (canceled) {
        this.setSourceData(DRAFT_SOURCE, getTrackBuilderHistory(this.key).draft.sections);
      } else if (trace.length > 0) {
        const added = this.buildTraceSections(trace, section, endpoint, true);

        logger.scope('TrackBuilder').debug('endpoint drag committed', {
          draftKey: this.key,
          endpoint,
          sourceSectionId: section.id,
          trace: trace.map(run => ({ candidate: sectionLogData(run.candidate), start: run.start, end: run.end })),
          committedSections: added.map(sectionLogData),
        });

        if (endpoint === 'end') appendTrackBuilderSections(this.key, added);
        else prependTrackBuilderSections(this.key, added);
      } else {
        logger.scope('TrackBuilder').debug('endpoint adjusted on source feature', {
          draftKey: this.key,
          endpoint,
          before: sectionLogData(section),
          after: sectionLogData(preview),
        });
        replaceTrackBuilderSection(this.key, preview);
      }

      this.render();
    });

    return marker;
  }

  private isSectionSource(candidate: TrackBuilderSection, section: TrackBuilderSection): boolean {
    if (candidate.id === section.sourceFeatureKey) return true;

    return candidate.featureId !== undefined
      && section.featureId !== undefined
      && candidate.featureId === section.featureId
      && candidate.sourceLayer === section.sourceLayer;
  }

  private endpointPreview(section: TrackBuilderSection, endpoint: 'start' | 'end', position: TrackBuilderLinePosition): TrackBuilderSection {
    const coordinates = endpoint === 'start'
      ? sliceLine(section.sourceCoordinates!, position, section.endPosition!)
      : sliceLine(section.sourceCoordinates!, section.startPosition!, position);
    const snap = this.findEndpointSnap(endpoint === 'start' ? coordinates[0] : coordinates[coordinates.length - 1], section.id);

    if (snap) coordinates[endpoint === 'start' ? 0 : coordinates.length - 1] = snap;

    return endpoint === 'start'
      ? { ...section, startPosition: position, startCoordinateOverride: snap, coordinates }
      : { ...section, endPosition: position, endCoordinateOverride: snap, coordinates };
  }

  private buildTraceSections(
    trace: readonly DragTraceRun[],
    section: TrackBuilderSection,
    endpoint: 'start' | 'end',
    logResolution = false,
    sourceAnchorOverride?: TrackBuilderCoordinate,
    allowDetachedSourceAnchor = false,
    preserveRunBounds = false,
  ): TrackBuilderSection[] {
    const isConnected = (left: TrackBuilderSection, right: TrackBuilderSection): boolean =>
      this.resolveSectionConnection(left, right).connected;
    const repairedTrace = expandRepeatedFeatureBacktracks(trace, candidate => candidate.id, isConnected);
    const contiguousTrace = connectedTracePrefix(repairedTrace.runs, isConnected);
    let resolvedTrace = contiguousTrace.runs;
    const sampledTrace = resolvedTrace.map(run => ({ start: run.start, end: run.end }));

    if (logResolution) {
      for (const inferred of repairedTrace.inferred) logger.scope('TrackBuilder').debug('trace backtrack inferred', {
        draftKey: this.key,
        endpoint,
        repeatedFeatureKey: inferred.repeatedKey,
        insertedFeatureKeys: inferred.insertedKeys,
      });

      if (contiguousTrace.rejected) logger.scope('TrackBuilder').debug('trace truncated at disconnected transition', {
        draftKey: this.key,
        endpoint,
        traceIndex: contiguousTrace.rejected.index,
        from: contiguousTrace.rejected.from.id,
        to: contiguousTrace.rejected.to.id,
      });
    }

    const sourceAnchor = sourceAnchorOverride
      ?? (endpoint === 'end' ? section.coordinates[section.coordinates.length - 1] : section.coordinates[0]);
    const first = resolvedTrace[0];

    if (first && !preserveRunBounds) {
      const firstCoordinates = first.candidate.sourceCoordinates ?? first.candidate.coordinates;
      const exactAnchorConnection = this.coordinateLineConnection(sourceAnchor, firstCoordinates);
      const anchorResolution = this.resolveSectionAnchorConnection(sourceAnchor, section, first.candidate);
      const anchorPosition = anchorResolution.position;
      const sameSourceFeature = first.candidate.featureId === section.featureId && first.candidate.sourceLayer === section.sourceLayer;

      if (sameSourceFeature) first.start = exactAnchorConnection.position;
      else if (anchorResolution.connected) first.start = anchorPosition;
      else if (!allowDetachedSourceAnchor) {
        if (logResolution) logger.scope('TrackBuilder').debug('trace rejected at disconnected source anchor', {
          draftKey: this.key,
          endpoint,
          sourceSectionId: section.id,
          firstFeatureKey: first.candidate.id,
          ...anchorResolution,
        });

        resolvedTrace = [];
      } else if (logResolution) {
        logger.scope('TrackBuilder').debug('map snap retained feature position away from GPX source anchor', {
          draftKey: this.key,
          endpoint,
          sourceSectionId: section.id,
          firstFeatureKey: first.candidate.id,
          ...anchorResolution,
        });
      }
    }

    for (let index = 1; !preserveRunBounds && index < resolvedTrace.length; index++) {
      const previous = resolvedTrace[index - 1];
      const current = resolvedTrace[index];
      const resolution = this.resolveSectionConnection(previous.candidate, current.candidate);
      const connection = resolution.connection;

      if (resolution.connected) {
        previous.end = connection.a;
        current.start = connection.b;
      }

      if (logResolution) logger.scope('TrackBuilder').debug('trace feature junction resolved', {
        draftKey: this.key,
        from: previous.candidate.id,
        to: current.candidate.id,
        ...connection,
        applied: resolution.connected,
        clusteredJunction: resolution.clusteredJunction,
      });
    }

    if (!preserveRunBounds) resolvedTrace = resolvedTrace.flatMap((run, index) => {
      const coordinates = run.candidate.sourceCoordinates ?? run.candidate.coordinates;
      const distance = (a: TrackBuilderLinePosition, b: TrackBuilderLinePosition): number => {
        const aPoint = this.options.map.project(interpolateLine(coordinates, a) as [number, number]);
        const bPoint = this.options.map.project(interpolateLine(coordinates, b) as [number, number]);

        return Math.hypot(aPoint.x - bPoint.x, aPoint.y - bPoint.y);
      };

      return resolveCenterBasedTraceRun(
        { ...run, start: sampledTrace[index].start, end: sampledTrace[index].end },
        run.start,
        run.end,
        distance,
      );
    });

    const outward: TrackBuilderSection[] = [];
    let anchor = sourceAnchor;

    for (const run of resolvedTrace) {
      let added = this.sectionBetween(run.candidate, run.start, run.end);

      if (coordinateDistanceSquared(anchor, added.coordinates[0]) > coordinateDistanceSquared(anchor, added.coordinates[added.coordinates.length - 1])) added = reverseTrackBuilderSection(added);
      const coordinates = [...added.coordinates];
      const startPoint = this.options.map.project(coordinates[0] as [number, number]);
      const anchorPoint = this.options.map.project(anchor as [number, number]);
      const shouldSnap = Math.hypot(startPoint.x - anchorPoint.x, startPoint.y - anchorPoint.y) <= 14
        && DistanceCalculator.haversineDistanceMeters(coordinates[0][1], coordinates[0][0], anchor[1], anchor[0]) <= 5;

      if (logResolution) {
        logger.scope('TrackBuilder').debug('trace run resolved', {
          draftKey: this.key,
          endpoint,
          sourceFeatureKey: run.candidate.id,
          runStart: run.start,
          runEnd: run.end,
          orientedStart: coordinates[0],
          orientedEnd: coordinates[coordinates.length - 1],
          anchor,
          screenDistancePixels: Math.hypot(startPoint.x - anchorPoint.x, startPoint.y - anchorPoint.y),
          geographicDistanceMeters: DistanceCalculator.haversineDistanceMeters(coordinates[0][1], coordinates[0][0], anchor[1], anchor[0]),
          snapped: shouldSnap,
        });
      }

      if (shouldSnap) coordinates[0] = anchor;
      added = { ...added, coordinates, startCoordinateOverride: shouldSnap ? anchor : undefined };
      outward.push(added);
      anchor = coordinates[coordinates.length - 1];
    }

    if (endpoint === 'end') return outward;

    return outward.reverse().map(added => reverseTrackBuilderSection(added));
  }

  private findEndpointSnap(coordinate: TrackBuilderCoordinate, excludedSectionId: string): TrackBuilderCoordinate | undefined {
    const point = this.options.map.project(coordinate as [number, number]);
    let best: { coordinate: TrackBuilderCoordinate; distance: number } | undefined;

    for (const section of getTrackBuilderHistory(this.key).draft.sections) {
      if (section.id === excludedSectionId || section.coordinates.length === 0) continue;
      const endpoints = [section.coordinates[0], section.coordinates[section.coordinates.length - 1]];

      for (const candidate of endpoints) {
        const projected = this.options.map.project(candidate as [number, number]);
        const distance = Math.hypot(point.x - projected.x, point.y - projected.y);

        if (distance <= 14 && DistanceCalculator.haversineDistanceMeters(coordinate[1], coordinate[0], candidate[1], candidate[0]) <= 5 && (!best || distance < best.distance)) {
          best = { coordinate: candidate, distance };
        }
      }
    }

    return best?.coordinate;
  }

  private clearHandleMarkers(): void {
    this.handleMarkers.forEach(marker => marker.remove());
    this.handleMarkers = [];
  }

  // Waypoints stay visible in every mode but only become interactive in
  // waypoint mode - otherwise they would swallow the map clicks the other
  // modes rely on.
  private renderWaypointMarkers(waypoints: readonly TrackBuilderWaypoint[]): void {
    this.clearWaypointMarkers();

    for (const waypoint of waypoints) {
      this.waypointMarkers.push({ id: waypoint.id, marker: this.createWaypointMarker(waypoint) });
    }
  }

  private clearWaypointMarkers(): void {
    this.waypointMarkers.forEach(entry => entry.marker.remove());
    this.waypointMarkers = [];
  }

  // Selection-only update. Selecting must not go through render(): that
  // recreates every marker element, and destroying the one under the pointer
  // mid-gesture means the browser never delivers the double-click that opens
  // the editor.
  private refreshWaypointSelectionDisplay(): void {
    for (const entry of this.waypointMarkers) {
      entry.marker.getElement().classList.toggle('is-selected', entry.id === this.selectedWaypointId);
    }

    if (this.waypointActions) this.waypointActions.hidden = !this.waypointing || !this.selectedWaypointId;
    const selected = this.selectedWaypoint();

    this.status.setText(selected
      ? `Waypoint · ${selected.name ?? 'unnamed'}`
      : `Waypoints · ${trackBuilderWaypoints(getTrackBuilderHistory(this.key).draft).length} placed`);
  }

  private createWaypointMarker(waypoint: TrackBuilderWaypoint): maplibregl.Marker {
    const element = this.options.container.createDiv();

    element.className = 'places-track-builder-waypoint-marker';
    element.classList.toggle('is-selected', this.selectedWaypointId === waypoint.id);
    element.classList.toggle('is-interactive', this.waypointing);
    element.setText(resolveWaypointIcon(waypoint) ?? '📍');
    const label = waypoint.name ?? 'Unnamed waypoint';

    element.setAttribute('aria-label', label);
    element.setAttribute('title', waypoint.description ? `${label} - ${waypoint.description}` : label);

    if (this.waypointing) {
      element.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedWaypointId = this.selectedWaypointId === waypoint.id ? undefined : waypoint.id;
        this.refreshWaypointSelectionDisplay();
      });
      element.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedWaypointId = waypoint.id;
        this.editSelectedWaypoint();
      });
    }

    const marker = new this.options.Marker({ element, draggable: this.waypointing, anchor: 'center' })
      .setLngLat(waypoint.coordinate as [number, number])
      .addTo(this.options.map);

    let canceled = false;

    marker.on('dragstart', () => {
      canceled = false;
      this.selectedWaypointId = waypoint.id;

      this.cancelActiveDrag = () => {
        canceled = true;
        marker.setLngLat(waypoint.coordinate as [number, number]);
        this.status.setText('Drag canceled');
      };
    });
    marker.on('dragend', () => {
      this.cancelActiveDrag = undefined;
      if (canceled) return;
      const lngLat = marker.getLngLat();

      updateTrackBuilderWaypoint(this.key, { ...waypoint, coordinate: [lngLat.lng, lngLat.lat] });
      logger.scope('TrackBuilder').debug('waypoint moved', {
        draftKey: this.key,
        waypointId: waypoint.id,
        from: waypoint.coordinate,
        to: [lngLat.lng, lngLat.lat],
      });
      this.render();
    });

    return marker;
  }

  private setSourceData(sourceId: string, sections: readonly TrackBuilderSection[], action?: 'delete' | 'snap' | 'new-piece'): void {
    const source = this.options.map.getSource<maplibregl.GeoJSONSource>(sourceId);

    void source?.setData({
      type: 'FeatureCollection',
      features: sections.map(section => ({
        type: 'Feature',
        properties: {
          id: section.id,
          action,
          routingMode: section.layerId === 'track-builder-direct' ? 'direct' : 'mapped',
        },
        geometry: { type: 'LineString', coordinates: section.coordinates as [number, number][] },
      })),
    });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;

    if (this.mode === 'idle'
      || target?.instanceOf(HTMLInputElement)
      || target?.instanceOf(HTMLTextAreaElement)
      || target?.instanceOf(HTMLSelectElement)) return;

    if (event.key === 'Escape' && this.cancelActiveDrag) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelActiveDrag();

      return;
    }

    const modifier = event.metaKey || event.ctrlKey;

    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();

      if (event.shiftKey) redoTrackBuilderEdit(this.key);
      else undoTrackBuilderEdit(this.key);

      this.render();
    } else if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault(); redoTrackBuilderEdit(this.key); this.render();
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();

      if (this.deleting && this.deleteSelections.length > 0) this.applyDeleteSelection();
      else if (this.snapping && this.snapSelection) this.clearSnapSelection();
      else if (this.waypointing && this.selectedWaypointId) this.deleteSelectedWaypoint();
      else if (!this.waypointing) { removeLastTrackBuilderSection(this.key); this.render(); }
    } else if (event.key === 'Escape') {
      if (this.deleting && this.deleteSelections.length > 0) this.clearDeleteSelection();
      else if (this.waypointing && this.selectedWaypointId) { this.selectedWaypointId = undefined; this.render(); }
      else if (this.snapping && this.snapSelection) this.clearSnapSelection();
      else if (this.direct && this.directAnchor) {
        this.directAnchor = undefined;
        this.setSourceData(DIRECT_PREVIEW_SOURCE, []);
        this.render();
      } else this.setMode('idle');
    }
  }

  private async exportGpx(): Promise<void> {
    const draft = getTrackBuilderHistory(this.key).draft;

    if (draft.sections.length === 0) return;
    const name = this.options.config.name ?? this.importedName ?? this.options.config.id ?? 'Places track';
    // One sanitizer: the GPX export and the track note derive the same stem
    // from one name.
    const filename = `${Utilities.sanitizeFilename(name) || 'places-track'}.gpx`;

    logger.scope('TrackBuilder').debug('GPX export requested', {
      draftKey: this.key,
      configuredName: this.options.config.name,
      configuredId: this.options.config.id,
      resolvedName: name,
      filename,
      sections: draft.sections.map(sectionLogData),
      segments: trackBuilderSegments(draft),
    });

    await downloadOrCopy({ app: this.options.app, content: serializeTrackBuilderGpx(draft, name), filename, mimeType: 'application/gpx+xml', vaultFallbackFolder: PLACES_EXPORTS_FOLDER });
  }

  private async createTrackNote(): Promise<void> {
    const host = this.options.placeNoteHost;
    const draft = getTrackBuilderHistory(this.key).draft;

    if (!host || draft.sections.length === 0) return;
    const name = this.options.config.name ?? this.importedName ?? this.options.config.id ?? 'Places track';
    const segments = trackBuilderSegments(draft);
    const firstCoordinate = segments[0]?.[0];

    await host.createNote({
      kind: 'track', name, sourcePath: this.options.source.path,
      gpx: serializeTrackBuilderGpx(draft, name),
      metrics: {
        distanceKm: km(segments.reduce((total, segment) => total + DistanceCalculator.calculatePolylineDistanceKm(segment.map(coordinateFromPosition)), 0)),
        startCoordinate: firstCoordinate ? coordinateFromPosition(firstCoordinate) : undefined,
        totalPoints: segments.reduce((total, segment) => total + segment.length, 0),
        name, featureCount: segments.length,
      },
    });
  }

  private async loadConfiguredTracks(trackSettings: readonly string[]): Promise<void> {
    try {
      const loader = this.options.trackLoader;

      if (!loader) throw new Error('The standard Places track loader is unavailable.');
      const statePath = JSON.stringify(trackSettings.map(value => value.trim()));
      const prior = configuredTrackStates().get(this.key);

      this.importedName = prior?.path === statePath ? prior.name : undefined;
      if (prior?.path === statePath) return;

      const tracks: TrackData[] = [];

      for (const trackSetting of trackSettings) {
        // TrackBuilder edits and re-exports the recording, and prefers the original
        // Overlay Source over a geometry-only Overlay Cache. The latter omits
        // timestamps and would silently discard recording data.
        tracks.push(await loader.loadTrackFromPath(trackSetting, this.options.source.path ?? '', { skipCache: true }));
      }

      if (this.destroyed) return;
      const sections = tracks.flatMap((track, trackIndex) =>
        trackDataToTrackBuilderSections(track).map((section, sectionIndex) => ({
          ...section,
          id: `imported-${trackIndex}-${sectionIndex}`,
          breakBefore: trackIndex > 0 || section.breakBefore,
        }))
      );
      // One undoable edit: a single undo restores the pre-load draft.
      const loadedWaypoints = tracks.flatMap((track, trackIndex) =>
        trackDataToTrackBuilderWaypoints(track).map(waypoint => ({ ...waypoint, id: `${waypoint.id}:${trackIndex}` })));

      // A GPX of marks with no recorded line is a valid starting point. Only a
      // load that produced neither geometry nor waypoints is an error.
      if (sections.length === 0 && loadedWaypoints.length === 0) {
        throw new Error('The track has no segment with at least two points, and no waypoints.');
      }

      replaceTrackBuilderContent(this.key, sections, loadedWaypoints);
      this.importedName = tracks.length === 1
        ? tracks[0].metadata.name ?? configuredTrackName(trackSettings[0])
        : undefined;
      configuredTrackStates().set(this.key, { path: statePath, name: this.importedName });
      this.fitLoadedContent(sections, loadedWaypoints);
      this.render();
      logger.scope('TrackBuilder').debug('configured track loaded for editing', {
        draftKey: this.key,
        trackSettings,
        importedName: this.importedName,
        sections: sections.map(sectionLogSummary),
      });
    } catch (error) {
      const message = getErrorMessage(error);

      if (!this.destroyed) {
        this.status.setText('Track failed to load');
        this.status.setAttribute('title', message);
      }

      logger.scope('TrackBuilder').error('configured tracks load failed', { draftKey: this.key, trackSettings, error: message });
    }
  }

  // Frame what was loaded, which for a waypoint-only file is the waypoints.
  private fitLoadedContent(sections: readonly TrackBuilderSection[], waypoints: readonly TrackBuilderWaypoint[]): void {
    if (sections.length > 0) {
      this.fitSections(sections);

      return;
    }

    this.fitCoordinates(waypoints.map(waypoint => waypoint.coordinate));
  }

  private fitSections(sections: readonly TrackBuilderSection[]): void {
    this.fitCoordinates(sections.flatMap(section => section.coordinates));
  }

  private fitCoordinates(coordinates: readonly TrackBuilderCoordinate[]): void {
    if (coordinates.length === 0) return;
    let west = coordinates[0][0];
    let east = west;
    let south = coordinates[0][1];
    let north = south;

    for (const [longitude, latitude] of coordinates.slice(1)) {
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }

    this.options.runProgrammaticCamera(() => {
      this.options.map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 16, animate: false });
    });
  }
}

function configuredTrackName(trackSetting: string): string {
  const unquoted = trackSetting.trim().replace(/^(["'])(.*)\1$/, '$2');
  const link = unquoted.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/)?.[1] ?? unquoted;
  const basename = link.split('/').pop() ?? link;

  return basename.replace(/\.(?:md|gpx|csv|geojson|json)$/i, '') || 'Places track';
}
