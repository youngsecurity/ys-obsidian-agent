import type { BackendDescriptor, BackendLaunchArgs, BackendProcess } from "../../session/types";
import { detectPi } from "./detectPi";
import { PiBackendProcess } from "./PiBackend";

/** Pi backend (phase 1, docs/design.md): `pi --mode rpc` over stdio. */
export const piBackendDescriptor: BackendDescriptor = {
  id: "pi",
  displayName: "pi",
  async isAvailable(): Promise<boolean> {
    return detectPi() !== null;
  },
  createBackendProcess(args: BackendLaunchArgs): BackendProcess {
    const executablePath = detectPi();
    if (executablePath === null) {
      throw new Error(
        "Could not find the pi executable. Install pi (bun add -g @earendil-works/pi-coding-agent) or ensure it is in a common location."
      );
    }
    return new PiBackendProcess({ ...args, executablePath });
  },
};
