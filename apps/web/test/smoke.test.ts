import { expect, it } from "vitest";
import { APP_NAME } from "../src/index";

it("web scaffold is wired", () => {
  expect(APP_NAME).toBe("symbolon-web");
});
