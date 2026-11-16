import { setIcon } from "obsidian";

export class ClassifyMapControls {
  private hoveredWay: string | null = null;
  private focusedWay: string | null = null;
  private pinnedWay: string | null = null;
  private mapOnly = false;
  private readonly chips = new Map<string, { element: HTMLElement; button: HTMLButtonElement }>();
  private readonly mapOnlyButton: HTMLButtonElement;

  constructor(container: HTMLElement, private readonly onChange: () => void) {
    this.mapOnlyButton = container.createEl("button", {
      cls: "places-classify-map-only",
      text: "Show map only",
      attr: { type: "button", "aria-pressed": "false" },
    });
    this.mapOnlyButton.addEventListener("click", () => {
      this.mapOnly = !this.mapOnly;
      this.changed();
    });
    this.sync();
  }

  get showMapOnly(): boolean { return this.mapOnly; }
  get inspectedWayId(): string | null {
    return this.mapOnly ? null : this.hoveredWay ?? this.focusedWay ?? this.pinnedWay;
  }

  resetChips(): void {
    const hadTransientPreview = this.hoveredWay !== null || this.focusedWay !== null;

    this.hoveredWay = null;
    this.focusedWay = null;
    this.chips.clear();
    if (hadTransientPreview) this.changed();
  }

  bindWay(element: HTMLElement, id: string, name: string): void {
    const button = element.createEl("button", {
      cls: "places-classify-inspect",
      attr: { type: "button", "aria-label": `Highlight ${name}`, "aria-pressed": "false" },
    });

    setIcon(button, "eye");
    this.chips.set(id, { element, button });
    element.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch") return;
      this.hoveredWay = id;
      this.changed();
    });
    element.addEventListener("pointerleave", () => {
      if (this.hoveredWay === id) this.hoveredWay = null;
      this.changed();
    });
    element.addEventListener("focusin", () => {
      this.focusedWay = id;
      this.changed();
    });
    element.addEventListener("focusout", event => {
      const ownerWindow = element.ownerDocument.defaultView;

      if (ownerWindow && event.relatedTarget instanceof ownerWindow.Node && element.contains(event.relatedTarget)) return;
      if (this.focusedWay === id) this.focusedWay = null;
      this.changed();
    });
    button.addEventListener("click", () => {
      this.pinnedWay = this.pinnedWay === id ? null : id;
      this.hoveredWay = null;
      this.focusedWay = null;
      this.changed();
    });
    element.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      this.pinnedWay = null;
      this.hoveredWay = null;
      this.focusedWay = null;
      this.changed();
    });
    this.sync();
  }

  private changed(): void {
    this.sync();
    this.onChange();
  }

  private sync(): void {
    this.mapOnlyButton.setAttribute("aria-pressed", String(this.mapOnly));
    this.mapOnlyButton.textContent = this.mapOnly ? "Show track & features" : "Show map only";

    for (const [id, chip] of this.chips) {
      chip.element.toggleClass("is-inspected", id === this.inspectedWayId);
      chip.button.setAttribute("aria-pressed", String(id === this.pinnedWay));
      chip.button.disabled = this.mapOnly;
    }
  }
}
