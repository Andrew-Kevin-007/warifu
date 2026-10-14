// Compile-time test (checked by `pnpm typecheck`): a plain string, and an Untrusted<string> used as a React child, are errors.
import { createElement } from "react";
import { untrusted } from "@symbolon/schemas";
import { UntrustedText } from "../src/components/safety/UntrustedText";

const u = untrusted("hostile");

// OK: the branded type goes through the component.
createElement(UntrustedText, { value: u });

// @ts-expect-error a plain string must be wrapped explicitly with untrusted(); there is no implicit path
createElement(UntrustedText, { value: "plain" });

// @ts-expect-error Untrusted<string> is not a ReactNode, so it cannot be rendered as a child
createElement("span", null, u);
