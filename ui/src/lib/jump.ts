const FLASH_MS = 1600;

/** Scrolls a thread's card to the middle of the page and flashes it. False when it is not shown. */
export function jumpToThread(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`);
  if (card === null) return false;
  card.scrollIntoView({ block: "center" });
  card.classList.remove("thread-flash");
  // Reading a layout property restarts the animation when the class goes back on.
  void card.offsetWidth;
  card.classList.add("thread-flash");
  setTimeout(() => card.classList.remove("thread-flash"), FLASH_MS);
  return true;
}
