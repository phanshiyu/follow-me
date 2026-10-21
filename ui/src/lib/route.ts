import { useEffect, useState } from "react";
import { sessionPrefix } from "./api.ts";

export type Route = "review" | "report";

function routeOf(path: string): Route {
  return path.endsWith("/report") ? "report" : "review";
}

/** Moves between the review and the hand-off without reloading, so the event stream stays. */
export function navigate(route: Route): void {
  history.pushState(null, "", `${sessionPrefix}/${route === "report" ? "report" : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}
