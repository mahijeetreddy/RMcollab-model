import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "rmcollab.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Mirrors the pre-paint bootstrap in index.html so React starts in agreement. */
function readStoredChoice(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isChoice(saved)) return saved;
  } catch {
    // Storage is unavailable (private mode); follow the system instead.
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  // With no stored choice and no system signal, light is the default.
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

export interface ThemeApi {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
}

export function useTheme(): ThemeApi {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredChoice()));

  // Keep the resolved theme in step with the OS while "system" is selected.
  useEffect(() => {
    if (choice !== "system") {
      setResolved(choice);
      return;
    }
    setResolved(systemTheme());
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = () => setResolved(systemTheme());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-theme-choice", choice);
    root.style.colorScheme = resolved;
  }, [choice, resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference cannot be persisted here; it still applies for this tab.
    }
  }, []);

  return { choice, resolved, setChoice };
}
