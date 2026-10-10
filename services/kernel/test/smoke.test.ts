import { expect, it } from "vitest";
import { SERVICE_NAME } from "../src/index";

it("kernel service scaffold is wired", () => {
  expect(SERVICE_NAME).toBe("symbolon-kernel");
});
