import { CodeBlockDefinition, CodeBlockHighlightConfig } from "places-shared/obsidian/services";
import { QUERY_PARAMETER_NESTED_KEYS } from "places-shared/settings";

export const ALL_CODE_BLOCK_DEFINITIONS: CodeBlockDefinition[] = [
  {
    type: "places-playback-help",
    description: "Help for MapLibre route playback.",
    parameters: []
  },
  {
    type: "places-classify",
    description: "Suggest a name for a track from the trails it follows and the map features near it.",
    parameters: [
      { name: "track", description: "Track note or file to classify. Defaults to the current note.", values: "[[Lake Scranton Weekend Run]]" },
      { name: "matchProvider", description: "Track match service for trail/road names.", values: "**valhalla**, any installed track-match provider" },
      { name: "costing", description: "Travel profile for track matching", values: { choices: ["pedestrian", "bicycle", "auto"], default: "pedestrian" } },
      { name: "radius", description: "Corridor distance for nearby feature discovery (m/ft)", values: { examples: ["100", "50", "200"], default: "100" } },
      { name: "features", description: "Feature kinds considered as name candidates; omit for all.", values: { examples: ["peak", "water", "waterfall", "viewpoint", "park", "campground", "store", "restaurant", "landmark", "island"] } },
      { name: "height", values: "**400px**, 300px, 500px" },
      { name: "width", values: "**100%**, 800px" },
      { name: "mapProvider", values: "any installed map provider" },
      { name: "style", values: "varies by provider" },
      { name: "showMap", description: "Show the track map with candidate markers", values: { choices: ["true", "false"], default: "true" } }
    ]
  }
];

export const ALL_HIGHLIGHT_CONFIGS: CodeBlockHighlightConfig[] = [
  {
    blockType: 'places',
    validKeys: ['trackbuilder', 'playback', 'track', 'duration', 'loop', 'autoplay', 'camera', 'pitch', 'zoom', 'lookAhead', 'cameraSmoothing', 'showPosition', 'showRoute', 'draggable', 'showProgress'],
    rootKeys: [],
    knownValues: {
      loop: ['true', 'false'],
      autoplay: ['true', 'false'],
      camera: ['follow', 'none'],
      showPosition: ['true', 'false'],
      showRoute: ['true', 'false'],
    },
    nestedKeys: {
      tools: [
        { name: 'trackbuilder', description: 'Interactive MapLibre track editing' },
        { name: 'playback', description: 'MapLibre route playback and follow camera' },
      ],
      trackbuilder: [
        { name: 'id', description: 'Session identity for the draft' },
        { name: 'name', description: 'Track name and exported GPX filename' },
        { name: 'tracks', description: 'Track notes or files to load in order' },
        { name: 'snapRadiusMeters', description: "Initial snapping radius in meters" },
        { name: 'respectGradeSeparation', description: 'Keep bridges, tunnels, layers, and levels separate' },
        { name: 'selectableLayers', description: 'Rendered layer IDs or source-layer names that can be selected' },
      ],
      playback: [
        { name: 'track', description: 'Track note or file to play; omit to select a rendered track by clicking it' },
        { name: 'duration', description: 'Playback duration; complete point timestamps preserve relative pace' },
        { name: 'loop', description: 'Restart automatically at the end' },
        { name: 'autoplay', description: 'Begin playback when the map is ready' },
        { name: 'camera', description: "Follow the playback position or preserve the camera" },
        { name: 'pitch', description: 'Follow-camera pitch from 0 to 85 degrees' },
        { name: 'zoom', description: 'Optional fixed follow-camera zoom' },
        { name: 'lookAhead', description: 'Bearing look-ahead distance in meters' },
        { name: 'cameraSmoothing', description: 'Follow-camera damping in seconds (0 to 3)' },
        { name: 'showPosition', description: 'Show the moving route-position marker' },
        { name: 'showRoute', description: 'Draw the playback route on the map' },
        { name: 'draggable', description: 'Drag the position marker to scrub the route' },
        { name: 'showProgress', description: 'Highlight the completed portion of the route' },
      ],
    },
  },
  {
    blockType: 'places-playback-help',
    validKeys: []
  },
  {
    blockType: 'places-classify',
    validKeys: ['track', 'matchProvider', 'costing', 'radius', 'features', 'height', 'width', 'mapProvider', 'style', 'showMap', 'queryParameters'],
    knownValues: {
      type: ['string', 'enum'],
      control: ['text', 'combobox', 'dropdown', 'custom'],
    },
    nestedKeys: { queryParameters: QUERY_PARAMETER_NESTED_KEYS },
  }
];
