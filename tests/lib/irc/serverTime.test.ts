import { describe, expect, test } from "vitest";
import { parseServerTime } from "../../../src/lib/irc/utils";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const read = (value: string | undefined) => parseServerTime(value, NOW);

describe("parseServerTime", () => {
  test.each([
    ["2026-11-21T10:00:00.123Z", "2026-11-21T10:00:00.123Z"],
    ["2026-11-21T10:00:00Z", "2026-11-21T10:00:00.000Z"],
    ["2026-11-21T10:00:00.5Z", "2026-11-21T10:00:00.500Z"],
    ["2026-11-21T10:00:00.123456Z", "2026-11-21T10:00:00.123Z"],
    ["2024-02-29T23:59:59.999Z", "2024-02-29T23:59:59.999Z"],
    ["2026-11-23T12:00:00.000Z", "2026-11-23T12:00:00.000Z"],
    ["1995-06-01T00:00:00.000Z", "1995-06-01T00:00:00.000Z"],
    ["2026-11-21T10:00:00.123456789Z", "2026-11-21T10:00:00.123Z"],
  ])("reads %s", (value, expected) => {
    expect(new Date(read(value)).toISOString()).toBe(expected);
  });

  test.each([
    ["nothing", undefined],
    ["an empty value", ""],
    ["a bare number", "3000"],
    ["a date without a time", "2026-11-21"],
    ["a time without a zone", "2026-11-21T10:00:00"],
    ["a time with an offset", "2026-11-21T10:00:00.000+00:00"],
    ["a lowercase form", "2026-11-21t10:00:00.000z"],
    ["a space for the T", "2026-11-21 10:00:00.000Z"],
    ["a unix timestamp", "1795305600"],
    ["a day the month does not have", "2026-02-30T10:00:00.000Z"],
    ["a month the year does not have", "2026-13-01T10:00:00.000Z"],
    ["an hour the day does not have", "2026-11-21T24:00:00.000Z"],
    ["a leap second", "2012-06-30T23:59:60.419Z"],
    ["a second the minute does not have", "2026-11-21T14:09:60.419Z"],
    ["a second past the leap second", "2012-06-30T23:59:61.000Z"],
    ["a minute the hour does not have", "2012-06-30T23:60:00.000Z"],
    [
      "a leap second in an hour the day does not have",
      "2012-06-30T24:59:60.000Z",
    ],
    ["text around a time", " 2026-11-21T10:00:00.000Z"],
    ["a time far ahead of our clock", "9999-12-31T23:59:59.999Z"],
    ["a time over a year ahead of our clock", "2027-11-24T12:00:00.000Z"],
    ["a time before IRC existed", "0001-01-01T00:00:00.000Z"],
    ["the start of unix time", "1970-01-01T00:00:00.000Z"],
  ])("reads %s as no server time", (_case, value) => {
    expect(read(value)).toBeNaN();
  });
});
