import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { FIGMA_MCP_URL } from "../../../shared/protocol.ts";
import type { CodexConfigReadResult } from "./codex-protocol.ts";

export const CODEX_PERMISSION_PROFILE = "sesori-figma-review-v1";
export const CODEX_SCHEMA_VERSION = "0.154.0";

export type CodexExecutionPolicy = {
  dir: string;
  notesDir: string;
  appRepo?: string;
  command: string;
  args: string[];
  thread: {
    cwd: string;
    runtimeWorkspaceRoots: string[];
    permissions: typeof CODEX_PERMISSION_PROFILE;
    sandbox?: never;
    approvalsReviewer: "user";
    approvalPolicy: {
      granular: {
        sandbox_approval: true;
        rules: true;
        mcp_elicitations: false;
        request_permissions: true;
        skill_approval: false;
      };
    };
    environments: [];
    selectedCapabilityRoots: [];
    allowProviderModelFallback: false;
  };
};

const tomlString = (value: string) => JSON.stringify(value);
const config = (key: string, value: string) => ["-c", `${key}=${value}`];
const pathKey = (path: string) => tomlString(path);
const containedBy = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const canonicalAbsolute = (value: string, name: string) => {
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  try { return realpathSync(value); }
  catch (error) { throw new Error(`${name} must exist and be canonicalizable`, { cause: error }); }
};

/** Build complete per-process overrides. They are validated again through config/read before any thread can start. */
export function createCodexExecutionPolicy(args: {
  dir: string;
  appRepo?: string;
  command?: string;
}): CodexExecutionPolicy {
  const dir = canonicalAbsolute(args.dir, "Codex workspace");
  const notesDir = canonicalAbsolute(join(dir, "notes"), "Codex notes directory");
  const appRepo = args.appRepo ? canonicalAbsolute(args.appRepo, "APP_REPO") : undefined;
  if (appRepo && (containedBy(appRepo, dir) || containedBy(dir, appRepo))) {
    throw new Error("APP_REPO must not overlap the Codex workspace or its writable notes directory");
  }
  const filesystem = [
    ...config(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem.":minimal"`, tomlString("read")),
    ...config(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem.${pathKey(dir)}`, tomlString("read")),
    ...config(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem.${pathKey(notesDir)}`, tomlString("write")),
    ...(appRepo
      ? config(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem.${pathKey(appRepo)}`, tomlString("read"))
      : []),
  ];
  const overrides = [
    ...config("default_permissions", tomlString(CODEX_PERMISSION_PROFILE)),
    ...config(
      `permissions.${CODEX_PERMISSION_PROFILE}.description`,
      tomlString("Sesori Review: workspace read-only, notes write-only"),
    ),
    ...filesystem,
    ...config(`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled`, "false"),
    ...config("approval_policy", [
      "{ granular = { sandbox_approval = true, rules = true,",
      "mcp_elicitations = false, request_permissions = true, skill_approval = false } }",
    ].join(" ")),
    ...config("approvals_reviewer", tomlString("user")),
    ...config("web_search", tomlString("disabled")),
    ...config("features.apps", "false"),
    ...config("apps._default.enabled", "false"),
    ...config("features.multi_agent", "false"),
    ...config("agents.enabled", "false"),
    ...config("features.remote_plugin", "false"),
    ...config("features.hooks", "false"),
    ...config("features.goals", "false"),
    ...config("features.memories", "false"),
    ...config("features.web_search", "false"),
    ...config("features.web_search_cached", "false"),
    ...config("features.web_search_request", "false"),
    ...config("features.skill_mcp_dependency_install", "false"),
    ...config("feedback.enabled", "false"),
    ...config("mcp_servers.figma-desktop.url", tomlString(FIGMA_MCP_URL)),
    ...config("mcp_servers.figma-desktop.enabled", "true"),
  ];
  return {
    dir,
    notesDir,
    appRepo,
    command: args.command ?? process.env.CODEX_PATH ?? "codex",
    args: ["app-server", "--stdio", "--strict-config", ...overrides],
    thread: {
      cwd: dir,
      runtimeWorkspaceRoots: [notesDir],
      permissions: CODEX_PERMISSION_PROFILE,
      approvalsReviewer: "user",
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: true,
          mcp_elicitations: false,
          request_permissions: true,
          skill_approval: false,
        },
      },
      environments: [],
      selectedCapabilityRoots: [],
      allowProviderModelFallback: false,
    },
  };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const enabledEntries = (value: unknown): string[] => Object.entries(object(value) ?? {}).flatMap(([name, raw]) => {
  const entry = object(raw);
  return entry?.enabled === false ? [] : [name];
});
const assertFlag = (features: Record<string, unknown>, name: string, expected: unknown) => {
  if (features[name] !== expected) throw new Error(`Codex effective config did not isolate features.${name}`);
};

/** Reject merged personal/managed capability leakage. This is a qualification gate, not prompt-based policy. */
export function assertCodexConfigIsolated(args: { result: CodexConfigReadResult; policy: CodexExecutionPolicy }) {
  const effective = args.result.config;
  if (effective.sandbox_mode != null || effective.sandbox_workspace_write != null) {
    throw new Error(
      "Codex effective config contains legacy sandbox settings; named permissions would not be authoritative",
    );
  }
  if (effective.default_permissions !== CODEX_PERMISSION_PROFILE) {
    throw new Error("Codex named permission profile is not effective");
  }
  if (effective.approvals_reviewer !== "user") throw new Error("Codex approvals are not routed to the user");
  if (effective.web_search !== "disabled") throw new Error("Codex web search is not disabled");
  const features = object(effective.features) ?? {};
  const forbiddenFeatures = [
    "apps", "multi_agent", "remote_plugin", "hooks", "goals", "memories", "web_search",
    "web_search_cached", "web_search_request", "skill_mcp_dependency_install",
  ] as const;
  for (const feature of forbiddenFeatures) assertFlag(features, feature, false);
  if (object(effective.agents)?.enabled !== false) throw new Error("Codex subagents are not disabled");
  if (object(effective.feedback)?.enabled !== false) throw new Error("Codex feedback networking is not disabled");
  const activeMcp = enabledEntries(effective.mcp_servers);
  if (activeMcp.length !== 1 || activeMcp[0] !== "figma-desktop") {
    throw new Error(`Codex effective config exposes unrelated MCP servers: ${activeMcp.join(", ") || "none"}`);
  }
  const mcp = object(object(effective.mcp_servers)?.["figma-desktop"]);
  if (mcp?.url !== FIGMA_MCP_URL) throw new Error("Codex Figma desktop MCP URL is not isolated to loopback");
  if (enabledEntries(effective.plugins).length) throw new Error("Codex effective config exposes inherited plugins");
  const apps = object(effective.apps) ?? {};
  const configuredApps = Object.fromEntries(Object.entries(apps).filter(([key]) => key !== "_default"));
  if (object(apps._default)?.enabled !== false || enabledEntries(configuredApps).length) {
    throw new Error("Codex effective config exposes inherited apps/connectors");
  }
  const profiles = object(effective.permissions);
  const profile = object(profiles?.[CODEX_PERMISSION_PROFILE]);
  const filesystem = object(profile?.filesystem);
  const expected: Record<string, unknown> = {
    ":minimal": "read",
    [args.policy.dir]: "read",
    [args.policy.notesDir]: "write",
  };
  if (args.policy.appRepo) expected[args.policy.appRepo] = "read";
  const filesystemMatches = filesystem && Object.keys(filesystem).length === Object.keys(expected).length
    && Object.entries(expected).every(([path, access]) => filesystem[path] === access);
  if (profile?.network == null || object(profile.network)?.enabled !== false || profile.workspace_roots != null
    || !filesystemMatches) {
    throw new Error("Codex effective permission profile differs from bridge-owned filesystem/network policy");
  }
}
