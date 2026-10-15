// <moniker-name address="bafyrei…"> for any page: the account's photo, name
// and @handle, linked to its Moniker page. Register it once with a Moniker
// from createMoniker:
//
//   defineMonikerName(moniker);
//   <moniker-name address="bafyrei…"></moniker-name>
//   <moniker-name address="bafyrei…" size="24" plain></moniker-name>   (no link)
//
// Style it from outside with CSS custom properties: --moniker-ink,
// --moniker-muted, --moniker-accent, --moniker-avatar (the photo's backdrop).
// Names in a feed share one read of the chain.

const style = `
  :host { display: inline-flex; align-items: center; gap: 0.5em; font: inherit; color: var(--moniker-ink, inherit); min-width: 0; }
  a { display: inline-flex; align-items: center; gap: 0.5em; color: inherit; text-decoration: none; min-width: 0; }
  a:hover .name { text-decoration: underline; }
  .photo { flex: none; border-radius: 50%; object-fit: cover; background: var(--moniker-avatar, #cfd6ef); display: inline-flex; align-items: center; justify-content: center; font-weight: 600; color: var(--moniker-muted, #4a4f5a); overflow: hidden; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .handle { color: var(--moniker-accent, #1f3fbf); font-family: ui-monospace, monospace; font-size: 0.9em; white-space: nowrap; }
`;

export function defineMonikerName(moniker, tag = "moniker-name") {
  if (customElements.get(tag)) return;

  // One read for every element drawn together: addresses gathered in a tick.
  let waiting = new Map(); // address → [resolve]
  let scheduled = false;
  function profileOf(address) {
    return new Promise((resolve) => {
      waiting.set(address, [...(waiting.get(address) ?? []), resolve]);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const batch = waiting;
        waiting = new Map();
        scheduled = false;
        const addresses = [...batch.keys()];
        const found = await moniker.profiles(addresses).catch(() => addresses.map((a) => ({ address: a })));
        addresses.forEach((a, i) => batch.get(a).forEach((done) => done(found[i])));
      });
    });
  }

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["address", "size", "plain"];
      #drawn = 0;
      constructor() {
        super();
        this.attachShadow({ mode: "open" });
      }
      connectedCallback() {
        this.#draw();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.#draw();
      }
      async #draw() {
        const ticket = ++this.#drawn;
        const address = this.getAttribute("address") ?? "";
        const size = Number(this.getAttribute("size")) || 28;
        const root = this.shadowRoot;
        root.replaceChildren(Object.assign(document.createElement("style"), { textContent: style }));
        if (!moniker.chain || !address) return;
        const p = await profileOf(address);
        if (ticket !== this.#drawn) return;

        const outer = this.hasAttribute("plain")
          ? document.createElement("span")
          : Object.assign(document.createElement("a"), { href: moniker.pageURL(address), target: "_blank", rel: "noopener" });
        const photo = document.createElement("span");
        photo.className = "photo";
        photo.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
        photo.textContent = (p.name?.trim()?.[0] ?? p.handle?.[0] ?? "?").toUpperCase();
        photo.setAttribute("aria-hidden", "true");
        const name = Object.assign(document.createElement("span"), { className: "name", textContent: moniker.label(p) });
        outer.append(photo, name);
        if (p.handle && p.name) outer.append(Object.assign(document.createElement("span"), { className: "handle", textContent: `@${p.handle}` }));
        root.append(outer);

        const url = await moniker.photo(p.avatar);
        if (url && ticket === this.#drawn) {
          const img = Object.assign(document.createElement("img"), { className: "photo", src: url, alt: "" });
          img.style.cssText = `width:${size}px;height:${size}px`;
          photo.replaceWith(img);
        }
      }
    },
  );
}
