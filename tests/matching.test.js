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

  test("strips zero-width spacer characters some sites use for CSS layout (regression: Luma registration forms)", () => {
    // A bare zero-width space isn't matched by \s, so left alone it makes an
    // otherwise-empty decorative spacer node look like real label text.
    expect(cleanText("​")).toBe("");
    expect(cleanText("​What's your name?​")).toBe("What's your name?");
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
  // matchAnswer is agnostic to where its answers come from — an Application,
  // the shared Profile, or (in background.js) a merge of both. It only ever
  // reads `.answers`, so a bare `{ answers }` object stands in for any of them.
  const answersSource = {
    answers: {
      email_address: { value: "a@b.com" },
      full_name: { value: "Jane Doe" }
    }
  };

  test("returns an exact label-key match", () => {
    expect(matchAnswer(answersSource, "email_address", "email")).toEqual({ value: "a@b.com" });
  });

  test("returns an exact name-key match when the label misses", () => {
    expect(matchAnswer(answersSource, "unmatched_label", "full_name")).toEqual({ value: "Jane Doe" });
  });

  test("falls back to Dice-coefficient fuzzy matching above the 0.5 threshold", () => {
    expect(matchAnswer(answersSource, "your_full_legal_name", null)).toEqual({ value: "Jane Doe" });
  });

  test("returns null below the similarity threshold", () => {
    expect(matchAnswer(answersSource, "favorite_color", null)).toBeNull();
  });

  test("name-part guard: won't map first_name to full_name with no part-name answer saved", () => {
    expect(matchAnswer(answersSource, "first_name", null)).toBeNull();
  });

  test("name-part guard: stops blocking once a part-name answer exists in the saved answers", () => {
    const withFirst = {
      answers: {
        ...answersSource.answers,
        first_name: { value: "Jane" }
      }
    };
    // Without a part-name answer present this would return null (see previous test);
    // with one present anywhere in the saved answers, the fuzzy match to full_name is allowed through.
    expect(matchAnswer(withFirst, "given_name", null)).toEqual({ value: "Jane Doe" });
  });

  test("returns null when there's no answers source or no saved answers", () => {
    expect(matchAnswer(null, "x", "y")).toBeNull();
    expect(matchAnswer({ answers: {} }, "x", "y")).toBeNull();
  });
});
