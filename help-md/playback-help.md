---
id: playback-help
title: Route playback
---

# Route playback

Playback moves a position marker along the route while a camera follows behind.

## Basic Usage

~~~places
height: 500px
mapProvider: openfreemap
pitch: true
terrain:
  provider: aws
tools:
  playback:
    track: "[[Lake Scranton Weekend Run]]"
    duration: 60s
    loop: true
    camera: follow
    pitch: 65
    zoom: 16
    lookAhead: 40
    cameraSmoothing: 0.35
~~~

## Settings

| Setting         | Description                                                                                                                         | Examples                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| track           | Track note or file to play. Omitted, clicking a rendered trail selects it.                                                          | `[[Lake Scranton Weekend Run]]`      |
| duration        | Time for one complete playback. Complete track-point timestamps preserve relative pace within this duration.                        | **60s**, 45s, 2m                     |
| loop            | Restart at the beginning after reaching the end.                                                                                    | true, **false**                      |
| autoplay        | Start when the map is ready.                                                                                                        | true, **false**                      |
| camera          | `follow` moves and rotates the camera; `none` moves only the position marker.                                                       | **follow**, none                     |
| pitch           | Follow-camera pitch from 0 to 85 degrees.                                                                                           | **60**, 45                           |
| zoom            | Fixed follow-camera zoom from 0 to 24. Defaults to the current zoom.                                                                | 14, 16                               |
| lookAhead       | Metres ahead used to calculate a smoother route bearing.                                                                            | **40**, 100                          |
| cameraSmoothing | Follow-camera damping in seconds. Higher values are smoother but lag farther behind; 0 disables.                                    | **0.35**, 0                          |
| showPosition    | Show the moving position marker.                                                                                                    | **true**, false                      |
| showRoute       | Draw the playback route even when the map query does not include its note.                                                          | **true**, false                      |
| draggable       | Drag the playback position marker to scrub through the route.                                                                       | **true**, false                      |
| showProgress    | Highlight the completed portion of the route.                                                                                       | **true**, false                      |
