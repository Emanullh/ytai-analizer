// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Tooltip from "./Tooltip";

afterEach(() => {
  cleanup();
});

describe("Tooltip", () => {
  it("renders with aria-describedby and tooltip role", () => {
    render(
      <Tooltip content="Definicion">
        <button type="button">Campo</button>
      </Tooltip>
    );

    const trigger = screen.getByRole("button", { name: "Campo" }).parentElement;
    expect(trigger).toHaveAttribute("aria-describedby");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Definicion");
  });

  it("shows on hover and hides on escape", () => {
    render(
      <Tooltip content="Hint">
        <button type="button">Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByRole("button", { name: "Hover me" }).parentElement as HTMLElement;
    const tooltip = screen.getByRole("tooltip");

    fireEvent.mouseEnter(trigger);
    expect(tooltip.className).toContain("visible");

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(tooltip.className).toContain("invisible");
  });
});
