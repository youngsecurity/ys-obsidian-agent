import type { BackendDescriptor } from "../session/types";
import { claudeCodeBackendDescriptor, codexBackendDescriptor } from "./acp";
import { piBackendDescriptor } from "./pi";

/**
 * The only place that names every backend (docs/design.md). Order is the
 * order shown in the settings picker. opencode and Gemini CLI are deferred;
 * they would be two more ACP descriptors here.
 */
export const BACKENDS: readonly BackendDescriptor[] = [
  piBackendDescriptor,
  claudeCodeBackendDescriptor,
  codexBackendDescriptor,
];

export const DEFAULT_BACKEND_ID = "pi";

export function getBackendDescriptor(id: string): BackendDescriptor | undefined {
  return BACKENDS.find((descriptor) => descriptor.id === id);
}
