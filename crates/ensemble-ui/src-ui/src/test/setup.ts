import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Matchers<R, T> extends matchers.TestingLibraryMatchers<T, R> {}
}

expect.extend(matchers);
