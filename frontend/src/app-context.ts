import { createContext, useContext } from "react";
import type { CircleView, User } from "./types";

export interface AppContextValue {
  user: User;
  circles: CircleView[];
  circlesLoading: boolean;
  circlesError: string;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  notify: (message: string) => void;
  confirmSensitive: (operation: () => Promise<unknown>) => Promise<boolean>;
}

// Keep the shared context outside components to avoid the App -> Manage -> App
// cycle and mismatched provider identities during Vite fast refresh.
export const AppContext = createContext<AppContextValue>(null!);
export const useApp = () => useContext(AppContext);
