import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BaseModal from "../../../src/lib/modal/BaseModal";

afterEach(cleanup);

describe("BaseModal with a dialog opened from inside it", () => {
  it("stays open when the inner dialog is pressed, and closes on its own scrim", () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(
      <BaseModal isOpen onClose={onCloseOuter} title="Outer">
        <p>outer body</p>
        <BaseModal isOpen onClose={onCloseInner} title="Inner">
          <p>inner body</p>
        </BaseModal>
      </BaseModal>,
    );
    fireEvent.mouseDown(screen.getByText("inner body"));
    expect(onCloseOuter).not.toHaveBeenCalled();
    expect(onCloseInner).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByText("outer body"));
    expect(onCloseOuter).not.toHaveBeenCalled();

    const outerDialog = screen.getByText("outer body").closest("[role=dialog]");
    const scrim = outerDialog?.querySelector(".scrim") as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).not.toHaveBeenCalled();
  });
});
