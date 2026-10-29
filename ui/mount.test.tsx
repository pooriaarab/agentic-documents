// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "./entry.js";
import { roomOf } from "./view.js";

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
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("The host app gave no token.");
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

  it("refuses options with no callback, a base URL that is not a full http or https address, or an empty document id", () => {
    host = document.createElement("div");
    for (const baseUrl of ["", "docs.example.com", "/docs", "javascript:alert(1)", "ftp://docs.test", "https://docs.test/?a=1", "https://docs.test/#x", "https://u:p@docs.test"]) {
      expect(() => mount(host, { baseUrl, getToken: () => "x" })).toThrow(TypeError);
    }
    expect(() => mount(host, { baseUrl: new URL("https://docs.test") as never, getToken: () => "x" })).toThrow(TypeError);
    expect(() => mount(host, { baseUrl: "https://docs.test" } as never)).toThrow(TypeError);
    expect(() => mount(host, { baseUrl: "https://docs.test", getToken: () => "x", documentId: "" })).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("a getToken that throws shows a host message, not a server message", async () => {
    const { calls } = fakeServer();
    await open({ baseUrl: "https://docs.test", getToken: () => { throw new Error("session ended"); } });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("The host app could not give a token: session ended");
    expect(calls).toEqual([]);
  });

  it("a link in the text with a bad escape or another route is left to the browser", async () => {
    fakeServer();
    await open({ baseUrl: "https://docs.test", getToken: () => "good-token" });
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    for (const href of ["#/d/%E0", "#/other", "#/d/a/b"]) {
      const link = host.appendChild(document.createElement("a"));
      link.href = href;
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      await act(async () => void link.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(false);
    }
    expect(host.querySelector(".page-head h1")?.textContent).toBe("Documents");
  });

  it("a throw from onError does not escape", async () => {
    fakeServer();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    await open({ baseUrl: "https://docs.test", getToken: () => "bad-token", onError: () => { throw new Error("host bug"); } });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("the live room address keeps a path in the base URL and uses ws or wss", () => {
    expect(roomOf("a b", "t", "https://host.test/docs/")).toEqual({ url: "wss://host.test/docs/api/v1/docs/a%20b/ws", token: "t" });
    expect(roomOf("a", "t", "http://host.test").url).toBe("ws://host.test/api/v1/docs/a/ws");
  });

  it("a new page puts focus on its heading, not on the heading of the host page", async () => {
    fakeServer();
    host = document.body.appendChild(document.createElement("div"));
    const hostTitle = host.appendChild(document.createElement("h1"));
    hostTitle.tabIndex = -1;
    const app = host.appendChild(document.createElement("div"));
    await act(async () => void (mounted = mount(app, { baseUrl: "https://docs.test", getToken: () => "good-token" })));
    await vi.waitFor(() => expect(host.textContent).toContain("Alpha"));
    await act(async () => void app.querySelector<HTMLAnchorElement>('a[href="#/d/a"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    // The fake server has no document state, so the editor page shows its error. Back goes to the list.
    await vi.waitFor(() => expect([...app.querySelectorAll("button")].some((b) => b.textContent === "Back to documents")).toBe(true));
    await act(async () => void [...app.querySelectorAll("button")].find((b) => b.textContent === "Back to documents")!.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(app.querySelector(".page-head h1")));
    expect(document.activeElement).not.toBe(hostTitle);
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
