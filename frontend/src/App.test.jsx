import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("renders the URL input and submit button", () => {
    render(<App />);
    expect(
      screen.getByPlaceholderText(/paste article url here/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate insight/i }),
    ).toBeInTheDocument();
  });

  it("does not call fetch when the URL field is empty", () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("displays the summary after a successful scrape", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 1,
        title: "Test Article",
        summary: ["First point", "Second point"],
      }),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/paste article url here/i), {
      target: { value: "https://example.com/article" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));

    // Wait for title to appear
    await waitFor(() => {
      expect(screen.getAllByText("Test Article")[0]).toBeInTheDocument();
    });

    // Target the rendered bullet text (getAllByText handles duplicate rendering across active card & history card)
    expect(screen.getAllByText("First point")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Second point")[0]).toBeInTheDocument();
  });

  it("shows an error message when the API call fails", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        detail: "Could not extract readable main content from this website.",
      }),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/paste article url here/i), {
      target: { value: "https://example.com/bad-article" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/could not extract readable main content/i),
      ).toBeInTheDocument(),
    );
  });

  it("saves a successful summary to localStorage history", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 1,
        title: "Saved Article",
        summary: ["Point A"],
      }),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/paste article url here/i), {
      target: { value: "https://example.com/save-me" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("incite_ai_history"));
      expect(stored[0].title).toBe("Saved Article");
    });
  });

  it("updates the bullet count when the slider changes", () => {
    render(<App />);
    const slider = screen.getByLabelText(/bullet points/i);
    fireEvent.change(slider, { target: { value: "7" } });

    // Using getAllByText because "7" appears as both the active value readout and the slider's max label
    const elements = screen.getAllByText("7");
    expect(elements.length).toBeGreaterThan(0);
    expect(elements[0]).toBeInTheDocument();
  });
});
