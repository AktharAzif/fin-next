import { describe, expect, it } from "vitest";
import { welcomeTitle } from "./HomePage.tsx";

describe("Home's title (the Home board's default and noName states)", () => {
  it("greets the person by first name, or with Welcome alone", () => {
    expect(welcomeTitle("Maya Rivera")).toBe("Welcome, Maya");
    expect(welcomeTitle("  Priya  ")).toBe("Welcome, Priya");
    expect(welcomeTitle("")).toBe("Welcome");
    expect(welcomeTitle("   ")).toBe("Welcome");
  });
});
