// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "./entry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no matchMedia. The theme provider asks for the color scheme.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const doc = (id: string, title: string) => ({ id, title, updatedAt: 1, updatedBy: { kind: "human", name: "Ada" } });

/** A server with a bearer token. It records each request. */
function fakeServer(role: "editor" | "viewer" = "editor") {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (auth !== "Bearer good-token") return json({ error: { code: "UNAUTHENTICATED", message: "no" } }, 401);
    if (url.endsWith("/api/v1/me")) return json({ kind: "human", name: "Ada", scopes: [], role });
    if (url.endsWith("/api/v1/docs")) return json([doc("a", "Alpha"), doc("b", "Beta")]);
    return json({ error: { code: "NOT_FOUND", message: "no" } }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

let mounted: Mounted | undefined;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
  host?.remove();
  vi.unstubAllGlobals();
});

async function open(options: Parameters<typeof mount>[1]) {
  host = document.body.appendChild(document.createElement("div"));
  await act(async () => void (mounted = mount(host, options)));
}

describe("mount", () => {
  it("signs in with the token from the callback, against the base URL, and lists the documents", async () => {
    const { calls } = fakeServer();
    const getToken = vi.fn(async () => "good-token");
    await open({ baseUrl: "https://docs.test/", getToken });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    expect(host.textContent).toContain("Beta");
    expect(host.textContent).toContain("New document");
    expect(calls.map((c) => c.url)).toEqual(["https://docs.test/api/v1/me", "https://docs.test/api/v1/docs"]);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("a viewer gets no New document button", async () => {
    fakeServer("viewer");
    await open({ baseUrl: "https://docs.test", getToken: () => "good-token" });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    expect(host.textContent).not.toContain("New document");
    expect(host.textContent).toContain("(viewer)");
  });

  it("shows no Sign out button, because the host owns sign in", async () => {
    fakeServer();
    await open({ baseUrl: "https://docs.test", getToken: () => "good-token" });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    expect(host.textContent).not.toContain("Sign out");
  });

  it("a refused token shows an alert, calls onError, and Try again asks the callback again", async () => {
    fakeServer();
    const tokens = ["bad-token", "good-token"];
    const getToken = vi.fn(() => tokens.shift()!);
    const onError = vi.fn();
    await open({ baseUrl: "https://docs.test", getToken, onError });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("The server did not accept this token.");
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => void [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a callback that gives no token is an error, not a request", async () => {
    const { calls } = fakeServer();
    const onError = vi.fn();
    await open({ baseUrl: "https://docs.test", getToken: () => "", onError });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("a click on a document link moves inside the app and leaves the address of the page alone", async () => {
    fakeServer();
    location.hash = "#host";
    await open({ baseUrl: "https://docs.test", getToken: () => "good-token" });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    const link = host.querySelector<HTMLAnchorElement>('a[href="#/d/a"]')!;
    await act(async () => void link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(location.hash).toBe("#host");
    expect(host.querySelector("h1")?.textContent).not.toBe("Documents");
  });

  it("refuses options with no base URL or no callback", () => {
    host = document.createElement("div");
    expect(() => mount(host, { baseUrl: "", getToken: () => "x" })).toThrow(TypeError);
    expect(() => mount(host, { baseUrl: "https://docs.test" } as never)).toThrow(TypeError);
  });

  it("unmount removes the app, and a second unmount does nothing", async () => {
    fakeServer();
    await open({ baseUrl: "https://docs.test", getToken: () => "good-token" });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    await act(async () => mounted!.unmount());
    expect(host.innerHTML).toBe("");
    expect(() => mounted!.unmount()).not.toThrow();
  });
});
