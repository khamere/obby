import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { withBoldNick } from "../../../src/components/message/EventMessage";

describe("withBoldNick", () => {
  it("shows the new nick bold without the asterisks", () => {
    const { container } = render(
      <span>{withBoldNick("is now known as **imperialized**")}</span>,
    );
    expect(container.textContent).toBe("is now known as imperialized");
    expect(container.querySelector("strong")?.textContent).toBe("imperialized");
  });

  it("keeps the marker's place in a translated sentence", () => {
    const { container } = render(
      <span>{withBoldNick("は現在 **neko** として知られています")}</span>,
    );
    expect(container.textContent).toBe("は現在 neko として知られています");
    expect(container.querySelector("strong")?.textContent).toBe("neko");
  });

  it("leaves text without markers as it is", () => {
    const { container } = render(<span>{withBoldNick("changed nick")}</span>);
    expect(container.textContent).toBe("changed nick");
    expect(container.querySelector("strong")).toBeNull();
  });
});
