---
id: trackbuilder-help
title: Places Track Builder Help
---

# Track builder

Add `tools.trackbuilder` to a `places` map to edit or create tracks.

## Basic Usage

~~~places
mapProvider: openfreemap
query: SELECT * FROM places WHERE path IN ({this.outgoingLinks})
tools:
  trackbuilder:
    tracks:
      - "[[Morning Run]]"
      - "Tracks/Connector.gpx"
      - "[[Evening Run]]"
    name: Weekend route
~~~

`tracks` is a YAML list of track-note wiki-links or vault file paths. Tracks are loaded in the order written.

## Settings

| Setting                | Description                                        | Examples                     |
| ---------------------- | -------------------------------------------------- | ---------------------------- |
| tracks                 | Ordered list of track notes or files               | `- [[Morning Run - Monday]]` |
| id                     | Session identity for the draft                     | commute-draft                |
| name                   | Exported GPX track name and filename               | Lake Loop                    |
| snapRadiusMeters       | Initial magnet distance in meters                  | 25                           |
| respectGradeSeparation | Keep bridges, tunnels, layers, and levels separate | true, **false**              |
| selectableLayers       | List of rendered layer or source-layer names       | transportation               |

