import { Trans } from "@lingui/react/macro";
import { Component, type ReactNode, useState } from "react";
import { useIsTouchInput } from "../hooks/useIsTouchInput";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "../lib/modal/components/Button";

type CopyStatus = "idle" | "copied" | "failed";

// A thrown value can be anything, and one that cannot be turned into text throws again when we try.
function textOf(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function describeError(error: unknown, componentStack?: unknown) {
  const summary =
    textOf(() => String(error)) ||
    textOf(() => Object.prototype.toString.call(error));
  const stack = textOf(() => (error as { stack?: unknown } | null)?.stack);
  // Some engines start the stack with the summary line and others leave it out.
  const trace = stack.includes(summary) ? stack : `${summary}\n${stack}`;
  return `${trace.trim()}${textOf(() => componentStack)}`;
}

const AppCrashScreen: React.FC<{ details: string }> = ({ details }) => {
  const isTouch = useIsTouchInput();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  // The button's own fixed height comes later in the stylesheet, so we raise the minimum for a finger.
  const buttonSize = isTouch ? "min-h-11" : "";

  const copyDetails = () => {
    copyToClipboard(details).then(
      (isCopied) => setCopyStatus(isCopied ? "copied" : "failed"),
      () => setCopyStatus("failed"),
    );
  };

  return (
    <div
      role="alert"
      className="h-full overflow-y-auto bg-discord-dark-300 text-discord-text-normal flex items-center justify-center p-4"
    >
      <div className="w-full max-w-xl flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-discord-text-strong">
          <Trans>Obby stopped working</Trans>
        </h1>
        <p className="text-sm">
          <Trans>
            Reload to continue. Copy the error details to report the problem.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className={buttonSize}
            onClick={() => window.location.reload()}
          >
            <Trans>Reload</Trans>
          </Button>
          <Button
            variant="secondary"
            className={buttonSize}
            onClick={copyDetails}
          >
            <Trans>Copy error details</Trans>
          </Button>
          <span role="status" className="text-sm text-discord-text-muted">
            {copyStatus === "copied" ? (
              <Trans>Copied</Trans>
            ) : copyStatus === "failed" ? (
              isTouch ? (
                <Trans>Copy failed, tap to retry</Trans>
              ) : (
                <Trans>Copy failed, select to retry</Trans>
              )
            ) : null}
          </span>
        </div>
        <pre
          data-testid="app-error-details"
          className="code-panel code-text p-3 max-h-64 overflow-auto select-text"
        >
          {details}
        </pre>
      </div>
    </div>
  );
};

// We reload only when asked, since an error that comes back on every start would otherwise reload forever.
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasFailed: boolean; details: string }
> {
  state = { hasFailed: false, details: "" };

  static getDerivedStateFromError(error: unknown) {
    return { hasFailed: true, details: describeError(error) };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    this.setState({ details: describeError(error, info.componentStack) });
  }

  render() {
    return this.state.hasFailed ? (
      <AppCrashScreen details={this.state.details} />
    ) : (
      this.props.children
    );
  }
}
