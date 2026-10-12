// A secret that cannot be printed by accident: String(), JSON.stringify(), template literals and util.inspect all
// show "[redacted]". The only way out is reveal(), which the few call sites that need the bytes use.
import { inspect } from "node:util";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "Secret([redacted])";
  }
}
