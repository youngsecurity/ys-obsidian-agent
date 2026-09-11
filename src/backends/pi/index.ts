import type { BackendDescriptor, BackendLaunchArgs, BackendProcess } from "../../session/types";
import { detectPi } from "./detectPi";
import { PiBackendProcess } from "./PiBackend";

export const PI_INSTALL_HINT =
  "Install pi (bun add -g @earendil-works/pi-coding-agent) or set the executable path in settings.";

/** Pi backend (phase 1, docs/design.md): `pi --mode rpc` over stdio. */
export const piBackendDescriptor: BackendDescriptor = {
  id: "pi",
  displayName: "pi",
  resolveExecutable(override?: string): string | null {
    return detectPi(override);
  },
  createBackendProcess(args: BackendLaunchArgs): BackendProcess {
    const executablePath = detectPi(args.executablePath);
    if (executablePath === null) {
      const override = args.executablePath?.trim() ?? "";
      throw new Error(
        override.length > 0
          ? `The configured pi executable is not runnable: ${override}. Fix the path in settings.`
          : `Could not find the pi executable. ${PI_INSTALL_HINT}`
      );
    }
    return new PiBackendProcess({ ...args, executablePath });
  },
};
