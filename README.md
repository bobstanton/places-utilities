# Places Utilities

Provider for [Places](https://community.obsidian.md/plugins/places), with track classification and naming, track building, and route playback.

This is not a stand-alone plugin, to use, install along side [Places](https://community.obsidian.md/plugins/places). Refer to the [sandbox](https://sandbox.obsidian.stanton.dev/places/) for examples.

## Network requests

| Area                     | Request                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Track classification     | Reads named OpenStreetMap features along and around a track |
| Track naming (way names) | Identifies the named ways a track follows                   |

Overpass requests go to `https://overpass-api.de/api/interpreter`, falling back to
`https://overpass.kumi.systems/api/interpreter`. Track matching uses whichever provider the block
selects, so its own requests are described by that provider's plugin.

## Background tasks

None.

## Dependencies

| Library                                                              | Purpose                                        |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| [maplibre-gl](https://github.com/maplibre/maplibre-gl-js)            | GL map engine for the track-building tool      |
| [@types/geojson](https://github.com/DefinitelyTyped/DefinitelyTyped) | GeoJSON type definitions                       |
| [places-shared](https://github.com/bobstanton/places-shared)         | Shared map, overlay, routing, and utility code |
