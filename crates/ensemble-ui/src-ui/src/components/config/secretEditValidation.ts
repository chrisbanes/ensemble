import type { SecretEdit } from "@/generated/models";

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function secretEditValidationError(edit: SecretEdit | undefined) {
  if (!edit || edit.action === "preserve" || edit.action === "remove") return null;
  if (edit.action === "set_literal") {
    return edit.value.trim() ? null : "Secret replacement must not be blank.";
  }
  return ENVIRONMENT_VARIABLE_NAME.test(edit.variable)
    ? null
    : "Enter a valid environment variable name.";
}
