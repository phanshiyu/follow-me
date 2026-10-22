const FLASH_MS = 1600;

/** Flashes an element once with a CSS animation class, restarting it if it is still running. */
export function flash(element: Element, name = "thread-flash"): void {
  element.classList.remove(name);
  // Reading a layout property restarts the animation when the class goes back on.
  void element.getBoundingClientRect();
  element.classList.add(name);
  setTimeout(() => element.classList.remove(name), FLASH_MS);
}

/** Scrolls a thread's card to the middle of the page and flashes it. False when it is not shown. */
export function jumpToThread(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`);
  if (card === null) return false;
  card.scrollIntoView({ block: "center" });
  flash(card);
  return true;
}
