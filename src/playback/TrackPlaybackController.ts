import type * as maplibregl from 'maplibre-gl';
import { setIcon, setTooltip, type App } from 'obsidian';
import type { MapToolAttachment, MapToolPositionHandle, MapTrackLoader } from "places-shared/settings";
import { indexTrackSegments, nearestProgress, playbackDistanceAtProgress, playbackLabel, playbackPositionAt, hasUsablePlaybackTimestamps, smoothCameraPosition, PlaybackProgressGeometry, type IndexedPoint, type PlaybackPosition, type SmoothedCameraPosition } from 'places-utilities/core';
import { getPlaceId } from "places-shared/track";
import { TRACK_PLAYBACK_POSITION_EVENT, TRACK_POINT_HOVER_EVENT, TRACK_POSITION_REQUEST_EVENT } from "places-shared/map";
import { getErrorMessage, logger } from "places-shared/utils";

export interface TrackPlaybackConfig {
  track?: string;
  durationSeconds: number;
  loop: boolean;
  autoplay: boolean;
  camera: 'follow' | 'none';
  pitch: number;
  zoom?: number;
  lookAheadMeters: number;
  cameraSmoothingSeconds: number;
  showPosition: boolean;
  showRoute: boolean;
  draggable: boolean;
  showProgress: boolean;
}

function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tools.playback must be a mapping.');
  }

  return value as Record<string, unknown>;
}

function durationSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;

  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec(?:ond)?s?|m|min(?:ute)?s?)$/i);

    if (match) {
      const amount = Number(match[1]);

      return /^m(?!s)|^min/i.test(match[2]) ? amount * 60 : match[2].toLowerCase() === 'ms' ? amount / 1000 : amount;
    }
  }

  throw new Error('tools.playback.duration must be a positive number of seconds or a duration such as 45s or 2m.');
}

function numberInRange(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = record[key];

  if (value === undefined) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`tools.playback.${key} must be between ${min} and ${max}.`);
  }

  return value;
}

export function parseTrackPlaybackConfig(value: unknown): TrackPlaybackConfig {
  const record = mapping(value);

  if (record.track !== undefined && (typeof record.track !== 'string' || !record.track.trim())) throw new Error('tools.playback.track must name a track note or file.');
  const camera = record.camera ?? 'follow';

  if (camera !== 'follow' && camera !== 'none') throw new Error('tools.playback.camera must be follow or none.');
  const zoom = record.zoom === undefined ? undefined : numberInRange(record, 'zoom', 16, 0, 24);

  return {
    track: typeof record.track === 'string' ? record.track.trim() : undefined,
    durationSeconds: durationSeconds(record.duration ?? '60s'),
    loop: record.loop === true,
    autoplay: record.autoplay === true,
    camera,
    pitch: numberInRange(record, 'pitch', 60, 0, 85),
    zoom,
    lookAheadMeters: numberInRange(record, 'lookAhead', 40, 0, 1000),
    cameraSmoothingSeconds: numberInRange(record, 'cameraSmoothing', 0.35, 0, 3),
    showPosition: record.showPosition !== false,
    showRoute: record.showRoute !== false,
    draggable: record.draggable !== false,
    showProgress: record.showProgress !== false,
  };
}

export function positionAndAddPlaybackMarker(marker: { setLngLat(coordinate: [number, number]): unknown; addTo(map: maplibregl.Map): unknown }, map: maplibregl.Map, coordinate: [number, number]): void {
  // MapLibre projects a marker immediately in addTo(): it must have a valid
  // coordinate before being attached to the map.
  marker.setLngLat(coordinate);
  marker.addTo(map);
}

// A short visual filter takes the edge off frame-time variation and sharp GPS
// vertices without making the playhead feel detached from the progress value.
const POSITION_SMOOTHING_SECONDS = 0.08;

export interface TrackPlaybackControllerOptions {
  app: App;
  map: maplibregl.Map;
  runProgrammaticCamera(move: () => void): void;
  getPlacePositionHandle(placeId: string): MapToolPositionHandle | undefined;
  getSelectableTracks?(): readonly { filePath?: string }[];
  container: HTMLElement;
  sourcePath: string;
  trackLoader: MapTrackLoader;
  config: TrackPlaybackConfig;
  // Whether this map surface permits a pitched camera (explicit pitch or terrain).
  allowPitch?: boolean;
  Marker?: new (options?: { draggable?: boolean; color?: string; element?: HTMLElement }) => {
    setLngLat(coordinate: [number, number]): unknown;
    addTo(map: maplibregl.Map): unknown;
    remove(): void;
    on(type: 'drag', handler: () => void): unknown;
    getLngLat(): { lng: number; lat: number };
  };
  onTrackSelected?(handler: (selection: { place: { filePath?: string }; coordinate?: { latitude: number; longitude: number } }) => void): () => void;
}

export class TrackPlaybackController implements MapToolAttachment {
  private points: IndexedPoint[] = [];
  private totalDistanceMeters = 0;
  private timestampAware = false;
  private progress = 0;
  private playing = false;
  private following: boolean;
  private allowPitch: boolean;
  private animationFrame: number | null = null;
  private startedAt = 0;
  private startedProgress = 0;
  private positionHandle?: MapToolPositionHandle;
  private positionMarker?: InstanceType<NonNullable<TrackPlaybackControllerOptions['Marker']>>;
  private removeTrackSelection?: () => void;
  private completedSourceId = 'places-playback-completed-source';
  private completedLayerId = 'places-playback-completed-layer';
  private completedOutlineLayerId = 'places-playback-completed-outline';
  private tailSourceId = 'places-playback-tail-source';
  private tailLayerId = 'places-playback-tail-layer';
  private tailOutlineLayerId = 'places-playback-tail-outline';
  private completedGeometry?: PlaybackProgressGeometry;
  private completedChunks = -1;
  private progressRouteChanged = false;
  private loadGeneration = 0;
  private loadController?: AbortController;
  private toolbar?: HTMLElement;
  private playButton?: HTMLButtonElement;
  private followButton?: HTMLButtonElement;
  private slider?: HTMLInputElement;
  private valueLabel?: HTMLElement;
  private errorElement?: HTMLElement;
  private destroyed = false;
  private movingCamera = false;
  private cameraPosition?: SmoothedCameraPosition;
  private displayedPosition?: SmoothedCameraPosition;
  private selectedPath?: string;
  private readonly accentColor: string;
  private readonly onChartHover = (event: Event) => {
    const detail = (event as CustomEvent<{ trackPath?: string; latitude?: number; longitude?: number }>).detail;

    if (!detail || detail.trackPath !== this.selectedPath || detail.latitude === undefined || detail.longitude === undefined) return;
    this.applyProgress(nearestProgress(this.points, detail.latitude, detail.longitude, this.totalDistanceMeters), false, true);
  };
  private readonly onPositionRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ latitude?: number; longitude?: number }>).detail;

    if (!detail || detail.latitude === undefined || detail.longitude === undefined || this.points.length === 0) return;
    this.applyProgress(nearestProgress(this.points, detail.latitude, detail.longitude, this.totalDistanceMeters), false, true);
  };
  private readonly onUserCamera = () => {
    if (!this.movingCamera && this.following) {
      this.following = false;
      this.updateFollowButton();
    }
  };

  constructor(private readonly options: TrackPlaybackControllerOptions) {
    this.following = options.config.camera === 'follow';
    this.allowPitch = options.allowPitch === true;
    this.accentColor = resolveCssColor(options.container, '--interactive-accent', '#2563eb');
  }

  async setup(): Promise<void> {
    this.renderControls();
    this.removeTrackSelection = this.options.onTrackSelected?.(selection => {
      if (selection.place.filePath) void this.loadTrack(selection.place.filePath, selection.coordinate);
    });
    this.options.container.ownerDocument.addEventListener(TRACK_POINT_HOVER_EVENT, this.onChartHover);
    this.options.container.addEventListener(TRACK_POSITION_REQUEST_EVENT, this.onPositionRequest);
    this.options.map.on('dragstart', this.onUserCamera);
    this.options.map.on('zoomstart', this.onUserCamera);
    this.options.map.on('rotatestart', this.onUserCamera);

    if (!this.options.config.track) {
      const tracks = this.options.getSelectableTracks?.() ?? [];

      if (tracks.length !== 1 || !tracks[0].filePath) {
        this.valueLabel?.setText('Select track');

        return;
      }

      await this.loadTrack(tracks[0].filePath);

      return;
    }

    await this.loadTrack(this.options.config.track);
  }

  private async loadTrack(path: string, selectedCoordinate?: { latitude: number; longitude: number }): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.loadGeneration;

    this.loadController?.abort();
    const controller = this.loadController = new AbortController();

    try {
      this.pause();
      this.errorElement?.remove();
      this.errorElement = undefined;
      this.valueLabel?.setText('Loading track...');
      const track = await this.options.trackLoader.loadTrackFromPath(path, this.options.sourcePath, { skipCache: true, signal: controller.signal });

      if (this.destroyed || generation !== this.loadGeneration) return;
      this.points = indexTrackSegments(track.segments?.length ? track.segments : [track.points]);
      this.selectedPath = path;
      this.totalDistanceMeters = this.points[this.points.length - 1]?.distanceMeters ?? 0;
      if (this.points.length < 2 || this.totalDistanceMeters <= 0) throw new Error('Playback track must contain at least two distinct points.');
      this.timestampAware = hasUsablePlaybackTimestamps(this.points);
      this.completedGeometry = this.options.config.showProgress ? new PlaybackProgressGeometry(this.points) : undefined;
      this.progressRouteChanged = true;
      this.completedChunks = -1;
      const initialProgress = selectedCoordinate
        ? nearestProgress(this.points, selectedCoordinate.latitude, selectedCoordinate.longitude, this.totalDistanceMeters)
        : 0;
      const initialPosition = playbackPositionAt(this.points, this.totalDistanceMeters, initialProgress, this.options.config.lookAheadMeters, this.timestampAware)!;

      this.positionMarker?.remove();
      this.positionMarker = undefined;
      this.positionHandle = undefined;

      if (this.options.config.showPosition) {
        const iconHandle = this.options.config.draggable ? undefined : await this.resolvePlaceIconHandle(path);

        if (this.destroyed || generation !== this.loadGeneration) return;

        if (iconHandle) {
          this.positionHandle = iconHandle;
          iconHandle.setLngLat([initialPosition.longitude, initialPosition.latitude]);
        } else if (this.options.Marker) {
          const markerElement = this.options.container.createDiv();

          markerElement.className = 'places-track-playback-position';
          markerElement.setAttribute('aria-label', 'Playback position');
          this.positionMarker = new this.options.Marker({ draggable: this.options.config.draggable, element: markerElement });
          positionAndAddPlaybackMarker(this.positionMarker, this.options.map, [initialPosition.longitude, initialPosition.latitude]);
          this.positionMarker.on('drag', () => {
            const coordinate = this.positionMarker!.getLngLat();

            this.pause();
            this.applyProgress(nearestProgress(this.points, coordinate.lat, coordinate.lng, this.totalDistanceMeters), false, true);
          });
        }
      }

      this.applyProgress(initialProgress, true, true);
      if (this.options.config.autoplay) this.play();
    } catch (error) {
      if (this.destroyed || generation !== this.loadGeneration) return;
      const message = getErrorMessage(error);

      logger.scope('Playback').error('Track playback failed', error, {
        track: path,
        sourcePath: this.options.sourcePath,
      });
      this.valueLabel?.setText('Track unavailable');
      this.errorElement?.remove();
      this.errorElement = this.options.container.createDiv({ cls: 'places-track-playback-error', text: `Route playback: ${message}` });
    }
  }

  // The position handle for the track note's own icon marker: a non-draggable
  // playhead moves the place's real icon instead of a generic dot. Undefined
  // when the note has no marker on this map (for example showRoute is off), and
  // the caller falls back to its own marker element.
  private async resolvePlaceIconHandle(path: string): Promise<MapToolPositionHandle | undefined> {
    const place = await this.options.trackLoader.loadTrackPlaceFromPath?.(path, this.options.sourcePath);

    return place ? this.options.getPlacePositionHandle(getPlaceId(place)) : undefined;
  }

  updateConfig(config: TrackPlaybackConfig, allowPitch = this.allowPitch): boolean {
    const previous = this.options.config;

    if (previous.track !== config.track
      || previous.showPosition !== config.showPosition
      || previous.showRoute !== config.showRoute
      || previous.draggable !== config.draggable
      || previous.showProgress !== config.showProgress) return false;

    const cameraModeChanged = previous.camera !== config.camera;

    this.options.config = config;
    this.allowPitch = allowPitch;

    if (this.playing) {
      this.startedAt = performance.now();
      this.startedProgress = this.progress;
    }

    if (cameraModeChanged) {
      this.following = config.camera === 'follow';
      this.updateFollowButton();
      if (this.following) this.applyProgress(this.progress, true, true);
    }

    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.loadController?.abort();
    this.loadController = undefined;
    this.pause();
    this.options.map.off('dragstart', this.onUserCamera);
    this.options.map.off('zoomstart', this.onUserCamera);
    this.options.map.off('rotatestart', this.onUserCamera);
    this.removeTrackSelection?.();
    this.options.container.ownerDocument.removeEventListener(TRACK_POINT_HOVER_EVENT, this.onChartHover);
    this.options.container.removeEventListener(TRACK_POSITION_REQUEST_EVENT, this.onPositionRequest);
    this.positionMarker?.remove();
    this.errorElement?.remove();

    for (const id of [this.completedLayerId, this.completedOutlineLayerId, this.tailLayerId, this.tailOutlineLayerId]) {
      if (this.options.map.getLayer(id)) this.options.map.removeLayer(id);
    }

    for (const id of [this.completedSourceId, this.tailSourceId]) {
      if (this.options.map.getSource(id)) this.options.map.removeSource(id);
    }

    this.completedGeometry = undefined;
    this.points = [];
    this.toolbar?.remove();
  }

  private renderControls(): void {
    if (this.toolbar) return;
    const toolbar = this.options.container.createDiv({ cls: 'places-track-playback-controls' });

    this.toolbar = toolbar;
    const play = toolbar.createEl('button', { cls: 'places-track-playback-button', attr: { type: 'button', 'aria-label': 'Play route' } });

    this.playButton = play;
    setIcon(play, 'play');
    setTooltip(play, 'Play route', { placement: 'top' });
    play.addEventListener('click', () => this.playing ? this.pause() : this.play());

    const slider = toolbar.createEl('input', {
      type: 'range',
      cls: 'places-track-playback-slider',
      attr: { min: '0', max: '1', step: '0.001', value: '0', 'aria-label': 'Route progress' },
    });

    this.slider = slider;
    slider.addEventListener('input', () => {
      this.pause();
      this.applyProgress(Number(slider.value), true, true);
    });
    this.valueLabel = toolbar.createSpan({ cls: 'places-track-playback-value', text: 'Select track' });

    const follow = toolbar.createEl('button', { cls: 'places-track-playback-button', attr: { type: 'button', 'aria-label': 'Follow route' } });

    this.followButton = follow;
    setIcon(follow, 'locate-fixed');
    setTooltip(follow, 'Follow route', { placement: 'top' });
    follow.addEventListener('click', () => {
      this.following = !this.following;
      this.updateFollowButton();
      if (this.following) this.applyProgress(this.progress, true, true);
    });
    this.updateFollowButton();
  }

  private play(): void {
    if (this.playing || this.destroyed || this.points.length < 2) return;
    if (this.progress >= 1) this.applyProgress(0, true, true);
    this.playing = true;
    this.startedAt = performance.now();
    this.startedProgress = this.progress;
    this.updatePlayButton();
    this.animationFrame = this.options.container.ownerDocument.defaultView?.requestAnimationFrame(time => this.tick(time)) ?? null;
  }

  private pause(): void {
    this.playing = false;
    const view = this.options.container.ownerDocument.defaultView;

    if (this.animationFrame !== null) view?.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.updatePlayButton();
  }

  private tick(time: number): void {
    if (!this.playing || this.destroyed) return;

    if (!this.options.container.isConnected || this.options.container.offsetParent === null) {
      this.pause();

      return;
    }

    const elapsed = (time - this.startedAt) / 1000;
    let next = this.startedProgress + elapsed / this.options.config.durationSeconds;
    let looped = false;

    if (next >= 1) {
      if (this.options.config.loop) {
        next %= 1;
        this.startedAt = time;
        this.startedProgress = next;
        looped = true;
      } else {
        this.applyProgress(1, true, false, time);
        this.pause();

        return;
      }
    }

    this.applyProgress(next, true, looped, time);
    this.animationFrame = this.options.container.ownerDocument.defaultView?.requestAnimationFrame(nextTime => this.tick(nextTime)) ?? null;
  }

  private applyProgress(progress: number, moveCamera: boolean, snapCamera = false, time = performance.now()): void {
    this.progress = Math.max(0, Math.min(1, progress));
    const position = playbackPositionAt(
      this.points,
      this.totalDistanceMeters,
      this.progress,
      this.options.config.lookAheadMeters,
      this.timestampAware,
    );

    if (!position) return;
    if (this.slider) this.slider.value = String(this.progress);
    this.valueLabel?.setText(playbackLabel(this.points, this.progress, this.timestampAware));

    if (this.selectedPath) this.options.container.dispatchEvent(new CustomEvent(TRACK_PLAYBACK_POSITION_EVENT, {
      detail: { trackPath: this.selectedPath, progress: this.progress, latitude: position.latitude, longitude: position.longitude },
      bubbles: true,
    }));

    const snapPosition = snapCamera || this.progress === 0 || this.progress === 1;

    this.displayedPosition = smoothCameraPosition(
      snapPosition ? undefined : this.displayedPosition,
      position,
      time,
      POSITION_SMOOTHING_SECONDS,
    );
    this.positionHandle?.setLngLat([this.displayedPosition.longitude, this.displayedPosition.latitude]);
    this.positionMarker?.setLngLat([this.displayedPosition.longitude, this.displayedPosition.latitude]);
    if (this.options.config.showProgress) this.updateCompletedRoute(position);

    if (moveCamera && this.following) {
      this.cameraPosition = smoothCameraPosition(
        snapCamera ? undefined : this.cameraPosition,
        position,
        time,
        this.options.config.cameraSmoothingSeconds,
      );
      this.movingCamera = true;
      this.options.runProgrammaticCamera(() => this.options.map.jumpTo({
        center: [this.cameraPosition!.longitude, this.cameraPosition!.latitude],
        bearing: this.cameraPosition!.bearing,
        pitch: this.allowPitch ? this.options.config.pitch : 0,
        ...(this.options.config.zoom !== undefined ? { zoom: this.options.config.zoom } : {}),
      }));
      this.movingCamera = false;
    }
  }

  private updateCompletedRoute(position: PlaybackPosition): void {
    if (!this.completedGeometry) return;
    const completedDistance = this.timestampAware
      ? playbackDistanceAtProgress(this.points, this.totalDistanceMeters, this.progress, true)
      : this.totalDistanceMeters * this.progress;
    const { completedChunks, tail } = this.completedGeometry.at(completedDistance, position);
    const filter: maplibregl.FilterSpecification = ['<', ['get', 'chunk'], completedChunks];
    const source = this.options.map.getSource<maplibregl.GeoJSONSource>(this.completedSourceId);

    if (!source) {
      this.options.map.addSource(this.completedSourceId, { type: 'geojson', data: this.completedGeometry.data });
      this.addProgressLayers(this.completedSourceId, this.completedLayerId, this.completedOutlineLayerId, filter);
    } else {
      if (this.progressRouteChanged) void source.setData(this.completedGeometry.data);

      if (this.completedChunks !== completedChunks) {
        this.options.map.setFilter(this.completedLayerId, filter);
        this.options.map.setFilter(this.completedOutlineLayerId, filter);
      }
    }

    this.completedChunks = completedChunks;
    this.progressRouteChanged = false;

    const tailSource = this.options.map.getSource<maplibregl.GeoJSONSource>(this.tailSourceId);

    if (tailSource) void tailSource.setData(tail);
    else {
      this.options.map.addSource(this.tailSourceId, { type: 'geojson', data: tail });
      this.addProgressLayers(this.tailSourceId, this.tailLayerId, this.tailOutlineLayerId);
    }
  }

  private addProgressLayers(source: string, lineId: string, outlineId: string, filter?: maplibregl.FilterSpecification): void {
    const firstSymbolLayer = this.options.map.getStyle().layers?.find(layer => layer.type === 'symbol')?.id;

    this.options.map.addLayer({ id: outlineId, type: 'line', source, ...(filter ? { filter } : {}), paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.33 } }, firstSymbolLayer);
    this.options.map.addLayer({ id: lineId, type: 'line', source, ...(filter ? { filter } : {}), paint: { 'line-color': this.accentColor, 'line-width': 5, 'line-opacity': 0.33 } }, firstSymbolLayer);
  }

  private updatePlayButton(): void {
    if (!this.playButton) return;
    setIcon(this.playButton, this.playing ? 'pause' : 'play');
    this.playButton.setAttribute('aria-label', this.playing ? 'Pause route' : 'Play route');
  }

  private updateFollowButton(): void {
    this.followButton?.classList.toggle('is-active', this.following);
  }
}

// Resolve theme variables (including nested var()/hsl() expressions) to a color MapLibre can parse.
export function resolveCssColor(container: HTMLElement, variable: string, fallback: string): string {
  const view = container.ownerDocument?.defaultView;

  if (!view || typeof container.createSpan !== 'function') return fallback;
  const probe = container.createSpan();

  probe.classList.add('places-track-playback-color-probe');
  probe.setCssProps({ color: `var(${variable})` });
  const resolved = view.getComputedStyle(probe).color.trim();

  probe.remove();

  return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback;
}
