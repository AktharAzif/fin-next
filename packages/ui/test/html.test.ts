// The static-markup readers the other tests lean on.
import { describe, expect, it } from "vitest";
import { text } from "./html.ts";

describe("text", () => {
  it("drops every tag and keeps the text between them", () => {
    expect(text('<p class="a">One <b>two</b><br/>three</p>')).toBe("One twothree");
    expect(text("<a<b>c")).toBe("c");
    expect(text("<scr<script>ipt>")).toBe("ipt>");
  });

  it("keeps a <> and a < that no > follows as text", () => {
    expect(text("a<>b")).toBe("a<>b");
    expect(text("<>>")).toBe("<>>");
    expect(text("1 < 2")).toBe("1 < 2");
    expect(text("<i>x</i> < y")).toBe("x < y");
  });

  it("decodes the entities React writes in text, each once", () => {
    expect(text("<p>Fin&#x27;s &amp; more</p>")).toBe("Fin's & more");
    expect(text("&amp;#x27; &amp;amp;")).toBe("&#x27; &amp;");
  });
});
