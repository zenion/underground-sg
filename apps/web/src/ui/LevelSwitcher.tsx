// The level switcher: one button per band, top to bottom, the current one pressed. It sits in the
// map's bottom-right control stack, in reach of a right thumb.

import type { Band } from "../data/bands.ts";

export interface LevelSwitcherProps {
  readonly bands: readonly Band[];
  readonly band: number;
  readonly onChange: (ordinal: number) => void;
}

export function LevelSwitcher({ bands, band, onChange }: LevelSwitcherProps) {
  return (
    <fieldset className="level-switcher">
      <legend className="visually-hidden">Level</legend>
      {bands.map((item) => (
        <button
          key={item.ordinal}
          type="button"
          aria-pressed={item.ordinal === band}
          aria-label={`${item.label}: ${item.description}`}
          title={item.description}
          onClick={() => {
            onChange(item.ordinal);
          }}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
