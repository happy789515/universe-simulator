export class LabelLayer {
  readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "label-layer";
    parent.appendChild(this.root);
  }

  create(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "body-label";
    el.textContent = text;
    this.root.appendChild(el);
    return el;
  }

  place(
    el: HTMLDivElement,
    x: number,
    y: number,
    opacity: number,
    selected: boolean,
  ): void {
    el.classList.toggle("is-selected", selected);
    el.style.opacity = opacity.toFixed(3);
    el.style.transform = `translate(10px, -70%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}
