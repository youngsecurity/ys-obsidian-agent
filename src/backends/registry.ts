import type { BackendDescriptor } from "../session/types";
import { piBackendDescriptor } from "./pi";

/** The only place that names every backend (docs/design.md). */
export const BACKENDS: readonly BackendDescriptor[] = [piBackendDescriptor];

export const DEFAULT_BACKEND_ID = "pi";

export function getBackendDescriptor(id: string): BackendDescriptor | undefined {
  return BACKENDS.find((descriptor) => descriptor.id === id);
}
