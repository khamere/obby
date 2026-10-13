import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserFilehost,
  isValidFilehostUrl,
  parseZiplineResponse,
  resetUserFilehostForTests,
  setUserFilehost,
  subscribeUserFilehost,
  userFilehostOrigin,
  ziplineUploadEndpoint,
} from "../../src/lib/userFilehost";

describe("parseZiplineResponse", () => {
  it("reads a Zipline v4 body", () => {
    expect(
      parseZiplineResponse(
        null,
        JSON.stringify({
          files: [
            { id: "x", type: "image/png", url: "https://i.example/u/a.png" },
          ],
        }),
      ),
    ).toBe("https://i.example/u/a.png");
  });

  it("reads a Zipline v3 body", () => {
    expect(
      parseZiplineResponse(
        null,
        JSON.stringify({ files: ["https://i.example/u/a.png"] }),
      ),
    ).toBe("https://i.example/u/a.png");
  });

  it("falls back to Location, url fields and plain text", () => {
    expect(parseZiplineResponse("https://i.example/l", "")).toBe(
      "https://i.example/l",
    );
    expect(
      parseZiplineResponse(
        null,
        JSON.stringify({ url: "https://i.example/j" }),
      ),
    ).toBe("https://i.example/j");
    expect(parseZiplineResponse(null, " https://i.example/t \n")).toBe(
      "https://i.example/t",
    );
  });

  it("rejects bodies without a URL", () => {
    expect(
      parseZiplineResponse(null, JSON.stringify({ files: [] })),
    ).toBeNull();
    expect(parseZiplineResponse(null, "not a url")).toBeNull();
    expect(
      parseZiplineResponse(null, JSON.stringify({ files: [{}] })),
    ).toBeNull();
  });
});

describe("isValidFilehostUrl / ziplineUploadEndpoint", () => {
  it("accepts http(s) origins only", () => {
    expect(isValidFilehostUrl("https://img.example.com")).toBe(true);
    expect(isValidFilehostUrl("http://localhost:3000/")).toBe(true);
    expect(isValidFilehostUrl("ftp://img.example.com")).toBe(false);
    expect(isValidFilehostUrl("img.example.com")).toBe(false);
  });

  it("builds the upload endpoint from a bare domain or a full URL", () => {
    expect(ziplineUploadEndpoint("https://img.example.com")).toBe(
      "https://img.example.com/api/upload",
    );
    expect(ziplineUploadEndpoint("https://img.example.com/")).toBe(
      "https://img.example.com/api/upload",
    );
    expect(ziplineUploadEndpoint("https://img.example.com/api/upload")).toBe(
      "https://img.example.com/api/upload",
    );
    expect(ziplineUploadEndpoint("https://img.example.com/zipline/")).toBe(
      "https://img.example.com/zipline/api/upload",
    );
  });
});

describe("store", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.mocked(localStorage.getItem).mockImplementation(
      (k) => store.get(k) ?? null,
    );
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
      store.set(k, v);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((k) => {
      store.delete(k);
    });
    resetUserFilehostForTests();
  });
  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
    resetUserFilehostForTests();
  });

  it("is empty by default and persists what is saved", () => {
    expect(getUserFilehost()).toEqual({ url: "", token: "" });
    expect(userFilehostOrigin()).toBeNull();
    setUserFilehost({ url: " https://img.example.com/ ", token: " tok " });
    expect(getUserFilehost()).toEqual({
      url: "https://img.example.com",
      token: "tok",
    });
    expect(userFilehostOrigin()).toBe("https://img.example.com");
    resetUserFilehostForTests();
    expect(getUserFilehost()).toEqual({
      url: "https://img.example.com",
      token: "tok",
    });
  });

  it("clearing the URL removes the token too", () => {
    setUserFilehost({ url: "https://img.example.com", token: "tok" });
    setUserFilehost({ url: "", token: "tok" });
    expect(getUserFilehost()).toEqual({ url: "", token: "" });
    expect(localStorage.getItem("obby.userFilehost.token")).toBeNull();
  });

  it("notifies subscribers", () => {
    const fn = vi.fn();
    const unsub = subscribeUserFilehost(fn);
    setUserFilehost({ url: "https://img.example.com", token: "" });
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });
});
