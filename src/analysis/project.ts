import { join } from "node:path";
import { Project, type SourceFile } from "ts-morph";
import type { ChangeSet } from "../workspace/changeSet";

export interface ProjectPair {
  root: string;
  pre: Project;
  post: Project;
}

/** Loads the target repo as a ts-morph project, using its tsconfig when it has one. */
export function loadProject(root: string): Project {
  const tsconfig = join(root, "tsconfig.json");
  try {
    return new Project({ tsConfigFilePath: tsconfig });
  } catch {
    const project = new Project({ compilerOptions: { jsx: 4, allowJs: false, strict: true } });
    project.addSourceFilesAtPaths([join(root, "src/**/*.{ts,tsx}"), `!${join(root, "**/node_modules/**")}`]);
    return project;
  }
}

/** Builds the pre-diff and post-diff projects. The post project is the pre project with the diff applied in memory; nothing touches disk. */
export function loadProjectPair(root: string, changeSet: ChangeSet): ProjectPair {
  const pre = loadProject(root);
  const post = loadProject(root);
  for (const file of changeSet.files) {
    if (file.escapesRoot) {
      continue;
    }
    const absolute = join(root, file.path);
    if (file.kind === "delete") {
      const existing = post.getSourceFile(absolute);
      if (existing) {
        post.removeSourceFile(existing);
      }
    } else if (file.after !== null) {
      post.createSourceFile(absolute, file.after, { overwrite: true });
    }
  }
  return { root, pre, post };
}

/** Repo-relative POSIX path of a source file. */
export function relativePath(root: string, sourceFile: SourceFile): string {
  const full = sourceFile.getFilePath();
  const prefix = root.endsWith("/") ? root : [root, "/"].join("");
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

/** True for files the analysers should parse. */
export function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts");
}
