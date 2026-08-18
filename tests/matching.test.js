require("../shared/matching.js");

const { normalizeKey, cleanText, humanize, tokenSet, matchAnswer } = global.FFMatching;

describe("normalizeKey", () => {
  test("lowercases, strips punctuation, joins with underscores", () => {
    expect(normalizeKey("What is your Full Name?")).toBe("what_is_your_full_name");
  });

  test("collapses repeated separators", () => {
    expect(normalizeKey("  First   Name!!  ")).toBe("first_name");
  });

  test("handles empty/nullish input", () => {
    expect(normalizeKey(null)).toBe("");
    expect(normalizeKey(undefined)).toBe("");
    expect(normalizeKey("")).toBe("");
  });
});

describe("cleanText", () => {
  test("trims a trailing colon and whitespace", () => {
    expect(cleanText("Email address:   ")).toBe("Email address");
  });

  test("collapses internal whitespace", () => {
    expect(cleanText("First    Name")).toBe("First Name");
  });
});

describe("humanize", () => {
  test("converts snake_case", () => {
    expect(humanize("first_name")).toBe("first name");
  });

  test("converts camelCase", () => {
    expect(humanize("firstName")).toBe("first Name");
  });

  test("converts kebab-case", () => {
    expect(humanize("first-name")).toBe("first name");
  });
});

describe("tokenSet", () => {
  test("filters out stopwords", () => {
    expect(tokenSet("what is your full name")).toEqual(new Set(["full", "name"]));
  });

  test("returns an empty set for input that's all stopwords", () => {
    expect(tokenSet("what is the")).toEqual(new Set());
  });
});

describe("matchAnswer", () => {
  const profile = {
    answers: {
      email_address: { value: "a@b.com" },
      full_name: { value: "Jane Doe" }
    }
  };

  test("returns an exact label-key match", () => {
    expect(matchAnswer(profile, "email_address", "email")).toEqual({ value: "a@b.com" });
  });

  test("returns an exact name-key match when the label misses", () => {
    expect(matchAnswer(profile, "unmatched_label", "full_name")).toEqual({ value: "Jane Doe" });
  });

  test("falls back to Dice-coefficient fuzzy matching above the 0.5 threshold", () => {
    expect(matchAnswer(profile, "your_full_legal_name", null)).toEqual({ value: "Jane Doe" });
  });

  test("returns null below the similarity threshold", () => {
    expect(matchAnswer(profile, "favorite_color", null)).toBeNull();
  });

  test("name-part guard: won't map first_name to full_name with no part-name answer saved", () => {
    expect(matchAnswer(profile, "first_name", null)).toBeNull();
  });

  test("name-part guard: stops blocking once a part-name answer exists in the profile", () => {
    const withFirst = {
      answers: {
        ...profile.answers,
        first_name: { value: "Jane" }
      }
    };
    // Without a part-name answer present this would return null (see previous test);
    // with one present anywhere in the profile, the fuzzy match to full_name is allowed through.
    expect(matchAnswer(withFirst, "given_name", null)).toEqual({ value: "Jane Doe" });
  });

  test("returns null when there's no profile or no saved answers", () => {
    expect(matchAnswer(null, "x", "y")).toBeNull();
    expect(matchAnswer({ answers: {} }, "x", "y")).toBeNull();
  });
});
