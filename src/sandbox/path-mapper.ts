import { isAbsolute, relative, resolve } from "node:path";
import path from "node:path";

export type PathMapper = {
  hostToContainer: (filePath: string) => string;
};

export function createPathMapper(params: {
  hostWorkspaceDir: string;
  containerWorkdir: string;
}): PathMapper {
  const hostWorkspaceDir = resolve(params.hostWorkspaceDir);
  const containerWorkdir = params.containerWorkdir;

  return {
    hostToContainer: (filePath: string) => {
      const normalizedInput = filePath.trim();
      const hostPath = normalizedInput
        ? isAbsolute(normalizedInput)
          ? resolve(normalizedInput)
          : resolve(hostWorkspaceDir, normalizedInput)
        : hostWorkspaceDir;
      const rel = relative(hostWorkspaceDir, hostPath);
      if (!rel || rel === ".") {
        return containerWorkdir;
      }
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return containerWorkdir;
      }
      const posixRel = rel.split(path.sep).join(path.posix.sep);
      return path.posix.join(containerWorkdir, posixRel);
    },
  };
}
