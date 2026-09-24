import { useId, type ReactNode } from "react";
import type { ThemeApi, ThemeChoice } from "./useTheme";

const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; icon: ReactNode }> = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="3.1" />
        <g strokeLinecap="round">
          <path d="M8 1v1.9M8 13.1V15M1 8h1.9M13.1 8H15M3 3l1.35 1.35M11.65 11.65 13 13M13 3l-1.35 1.35M4.35 11.65 3 13" />
        </g>
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.7 5.7 0 1 0 7.1 7.1Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    value: "system",
    label: "Auto",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1.6" y="2.6" width="12.8" height="8.6" rx="1.4" />
        <path d="M5.4 13.6h5.2" strokeLinecap="round" />
      </svg>
    ),
  },
];

interface Props {
  theme: ThemeApi;
}

/**
 * Native radios: the browser gives us roving tabindex, arrow-key movement and
 * the correct announcement for free. The segmented look is purely CSS.
 */
export function ThemeToggle({ theme }: Props) {
  const name = useId();

  return (
    <fieldset className="theme-toggle">
      <legend className="visually-hidden">Colour theme</legend>
      <span className="theme-toggle-label" aria-hidden="true">
        Theme
      </span>
      <div className="theme-toggle-track">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={theme.choice === option.value ? "theme-option is-active" : "theme-option"}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={theme.choice === option.value}
              onChange={() => theme.setChoice(option.value)}
            />
            <span className="theme-option-inner">
              {option.icon}
              <span>{option.label}</span>
            </span>
          </label>
        ))}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {`${theme.choice === "system" ? "Automatic" : theme.choice === "dark" ? "Dark" : "Light"} theme active (currently ${theme.resolved}).`}
      </span>
    </fieldset>
  );
}
