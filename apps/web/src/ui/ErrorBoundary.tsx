// The last resort: an exception anywhere in the page (a render, or an effect that throws) shows a
// message with a Reload button instead of the blank page React leaves when it unmounts the root.
// Expected failures have their own messages (StateMessage); this catches the rest.

import { Component, type ReactNode } from "react";
import { crashMessage } from "../data/messages.ts";
import { StateMessage } from "./StateMessage.tsx";

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
  readonly error: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, error };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app">
        <header className="top">
          <div className="card info">
            <h1>Underground SG</h1>
          </div>
        </header>
        <StateMessage message={crashMessage(this.state.error)} />
      </div>
    );
  }
}
