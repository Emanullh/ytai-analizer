// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Tooltip from "./Tooltip";

afterEach(() => {
  cleanup();
});

describe("Tooltip", () => {
  it("renders with aria-describedby and opens on focus", () => {
    render(
      <Tooltip content="Definicion">
        <button type="button">Campo</button>
      </Tooltip>
    );

    const trigger = screen.getByRole("button", { name: "Campo" }).parentElement;
    expect(trigger).toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Campo" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Definicion");
  });

  it("shows on hover and hides on escape", () => {
    render(
      <Tooltip content="Hint">
        <button type="button">Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByRole("button", { name: "Hover me" }).parentElement as HTMLElement;
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hint");

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
