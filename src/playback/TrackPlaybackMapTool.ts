import type * as maplibregl from 'maplibre-gl';
import type { App } from 'obsidian';
import type { MapToolFactory } from "places-shared/settings";
import { getErrorMessage, logger } from "places-shared/utils";
import { TrackPlaybackController, parseTrackPlaybackConfig, type TrackPlaybackConfig, type TrackPlaybackControllerOptions } from './TrackPlaybackController';

export const trackPlaybackMapTool: MapToolFactory = {
  id: 'playback',
  engine: 'maplibre',
  suppressEmptyMapHelp: true,
  async contributePlaces(options) {
    const config = parseTrackPlaybackConfig(options.toolConfig);

    if (!config.track) return [];
    if (!config.showRoute) return [];

    if (!options.source.path || !options.trackLoader.loadTrackPlaceFromPath) {
      throw new Error('The standard Places track-note loader is unavailable.');
    }

    const place = await options.trackLoader.loadTrackPlaceFromPath(config.track, options.source.path);

    if (!place) {
      throw new Error('Playback route styling requires a Markdown track note with Location and Overlay Source.');
    }

    return [place];
  },
  attach(options) {
    if (options.toolConfig === undefined || options.toolConfig === false) return undefined;
    if (!options.trackLoader || !options.source.path) return undefined;

    let config: TrackPlaybackConfig;

    try {
      config = parseTrackPlaybackConfig(options.toolConfig);
    } catch (error) {
      const message = getErrorMessage(error);

      logger.scope('Playback').error('Playback configuration failed', error, {
        sourcePath: options.source.path,
      });
      const element = options.container.createDiv({ cls: 'places-track-playback-error', text: `Route playback: ${message}` });

      return { destroy: () => element.remove() };
    }

    const controller = new TrackPlaybackController({
      app: options.app as App,
      map: options.map as maplibregl.Map,
      runProgrammaticCamera: move => options.engineApi.runProgrammaticCamera(move),
      getPlacePositionHandle: placeId => options.engineApi.getPlacePositionHandle(placeId),
      getSelectableTracks: () => options.engineApi.getSelectableTracks(),
      Marker: options.engineApi.Marker as TrackPlaybackControllerOptions['Marker'],
      onTrackSelected: handler => options.engineApi.onTrackSelected(handler),
      container: options.container,
      sourcePath: options.source.path,
      trackLoader: options.trackLoader,
      config,
      allowPitch: options.config.pitch || Boolean(options.config.terrainProvider),
    });

    void controller.setup();

    return {
      update({ config: mapConfig, toolConfig }) {
        try {
          return controller.updateConfig(
            parseTrackPlaybackConfig(toolConfig),
            mapConfig.pitch || Boolean(mapConfig.terrainProvider),
          );
        } catch {
          return false;
        }
      },
      destroy: () => controller.destroy(),
    };
  },
};
