export type AlbumTab = "graph" | "list" | "map";

export interface AlbumView {
  circleId?: string;
  navigationKey: string;
  deepLinkPerson: string | null;
  tab: AlbumTab;
  selected: string | null;
  anchor: HTMLElement | null;
}

type AlbumViewAction =
  | {
      type: "navigate";
      circleId?: string;
      navigationKey: string;
      person: string | null;
    }
  | { type: "tab"; tab: AlbumTab }
  | { type: "select"; id: string; anchor?: HTMLElement }
  | { type: "birthday"; id: string }
  | { type: "close" };

export function initialAlbumView(route: {
  circleId?: string;
  navigationKey: string;
  person: string | null;
}): AlbumView {
  return {
    circleId: route.circleId,
    navigationKey: route.navigationKey,
    deepLinkPerson: route.person,
    tab: "graph",
    selected: route.person || null,
    anchor: null,
  };
}

export function albumViewReducer(
  state: AlbumView,
  action: AlbumViewAction,
): AlbumView {
  switch (action.type) {
    case "navigate":
      // A deep link is consumed once for this route. Data reloads and closing
      // a card must not open it again; an explicit new destination may do so.
      return state.circleId === action.circleId &&
        state.navigationKey === action.navigationKey &&
        state.deepLinkPerson === action.person
        ? state
        : initialAlbumView(action);
    case "tab":
      return { ...state, tab: action.tab, selected: null, anchor: null };
    case "select": {
      const selected =
        action.id && state.selected !== action.id ? action.id : null;
      return {
        ...state,
        selected,
        anchor: selected ? action.anchor || null : null,
      };
    }
    case "birthday":
      // An explicit reminder click opens the full card; ordinary refreshes or
      // later tab switches must never recreate this selection.
      return { ...state, tab: "list", selected: action.id, anchor: null };
    case "close":
      return { ...state, selected: null, anchor: null };
  }
}
