import type * as maplibregl from 'maplibre-gl';
import type { App } from 'obsidian';
import type { MapToolFactory, TrackBuilderConfig } from 'places-shared/settings';
import type { UnitsSystem } from 'places-shared/units';
import { TrackBuilderController } from './TrackBuilderController';

// `units` comes from the host's settings rather than the map config: the track
// note this tool writes carries the same formatted metrics as every other track
// note, and those are display values.
export function createTrackBuilderMapTool(units: UnitsSystem): MapToolFactory {
  return {
    id: 'trackbuilder',
    engine: 'maplibre',
    suppressEmptyMapHelp: true,
    validateToolConfig(toolConfig) {
      if (toolConfig === false) return;
      parseTrackBuilderToolConfig(toolConfig);
    },
    attach(options) {
      if (options.toolConfig === false) return undefined;
      const config = parseTrackBuilderToolConfig(options.toolConfig);
      const controller = new TrackBuilderController({
        app: options.app as App,
        map: options.map as maplibregl.Map,
        Marker: options.engineApi.Marker as typeof maplibregl.Marker,
        container: options.container,
        source: options.source,
        config,
        units,
        trackLoader: options.trackLoader,
      });
      controller.setup();
      return controller;
    },
  };
}

export function parseTrackBuilderToolConfig(value: unknown): TrackBuilderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tools.trackbuilder must be a mapping.');
  }
  const entry = value as Record<string, unknown>;
  const known = new Set(['id', 'name', 'tracks', 'snapRadiusMeters', 'respectGradeSeparation', 'selectableLayers']);
  const unknown = Object.keys(entry).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`tools.trackbuilder contains unknown ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}.`);
  const text = (key: string): string | undefined => {
    const setting = entry[key];
    if (setting === undefined) return undefined;
    if (typeof setting !== 'string' || !setting.trim()) throw new Error(`tools.trackbuilder.${key} must be text.`);
    return setting.trim();
  };
  const list = (key: string, fallback: readonly string[]): readonly string[] => {
    const setting = entry[key];
    if (setting === undefined) return fallback;
    if (!Array.isArray(setting) || !setting.every(item => typeof item === 'string')) throw new Error(`tools.trackbuilder.${key} must be a list of text values.`);
    return setting.map(item => item.trim()).filter(Boolean);
  };
  const snapRadiusMeters = entry.snapRadiusMeters;
  if (snapRadiusMeters !== undefined && (typeof snapRadiusMeters !== 'number' || !Number.isFinite(snapRadiusMeters) || snapRadiusMeters <= 0)) {
    throw new Error('tools.trackbuilder.snapRadiusMeters must be greater than 0.');
  }
  const respectGradeSeparation = entry.respectGradeSeparation;
  if (respectGradeSeparation !== undefined && typeof respectGradeSeparation !== 'boolean') {
    throw new Error('tools.trackbuilder.respectGradeSeparation must be true or false.');
  }
  return {
    id: text('id'),
    name: text('name'),
    tracks: list('tracks', []),
    snapRadiusMeters,
    respectGradeSeparation: respectGradeSeparation ?? false,
    selectableLayers: list('selectableLayers', ['transportation']),
  };
}
