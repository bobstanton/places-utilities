import { Plugin, setIcon, type App } from 'obsidian';
import type { IPlaceExtensionSettings, IPlacesExtensionHostSettings } from "places-shared/settings";
import type { IPlacePluginExtension, IPlacePluginExtensionExports, IPlacesHostServices } from "places-shared/services";
import { registerPlaceExtensionLifecycle, PLACES_EXTENSION_API_VERSION } from "places-shared/services";
import { configureRequestLogging } from "places-shared/utils";
import { ClassifyBlockProcessor } from './classify/ClassifyBlockProcessor';
import type { RenderContext } from './generated-help/index.generated';
import * as classifyHelp from './generated-help/classify-help.generated';
import * as trackbuilderHelp from './generated-help/trackbuilder-help.generated';
import * as playbackHelp from './generated-help/playback-help.generated';
import { ALL_CODE_BLOCK_DEFINITIONS, ALL_HIGHLIGHT_CONFIGS } from './CodeBlockDefinitions';
import { createTrackBuilderMapTool } from './track-builder/TrackBuilderMapTool';
import { trackPlaybackMapTool } from './playback/TrackPlaybackMapTool';
import "places-shared/error-styles.css";
import "places-shared/loading-styles.css";
import "./styles.css";
import "./generated-help/styles.generated.css";

export default class PlacesUtilitiesPlugin extends Plugin implements IPlacePluginExtension {
  // Held for help rendering: installed-provider lists resolve per render, not at export time.
  private host?: IPlacesHostServices;

  onload() {
    registerPlaceExtensionLifecycle(this);
  }

  getPlaceExports(app: App, _extensionSettings: IPlaceExtensionSettings, mainSettings: IPlacesExtensionHostSettings, host: IPlacesHostServices): IPlacePluginExtensionExports {
    configureRequestLogging(mainSettings.developerMode);
    this.host = host;
    const codeBlockProcessors: NonNullable<IPlacePluginExtensionExports['codeBlockProcessors']> = [
      {
        blockType: 'places-classify-help',
        processor: (_source: string, el: HTMLElement) => this.renderHelp(el, classifyHelp),
      },
      {
        blockType: 'places-trackbuilder-help',
        processor: (_source: string, el: HTMLElement) => this.renderHelp(el, trackbuilderHelp),
      },
      {
        blockType: 'places-playback-help',
        processor: (_source: string, el: HTMLElement) => this.renderHelp(el, playbackHelp),
      },
    ];

    const classifyProcessor = new ClassifyBlockProcessor(app, mainSettings, host);
    codeBlockProcessors.push({
      blockType: 'places-classify',
      processor: (source, el, ctx) => classifyProcessor.processCodeBlock(source, el, ctx),
    });
    return {
      apiVersion: PLACES_EXTENSION_API_VERSION,
      mapTools: [createTrackBuilderMapTool(mainSettings.units), trackPlaybackMapTool],
      codeBlockProcessors,
      codeBlockDefinitions: ALL_CODE_BLOCK_DEFINITIONS,
      highlightConfigs: ALL_HIGHLIGHT_CONFIGS
    };
  }

  private renderHelp(el: HTMLElement, page: { render(el: HTMLElement, context: RenderContext): void }): void {
    const context: RenderContext = {
      app: this.app,
      component: this,
      renderDynamic: (container, key) => this.renderDynamicHelp(container, key),
      setIcon: (element: HTMLElement, iconId: string) => setIcon(element, iconId),
    };
    page.render(el.createDiv({ cls: "places-help-container" }), context);
  }

  // Resolved when the help block renders rather than when exports are built: a
  // provider enabled after this plugin loaded still shows up. An unknown key
  // leaves its token visible, matching how the main plugin reports one.
  private renderDynamicHelp(container: HTMLElement, key: string): void {
    if (key === 'trackMatchProviderNames') {
      const names = [...(this.host?.trackMatch.getNames() ?? [])].sort((a, b) => a.localeCompare(b));
      container.createSpan({ text: names.length > 0 ? names.join(', ') : 'no track-match providers installed' });
      return;
    }
    container.createSpan({ text: `{{${key}}}` });
  }
}
