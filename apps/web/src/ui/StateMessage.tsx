// The message card for a page with no map version to draw, or no map at all. The street map stays
// usable behind it when there is one.

import type { StateMessageText } from "../data/messages.ts";

export interface StateMessageProps {
  /** What to say, or undefined for no card. */
  readonly message: StateMessageText | undefined;
  /** "Try again" loads the files again; without it, and for "reload", the page reloads. */
  readonly onRetry?: () => void;
}

export function StateMessage({ message, onRetry }: StateMessageProps) {
  if (message === undefined) return null;
  return (
    <section
      className={`card state-card ${message.tone}`}
      role={message.tone === "error" ? "alert" : "status"}
      aria-labelledby="state-title"
    >
      <h2 id="state-title">{message.title}</h2>
      <p>{message.text}</p>
      {message.detail === undefined ? null : <p className="detail">{message.detail}</p>}
      <button
        type="button"
        className="primary"
        onClick={() => {
          if (message.action === "retry" && onRetry !== undefined) onRetry();
          else window.location.reload();
        }}
      >
        {message.action === "reload" ? "Reload" : "Try again"}
      </button>
    </section>
  );
}
