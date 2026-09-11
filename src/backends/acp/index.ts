import type { BackendDescriptor, BackendLaunchArgs, BackendProcess } from "../../session/types";
import { detectExecutable, executableNames } from "../shared/detectExecutable";
import { AcpBackendProcess } from "./AcpBackend";
import { claudeCodeEnvironment } from "./claudeRuntime";
import { codexEnvironment } from "./codexEnvironment";

interface AcpAgentSpec {
  readonly id: string;
  readonly displayName: string;
  /** Bare executable name of the ACP adapter. */
  readonly executable: string;
  readonly installHint: string;
  readonly environment?: () => NodeJS.ProcessEnv;
}

function createAcpDescriptor(spec: AcpAgentSpec): BackendDescriptor {
  const names = executableNames(spec.executable);
  return {
    id: spec.id,
    displayName: spec.displayName,
    resolveExecutable(override?: string): string | null {
      return detectExecutable(names, override);
    },
    createBackendProcess(args: BackendLaunchArgs): BackendProcess {
      const executablePath = detectExecutable(names, args.executablePath);
      if (executablePath === null) {
        const override = args.executablePath?.trim() ?? "";
        throw new Error(
          override.length > 0
            ? `The configured ${spec.displayName} executable is not runnable: ${override}. Fix the path in settings.`
            : `Could not find ${spec.executable}. ${spec.installHint}`
        );
      }
      return new AcpBackendProcess({ ...args, executablePath, backendId: spec.id, env: spec.environment?.() });
    },
  };
}

/** Claude Code via Zed's ACP adapter. */
export const claudeCodeBackendDescriptor: BackendDescriptor = createAcpDescriptor({
  id: "claude-code",
  displayName: "Claude Code",
  executable: "claude-code-acp",
  environment: claudeCodeEnvironment,
  installHint:
    "Install it (bun add -g @zed-industries/claude-code-acp), make sure Claude Code is logged in (claude /login), or set the executable path in settings.",
});

/** Codex via the maintained ACP adapter over Codex App Server. */
export const codexBackendDescriptor: BackendDescriptor = createAcpDescriptor({
  id: "codex",
  displayName: "Codex",
  executable: "codex-acp",
  environment: codexEnvironment,
  installHint:
    "Install it (bun add -g @agentclientprotocol/codex-acp), make sure Codex is logged in (codex login), or set the executable path in settings.",
});
