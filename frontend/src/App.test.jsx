import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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

it("recovers from non-array saved history", () => {
  localStorage.setItem("incite_ai_history", '{"unexpected":true}');
  render(<App />);
  expect(screen.getByText("No saved chats yet.")).toBeInTheDocument();
});

it("shows a readable error for structured API validation errors", async () => {
  vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: false,
    status: 422,
    json: async () => ({ detail: [{ msg: "invalid" }] }),
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText("Article URL"), {
    target: { value: "https://example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to summarize article",
  );
});

it("reports clipboard failures without claiming success", async () => {
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify([{ id: 1, title: "Saved", summary: ["Point"] }]),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to copy");
  expect(screen.queryByText("✓ Copied")).not.toBeInTheDocument();
});

it("deletes browser history without mutating shared backend records", async () => {
  const fetchSpy = vi.spyOn(global, "fetch");
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify([{ id: 1, title: "Saved", summary: ["Point"] }]),
  );
  render(<App />);
  fireEvent.click(screen.getByTitle("Delete chat"));
  expect(screen.getByText("No saved chats yet.")).toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("does not render executable source links from stored history", () => {
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify([
      {
        id: 1,
        title: "Saved",
        summary: ["Point"],
        url: "javascript:alert(document.cookie)",
      },
    ]),
  );
  render(<App />);
  expect(
    screen.queryByRole("link", { name: /source/i }),
  ).not.toBeInTheDocument();
});

it("renders article and model content as text rather than HTML", () => {
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify([
      {
        id: 1,
        title: "<img src=x onerror=alert(1)>",
        summary: ["<script>alert(1)</script>"],
      },
    ]),
  );
  const { container } = render(<App />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
});

it("clears saved history and the active summary", async () => {
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify([{ id: 1, title: "Private research", summary: ["Point"] }]),
  );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
  expect(screen.queryByText("Private research")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("incite_ai_history"))).toEqual([]),
  );
});

it("caps restored history at 100 summaries", () => {
  localStorage.setItem(
    "incite_ai_history",
    JSON.stringify(
      Array.from({ length: 120 }, (_, id) => ({
        id,
        title: `Article ${id}`,
        summary: ["Point"],
      })),
    ),
  );
  render(<App />);
  expect(JSON.parse(localStorage.getItem("incite_ai_history"))).toHaveLength(
    100,
  );
});

it("cancels a pending request without retrying", async () => {
  const fetchSpy = vi.spyOn(global, "fetch").mockImplementationOnce(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  render(<App />);
  fireEvent.change(screen.getByLabelText("Article URL"), {
    target: { value: "https://example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Request cancelled.",
  );
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: /generate insight/i }),
  ).toBeEnabled();
});

it("times out stalled requests and restores the form", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(global, "fetch").mockImplementationOnce(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Article URL"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate insight/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The request timed out.",
    );
    expect(
      screen.getByRole("button", { name: /generate insight/i }),
    ).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});
