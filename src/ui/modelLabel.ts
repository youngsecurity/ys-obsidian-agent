import type { ModelInfo } from "../session/types";

/** Keep the alias and the backend's version details; never guess a model version. */
export function modelLabel(model: ModelInfo): string {
  const description = model.description?.trim();
  return description ? `${model.name}: ${description}` : model.name;
}
