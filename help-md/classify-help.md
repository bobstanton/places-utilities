---
id: classify-help
title: Places Classify Help
---

# Places Classify Help

Classify attempts to generate a descriptive name for a track ("Lake Scranton via Lake Scranton Trail") from the trails it follows and the map features near it.

## Basic Usage

~~~places-classify
track: [[Lake Scranton Weekend Run]]
~~~

Omit `track` to use the current note.

## Settings

| Setting         | Description                                                                                                                                                                            | Examples                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| track           | Wiki-link to the track file. Defaults to the current note                                                                                                                              | `[[Lake Scranton Weekend Run]]`                                                                                        |
| matchProvider   | Track match service used for trail and road names                                                                                                                                      | **valhalla**, {{dynamic:trackMatchProviderNames}}                                                                      |
| costing         | Travel profile for track matching                                                                                                                                                      | **pedestrian**, bicycle, auto                                                                                          |
| radius          | Corridor distance for nearby feature discovery. Uses configured units (meters/feet)                                                                                                    | **100**, 50, 200                                                                                                       |
| features        | Feature kinds considered as name candidates; omit for all                                                                                                                              | `water, island, peak` — from: peak, water, waterfall, viewpoint, park, campground, store, restaurant, landmark, island |
| height          | Height of the map                                                                                                                                                                      | **400px**, 300px, 500px                                                                                                |
| width           | Width of everything the block renders, its legend and info included. A percentage measures the note's width, vw the window's                                                           | **100%**, 50%, 800px                                                                                                   |
| mapProvider     | Which map provider to use                                                                                                                                                              | **default**, any installed map provider                                                                                |
| style           | Map style (provider-specific)                                                                                                                                                          | varies by provider                                                                                                     |
| showMap         | Show the track map with candidate markers                                                                                                                                              | **true**, false                                                                                                        |
| queryParameters | UI controls that adjust the block without editing it; `queryParametersPosition`, `queryParametersLayout`, and `queryParametersCollapsed` place them. See `places-queryparameters-help` | `- name: limit`                                                                                                        |

## What Each Result Comes From

1. **Route shape** is analyzed locally: loop, out and back, or point to point.
2. **Trails and roads** come from map-matching the whole track against OpenStreetMap via a track match provider, including how much of the track runs on each named way.
3. **Nearby features** (peaks, water, islands, viewpoints, parks, stores, ...) and **containing areas** (the lake, park, or island the track is *inside*) come from a single OpenStreetMap Overpass request combining a corridor query along the whole track with point-in-polygon (`is_in`) checks at the track's key points. Containment is detected from any point on a lake, not just near its label.
