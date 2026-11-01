import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ExternalLinkWarningModal from "../../src/components/ui/ExternalLinkWarningModal";

// A click on a real link is never popup-blocked, unlike window.open from a
// handler, so on the web the confirm control is an anchor.
describe("ExternalLinkWarningModal", () => {
  it("opens the link through a real anchor and reports the confirm", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const onConfirm = vi.fn();
    render(
      <ExternalLinkWarningModal
        isOpen
        url="https://example.com/page"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /open link/i });
    expect(link.getAttribute("href")).toBe("https://example.com/page");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("never turns a non-web URL into a link", () => {
    const onConfirm = vi.fn();
    render(
      <ExternalLinkWarningModal
        isOpen
        url="javascript:alert(1)"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: /open link/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /open link/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
