import { App, Modal, Setting } from 'obsidian';
import type { TrackBuilderWaypoint } from 'places-utilities/core';

export interface TrackBuilderWaypointEdit {
  readonly name?: string;
  readonly symbol?: string;
  readonly description?: string;
}

export class TrackBuilderWaypointModal extends Modal {
  private name: string;
  private symbol: string;
  private description: string;

  constructor(app: App, waypoint: TrackBuilderWaypoint, private readonly onSubmit: (edit: TrackBuilderWaypointEdit) => void, private readonly onDelete: () => void) {
    super(app);
    this.name = waypoint.name ?? '';
    this.symbol = waypoint.symbol ?? '';
    this.description = waypoint.description ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h1', { text: 'Edit waypoint' });

    new Setting(contentEl)
      .setName('Name')
      .setDesc('Shown as the marker label.')
      .addText(text => {
        text.setValue(this.name).onChange(value => { this.name = value; });
        text.inputEl.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl)
      .setName('Symbol')
      .setDesc('Waypoint symbol value. Emoji render directly; named values use the waypoint icon mapping.')
      .addText(text => text.setValue(this.symbol).onChange(value => { this.symbol = value; }));

    new Setting(contentEl)
      .setName('Description')
      .setDesc('Optional detail, shown when the waypoint marker is clicked.')
      .addTextArea(text => text.setValue(this.description).onChange(value => { this.description = value; }));

    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Delete waypoint')
        .setDestructive()
        .onClick(() => {
          this.close();
          this.onDelete();
        }))
      .addButton(button => button
        .setButtonText('Save')
        .setCta()
        .onClick(() => this.submit()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    this.close();
    this.onSubmit({
      name: this.name.trim() || undefined,
      symbol: this.symbol.trim() || undefined,
      description: this.description.trim() || undefined,
    });
  }
}
