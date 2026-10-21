import { sessionPrefix } from "./api.ts";

/** A set of strings kept in localStorage per session, for marks the server does not hold. */
export function loadSet(name: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`follow-me:${sessionPrefix}:${name}`) ?? "[]",
    );
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveSet(name: string, set: ReadonlySet<string>): void {
  localStorage.setItem(`follow-me:${sessionPrefix}:${name}`, JSON.stringify([...set]));
}
