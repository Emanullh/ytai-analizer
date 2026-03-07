// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AnalyzePage from "./AnalyzePage";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("AnalyzePage", () => {
  it("selecciona todos los videos mostrados y aplica QoL de solo seleccionados", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          channelId: "UC123",
          channelName: "Canal Demo",
          sourceInput: "https://www.youtube.com/@demo",
          timeframe: "6m",
          warnings: [],
          videos: [
            {
              videoId: "v1",
              title: "React Hooks en 10 minutos",
              publishedAt: "2026-03-01T10:00:00.000Z",
              viewCount: 1000,
              thumbnailUrl: "https://img.youtube.com/v1.jpg"
            },
            {
              videoId: "v2",
              title: "Node para backend",
              publishedAt: "2026-02-20T10:00:00.000Z",
              viewCount: 900,
              thumbnailUrl: "https://img.youtube.com/v2.jpg"
            },
            {
              videoId: "v3",
              title: "React Router avanzado",
              publishedAt: "2026-02-10T10:00:00.000Z",
              viewCount: 1200,
              thumbnailUrl: "https://img.youtube.com/v3.jpg"
            }
          ]
        })
      })
    );

    render(<AnalyzePage />);

    fireEvent.change(screen.getByLabelText(/Canal/), {
      target: { value: "https://www.youtube.com/@demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Analizar" }));

    await waitFor(() => {
      expect(screen.getByText("Videos encontrados: 3")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "react" } });
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar mostrados" }));

    expect(screen.getByText(/Seleccionados:/)).toHaveTextContent("Seleccionados: 2 de 3 videos");
    expect(screen.getByRole("button", { name: "Exportar seleccionados (2)" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Mostrar solo seleccionados"));

    expect(screen.getByText("React Hooks en 10 minutos")).toBeInTheDocument();
    expect(screen.getByText("React Router avanzado")).toBeInTheDocument();
    expect(screen.queryByText("Node para backend")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Invertir mostrados" }));
    expect(screen.getByText("No hay videos seleccionados con el filtro actual.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exportar seleccionados (0)" })).toBeDisabled();
  });
});
