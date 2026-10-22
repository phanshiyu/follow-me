// Where Back returns after a jump to a definition. Pure.

/**
 * A reading position: the commit at the top of the viewport and how far its section has scrolled
 * under the header. Kept relative to the section, so commits opened by a jump above it do not
 * shift where Back lands.
 */
export type Spot = { readonly commit: number; readonly offset: number };

/** Where a jump left from: the reading position, and the commit whose code was clicked. */
export type Departure = { readonly spot: Spot; readonly from: number };

export type History = readonly Departure[];

/** Enough to retrace a chain of jumps; older spots fall off. */
export const HISTORY_LIMIT = 20;

export function pushDeparture(history: History, departure: Departure): History {
  return [...history, departure].slice(-HISTORY_LIMIT);
}

/** The spot to go back to and the history without it, or null when there is nowhere to go. */
export function popDeparture(history: History): { spot: Spot; rest: History } | null {
  const last = history.at(-1);
  return last === undefined ? null : { spot: last.spot, rest: history.slice(0, -1) };
}

/** "Back to commit 2", naming the commit the reviewer clicked in. */
export function backLabel(history: History): string | null {
  const last = history.at(-1);
  return last === undefined ? null : `Back to commit ${last.from + 1}`;
}
