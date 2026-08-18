require("../shared/account.js");

const FFAccount = global.FFAccount;

test("localAccount returns a signed-out local account", () => {
  expect(FFAccount.localAccount()).toEqual({
    mode: "local",
    signedIn: false,
    tier: "free",
    planExpiresAt: null
  });
});

test("signedInAccount builds a free-tier account from a user object", () => {
  const account = FFAccount.signedInAccount(
    { uid: "1", email: "a@b.com", displayName: "A B", photoURL: null },
    { provider: "google.com" }
  );
  expect(account).toMatchObject({
    mode: "cloud",
    signedIn: true,
    uid: "1",
    email: "a@b.com",
    name: "A B",
    tier: "free",
    provider: "google.com"
  });
});

test("signedInAccount falls back to email when no display name is given", () => {
  const account = FFAccount.signedInAccount({ uid: "2", email: "x@y.com" }, {});
  expect(account.name).toBe("x@y.com");
});

test("isPaidActive is false for missing/local/free/expired accounts", () => {
  expect(FFAccount.isPaidActive(null)).toBe(false);
  expect(FFAccount.isPaidActive(FFAccount.localAccount())).toBe(false);
  expect(
    FFAccount.isPaidActive({ signedIn: true, tier: "paid", planExpiresAt: Date.now() - 1000 })
  ).toBe(false);
});

test("isPaidActive is true for a signed-in, unexpired paid account", () => {
  expect(
    FFAccount.isPaidActive({ signedIn: true, tier: "paid", planExpiresAt: Date.now() + 100000 })
  ).toBe(true);
});

test("planFor resolves Local, Free, and Paid correctly", () => {
  expect(FFAccount.planFor(FFAccount.localAccount())).toBe(FFAccount.LOCAL_PLAN);
  expect(FFAccount.planFor({ signedIn: true, tier: "free" })).toBe(FFAccount.FREE_PLAN);
  expect(
    FFAccount.planFor({ signedIn: true, tier: "paid", planExpiresAt: Date.now() + 100000 })
  ).toBe(FFAccount.PAID_PLAN);
  // Signed in but on an expired paid plan falls back to Free, not Paid.
  expect(
    FFAccount.planFor({ signedIn: true, tier: "paid", planExpiresAt: Date.now() - 1000 })
  ).toBe(FFAccount.FREE_PLAN);
});
